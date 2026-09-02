'use strict';
const express = require('express');
const issues = require('../lib/issues');
const cache = require('../lib/cache');
const csv = require('../lib/csv');

const router = express.Router();

/**
 * Detection costs a few seconds - it walks every heartbeat in range twice - and
 * the Overview page reloads it on every auto-refresh tick, so it goes through the
 * shared short-lived cache; ?refresh=1 bypasses it.
 */
const store = cache.create({ ttlMs: 60 * 1000, maxKeys: 12 });

const detectCached = (query) => store.through(query, () => issues.detect(query));

/**
 * The window immediately before the one being asked about, same length.
 *
 * A count on its own does not say whether anything is getting worse, which is
 * most of what a monitor is for. The filter bar resolves its presets to an
 * explicit `from`, so the length is known and the period before it is the
 * natural baseline.
 *
 * Returns null for an unbounded range: with no start there is no previous
 * period, and inventing one would be worse than showing no comparison.
 *
 * The open end is rounded down to the minute. Taken raw it moves every
 * millisecond, which gave every request a slightly different baseline window:
 * the comparison never hit the cache, and the number it produced drifted
 * between two refreshes of the same page.
 */
const BASELINE_GRANULARITY_MS = 60 * 1000;

function previousWindow(query) {
  const from = query.from ? new Date(query.from).getTime() : null;
  if (from === null || Number.isNaN(from)) return null;
  const to = query.to
    ? new Date(query.to).getTime()
    : Math.floor(Date.now() / BASELINE_GRANULARITY_MS) * BASELINE_GRANULARITY_MS;
  if (Number.isNaN(to) || to <= from) return null;
  const length = to - from;
  return { from: new Date(from - length).toISOString(), to: new Date(from).toISOString() };
}

/** Same filters, shifted back one window, with the comparison flag dropped. */
function shiftQuery(query, window) {
  const shifted = { ...query, from: window.from, to: window.to };
  delete shifted.compare;
  delete shifted.refresh;
  return shifted;
}

/**
 * Adds "and how does that compare with before?" to a detection result.
 *
 * The baseline runs through the same cache, so flipping between filters costs
 * one extra aggregation the first time and nothing after that. A failure to
 * build it is not a failure of the endpoint: the current picture is still worth
 * showing, so the comparison is simply reported as unavailable.
 */
async function withComparison(data, query) {
  const window = previousWindow(query);
  if (!window) return { ...data, previous: null, previousUnavailable: 'no start date to compare against' };
  let before;
  try {
    before = await detectCached(shiftQuery(query, window));
  } catch (err) {
    return { ...data, previous: null, previousUnavailable: err.message };
  }
  const wasCounted = new Map(before.issues.map((i) => [i.id, i.count]));
  return {
    ...data,
    // Each issue carries what it was last period, so a row can say "up from 6"
    // instead of leaving the reader to remember yesterday.
    issues: data.issues.map((i) => ({
      ...i,
      previousCount: wasCounted.has(i.id) ? wasCounted.get(i.id) : 0,
      isNew: !wasCounted.has(i.id),
    })),
    previous: {
      from: window.from,
      to: window.to,
      counts: before.counts,
      // Issues that were there last period and have since cleared.
      resolved: before.issues
        .filter((i) => !data.issues.some((c) => c.id === i.id))
        .map((i) => ({ id: i.id, title: i.title, severity: i.severity, count: i.count })),
    },
  };
}

/**
 * What is wrong, ranked. Every other endpoint reports state; this one reports
 * problems, so the Overview page can lead with them instead of leaving them to
 * be inferred from a wall of counts.
 */
router.get('/issues', async (req, res, next) => {
  try {
    const data = await detectCached(req.query);
    res.json(req.query.compare === '1' ? await withComparison(data, req.query) : data);
  } catch (err) {
    next(err);
  }
});

router.get('/issues.csv', async (req, res, next) => {
  try {
    const found = await detectCached(req.query);
    const rows = found.issues.map((i) => ({
      severity: i.severity,
      group: i.group,
      id: i.id,
      title: i.title,
      count: i.count,
      unit: i.unit,
      affected: i.who.map((w) => w.name + (w.note ? ' (' + w.note + ')' : '')).join('; '),
      affectedTotal: i.whoTotal,
      lastAt: i.lastAt,
      detail: i.detail,
      evidence: i.evidence,
    }));
    const text = csv.toCsv(rows, [
      { key: 'severity', label: 'Severity' },
      { key: 'group', label: 'Group' },
      { key: 'id', label: 'Issue' },
      { key: 'title', label: 'Title' },
      { key: 'count', label: 'Count' },
      { key: 'unit', label: 'Unit' },
      { key: 'affectedTotal', label: 'Affected' },
      { key: 'affected', label: 'Who' },
      { key: 'lastAt', label: 'Last Seen (UTC)' },
      { key: 'detail', label: 'Detail' },
      { key: 'evidence', label: 'Evidence' },
    ]);
    csv.send(res, 'phantom-issues.csv', text);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
