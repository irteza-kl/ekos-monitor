'use strict';
const express = require('express');
const issues = require('../lib/issues');
const csv = require('../lib/csv');

const router = express.Router();

/**
 * Detection costs a few seconds - it walks every heartbeat in range twice - and
 * the Overview page reloads it on every auto-refresh tick. A short cache keyed by
 * the query keeps the page responsive without letting the feed go stale enough to
 * matter; ?refresh=1 bypasses it.
 */
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_KEYS = 8;
const cache = new Map();

async function detectCached(query) {
  const key = JSON.stringify(query || {}, Object.keys(query || {}).sort());
  const hit = cache.get(key);
  if (query.refresh !== '1' && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await issues.detect(query);
  if (cache.size >= CACHE_MAX_KEYS) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), data });
  return data;
}

/**
 * What is wrong, ranked. Every other endpoint reports state; this one reports
 * problems, so the Overview page can lead with them instead of leaving them to
 * be inferred from a wall of counts.
 */
router.get('/issues', async (req, res, next) => {
  try {
    res.json(await detectCached(req.query));
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
