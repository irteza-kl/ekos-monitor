'use strict';
const { collectionFor } = require('../db');
const config = require('../config');
const F = require('./filters');
const memo = require('./cache');
const { SNAP } = F;

/**
 * Time on site: how long people were actually inside a geofence.
 *
 * Everything else in this console counts heartbeats, and heartbeat rates here
 * differ by a factor of seventy - one device lands one a second, another one
 * every five minutes. So "43% of heartbeats were inside the fence" describes
 * who reports most often, not who was on site. Two devices alone produce 82% of
 * all heartbeats, which means every fleet-wide percentage is mostly them.
 *
 * THE MEASURE (rate-independent, and the number to trust)
 *
 * Time is integrated by state rather than sampled: the interval between two
 * consecutive heartbeats is credited to the state the earlier one reported. A
 * device reporting every second and one reporting every five minutes then give
 * the same answer for the same shift, which is the whole point.
 *
 * Each interval is capped at CAP_MS. Past that the device was silent and its
 * state is unknown, so the time is dropped rather than credited, and reported
 * separately as `silentMs` - the span nobody knew where that person was, which
 * is a finding in its own right.
 *
 * Validated against the two dense reporters, whose beat-share is necessarily
 * close to the truth: integration gives 47% where counting gives 51%. For a
 * device whose reporting rate itself changes with state the two diverge by
 * nearly twenty points, and integration is the correct one.
 *
 * THE BOUNDARIES (precise, but only where the device sends them)
 *
 * `geofenceIn` and `geofenceOut` carry the moment of each crossing. They give
 * exact visit boundaries and counts, and two things to know about them:
 *
 *  - They are transient MARKERS, not state. Most heartbeats carry neither even
 *    while `isInsideGeofence` is true, so the crossings are collected as a set
 *    of events and paired on their own timeline, ignoring which heartbeat
 *    happened to mention them.
 *
 *  - Coverage is wildly uneven. One device emitted two crossings in 41 hours
 *    while another emitted forty in one day, so visit counts are a FLOOR, never
 *    a total. `eventCoverage` says how much to trust them per person, and no
 *    share or percentage is ever derived from them.
 *
 * They are also ISO-8601 strings, not dates: lexical order is chronological, so
 * they sort and compare as-is, but arithmetic needs a conversion.
 */

const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

/**
 * Longest interval between heartbeats that still counts as continuous
 * observation. Matches the staleness threshold the rest of the console uses, so
 * "stale" means the same thing on every page.
 */
const CAP_MS = 15 * 60 * 1000;

/** Below this, a crossing pair is fence jitter rather than a visit. */
const JITTER_MS = 60 * 1000;


/**
 * Both halves of the answer in one pass over the collection.
 *
 * The dwell branch needs a partition sort, which $setWindowFields does in
 * memory against a hard 32 MB budget on this deployment - allowDiskUse is not
 * honoured here - so that branch re-projects down to four fields before the
 * sort while the other branch keeps the wider set it needs. Running them as
 * $facet branches rather than two aggregations halves the read work, which is
 * what the cold path actually pays for.
 */
async function loadFence(query) {
  const { col, base } = await collectionFor('snapshots');
  const match = F.and([base, F.snapshotMatch(query)]);

  const facet = await col
    .aggregate(
      [
        { $match: match },
        {
          $project: {
            _id: 0,
            createdAt: 1,
            _u: '$' + SNAP.userId,
            _in: '$isInsideGeofence',
            _clocked: '$clockedIn',
            _name: '$' + SNAP.fullName,
            _tz: '$timezone',
            _gin: '$geofenceIn',
            _gout: '$geofenceOut',
            _site: { $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt] },
          },
        },
        { $match: { _u: { $ne: null } } },
        {
          $facet: {
            // Time per state, by integration.
            dwell: [
              // Narrow again before the partition sort - this is the budget.
              { $project: { createdAt: 1, _u: 1, _in: 1, _clocked: 1 } },
              {
                $setWindowFields: {
                  partitionBy: '$_u',
                  sortBy: { createdAt: 1 },
                  output: { _nextAt: { $shift: { output: '$createdAt', by: 1 } } },
                },
              },
              { $addFields: { _rawMs: { $subtract: ['$_nextAt', '$createdAt'] } } },
              // The last heartbeat of a partition has nothing to measure against.
              { $match: { _rawMs: { $ne: null } } },
              { $addFields: { _ms: { $min: ['$_rawMs', CAP_MS] } } },
              {
                $group: {
                  _id: { user: '$_u', inside: '$_in' },
                  // Capped time is what was observed; the difference from raw
                  // time is silence, reported rather than quietly credited.
                  ms: { $sum: '$_ms' },
                  rawMs: { $sum: '$_rawMs' },
                  onClockMs: { $sum: { $cond: [{ $eq: ['$_clocked', true] }, '$_ms', 0] } },
                },
              },
            ],
            // Crossing events, the watched span, and what the newest heartbeat
            // claims. Crossing markers are rare, so collecting them as sets
            // costs little and saves two more passes.
            observed: [
              {
                $group: {
                  _id: '$_u',
                  name: { $max: '$_name' },
                  timezone: { $max: '$_tz' },
                  beats: { $sum: 1 },
                  firstBeatAt: { $min: '$createdAt' },
                  lastBeatAt: { $max: '$createdAt' },
                  insideBeats: { $sum: { $cond: [{ $eq: ['$_in', true] }, 1, 0] } },
                  clockedBeats: { $sum: { $cond: [{ $eq: ['$_clocked', true] }, 1, 0] } },
                  entries: {
                    $addToSet: {
                      $cond: [
                        { $ne: ['$_gin', null] },
                        { at: '$_gin', site: '$_site', onClock: '$_clocked' },
                        '$$REMOVE',
                      ],
                    },
                  },
                  exits: { $addToSet: { $cond: [{ $ne: ['$_gout', null] }, '$_gout', '$$REMOVE'] } },
                  // Decides "inside right now": the event stream alone cannot
                  // tell a missing exit from a visit still in progress.
                  latest: {
                    $top: {
                      sortBy: { createdAt: -1 },
                      output: { inside: '$_in', at: '$createdAt', out: '$_gout', clockedIn: '$_clocked' },
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      opts
    )
    .next();

  return { dwell: (facet && facet.dwell) || [], observed: (facet && facet.observed) || [] };
}

function ms(value) {
  if (value === null || value === undefined || value === '') return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Milliseconds of [aStart, aEnd] that fall inside [bStart, bEnd]. */
function overlapMs(aStart, aEnd, bStart, bEnd) {
  const start = bStart === null ? aStart : Math.max(aStart, bStart);
  const end = bEnd === null ? aEnd : Math.min(aEnd, bEnd);
  return end > start ? end - start : 0;
}

/**
 * Pairs one person's crossing events into visits.
 *
 * An entry followed by another entry means the exit was never sent; the visit
 * is closed at the second entry, because re-entering means they had left. Rows
 * whose end was reasoned about rather than recorded are marked `endInferred` so
 * nothing presents a guess as a measurement.
 */
function pairVisits(events, state) {
  const ordered = events.slice().sort((a, b) => a.at - b.at || (a.kind === 'in' ? -1 : 1));
  const visits = [];
  let open = null;

  const close = (entry, endedAt, endInferred, isOpen) => {
    visits.push({
      enteredAt: entry.at,
      endedAt,
      endInferred,
      open: isOpen,
      siteId: entry.siteId,
      onClock: entry.onClock,
    });
  };

  for (const e of ordered) {
    if (e.kind === 'in') {
      if (open) close(open, e.at, true, false);
      open = e;
      continue;
    }
    if (open) {
      close(open, e.at, false, false);
      open = null;
    }
    // An exit with no entry belongs to a visit that began before the window;
    // there is no start for it, so it contributes no measurable time.
  }

  if (open) {
    // Still inside, or an exit that never arrived. Credited only to the last
    // heartbeat: past that, being on site is an assumption.
    const endedAt = state.lastBeatAt === null ? open.at : Math.max(open.at, state.lastBeatAt);
    close(open, endedAt, true, state.insideNow === true);
  }

  return visits;
}

/**
 * @param {object} query the usual filter query-string object
 * @returns {Promise<{perUser: Array, totals: object, visits: Array, openVisits: Array}>}
 */
async function fenceTime(query = {}) {
  const [dwell, observed] = await loadFence(query).then((r) => [r.dwell, r.observed]);

  const windowFrom = ms(query.from);
  const windowTo = ms(query.to);
  const now = Date.now();

  const blank = (userId) => ({
    userId,
    name: null,
    timezone: null,
    beats: 0,
    insideBeats: 0,
    clockedBeats: 0,
    firstBeatAt: null,
    lastBeatAt: null,
    insideNow: false,
    latestAt: null,
    latestOnClock: false,
    insideMs: 0,
    outsideMs: 0,
    unknownMs: 0,
    rawMs: 0,
    onClockMs: 0,
    events: [],
  });

  const byUser = new Map();
  const bucket = (userId) => {
    let u = byUser.get(userId);
    if (!u) {
      u = blank(userId);
      byUser.set(userId, u);
    }
    return u;
  };

  for (const o of observed) {
    const u = bucket(o._id);
    const latest = o.latest || {};
    u.name = o.name || null;
    u.timezone = o.timezone || null;
    u.beats = o.beats || 0;
    u.insideBeats = o.insideBeats || 0;
    u.clockedBeats = o.clockedBeats || 0;
    u.firstBeatAt = ms(o.firstBeatAt);
    u.lastBeatAt = ms(o.lastBeatAt);
    u.insideNow = latest.inside === true;
    u.latestAt = ms(latest.at);
    u.latestOnClock = latest.clockedIn === true;

    // One instant is one crossing. The set can carry it more than once when the
    // site id or clock flag differed across the heartbeats that mentioned it.
    const entriesAt = new Map();
    for (const e of o.entries || []) {
      const at = ms(e && e.at);
      if (at === null) continue;
      const held = entriesAt.get(at);
      if (!held) {
        entriesAt.set(at, { at, kind: 'in', siteId: e.site === undefined ? null : e.site, onClock: e.onClock === true });
        continue;
      }
      if (held.siteId === null && e.site !== undefined && e.site !== null) held.siteId = e.site;
      if (e.onClock === true) held.onClock = true;
    }
    u.events.push(...entriesAt.values());

    const exitsAt = new Set();
    for (const x of o.exits || []) {
      const at = ms(x);
      if (at !== null) exitsAt.add(at);
    }
    for (const at of exitsAt) u.events.push({ at, kind: 'out', siteId: null, onClock: false });
  }

  for (const d of dwell) {
    const u = bucket(d._id.user);
    const key = d._id.inside === true ? 'insideMs' : d._id.inside === false ? 'outsideMs' : 'unknownMs';
    u[key] += d.ms || 0;
    u.rawMs += d.rawMs || 0;
    u.onClockMs += d.onClockMs || 0;
  }



  const visits = [];
  const perUser = [];

  for (const u of byUser.values()) {
    const paired = pairVisits(u.events, { lastBeatAt: u.lastBeatAt, insideNow: u.insideNow });
    // Entered and never left: the newest heartbeat still says inside, an entry
    // was recorded, and no exit ever was. A device that sends no markers at
    // all is a different case and must not land here.
    const entryEvents = u.events.filter((e) => e.kind === 'in');
    const exitEvents = u.events.filter((e) => e.kind === 'out');
    const neverExited = u.insideNow && entryEvents.length > 0 && exitEvents.length === 0;
    const lastEntryAt = entryEvents.reduce((a, e) => (a === null || e.at > a ? e.at : a), null);
    const countFrom = windowFrom === null ? u.firstBeatAt : windowFrom;
    const countTo = windowTo === null ? u.lastBeatAt : windowTo;

    let closedVisits = 0;
    let jitterVisits = 0;
    let longestVisitMs = 0;

    for (const v of paired) {
      const durationMs = Math.max(0, v.endedAt - v.enteredAt);
      if (!v.endInferred) closedVisits += 1;
      if (durationMs < JITTER_MS) jitterVisits += 1;
      if (durationMs > longestVisitMs) longestVisitMs = durationMs;
      visits.push({
        userId: u.userId,
        name: u.name || 'user ' + u.userId,
        timezone: u.timezone,
        siteId: v.siteId,
        enteredAt: new Date(v.enteredAt).toISOString(),
        exitedAt: v.endInferred ? null : new Date(v.endedAt).toISOString(),
        endInferred: v.endInferred,
        open: v.open,
        onClock: v.onClock,
        durationMs,
        inWindowMs: overlapMs(v.enteredAt, v.endedAt, countFrom, countTo),
        jitter: durationMs < JITTER_MS,
        ageMs: v.open ? now - v.enteredAt : null,
      });
    }

    const measuredMs = u.insideMs + u.outsideMs + u.unknownMs;
    const knownMs = u.insideMs + u.outsideMs;
    // First-to-last heartbeat, clipped to the window: the span there is any
    // evidence for, which is the honest denominator for a reporting rate.
    const observedMs =
      u.firstBeatAt === null || u.lastBeatAt === null
        ? 0
        : overlapMs(u.firstBeatAt, u.lastBeatAt, windowFrom, windowTo);
    // Time between heartbeats that was too long to credit to any state.
    const silentMs = Math.max(0, u.rawMs - measuredMs);

    perUser.push({
      userId: u.userId,
      name: u.name || (u.userId === null ? 'no session' : 'user ' + u.userId),
      timezone: u.timezone,
      beats: u.beats,
      // Makes the sampling bias visible, and is the baseline a per-device
      // silence threshold needs. Measured over the whole watched span, not
      // just the part credited to a state - silence still took real time.
      beatsPerHour: observedMs > 0 ? Math.round((u.beats / (observedMs / 3600000)) * 10) / 10 : null,
      observedMs,
      // How much of the watched span we can actually account for. A share
      // drawn from 12% of a shift deserves a caveat, and this is it.
      accountedShare: observedMs > 0 ? Math.min(1, measuredMs / observedMs) : null,

      insideMs: u.insideMs,
      outsideMs: u.outsideMs,
      // The device reported no fence verdict at all for this long.
      unknownMs: u.unknownMs,
      measuredMs,
      silentMs,
      onClockMs: u.onClockMs,
      // Share of the time we could actually account for. Unknown time is
      // excluded from the denominator rather than counted as "outside".
      insideShare: knownMs > 0 ? u.insideMs / knownMs : null,
      // The heartbeat-weighted version of the same thing, kept alongside so the
      // two can be compared instead of silently swapped.
      insideShareByBeats: u.beats > 0 ? u.insideBeats / u.beats : null,

      visits: paired.length,
      closedVisits,
      jitterVisits,
      longestVisitMs,
      // How far the crossing markers can be trusted for this person: 'none' when
      // the device sent no crossings at all, 'sparse' when it sent so few that
      // the visit count is clearly a floor.
      eventCoverage: coverageOf(paired.length, measuredMs),

      insideNow: u.insideNow,
      neverExited,
      // How long that unresolved entry has been standing.
      neverExitedForMs: neverExited && lastEntryAt !== null ? now - lastEntryAt : null,
      latestAt: u.latestAt === null ? null : new Date(u.latestAt).toISOString(),
      latestOnClock: u.latestOnClock,
      onClock: u.clockedBeats > 0,
    });
  }

  perUser.sort((a, b) => b.insideMs - a.insideMs);

  const sum = (key) => perUser.reduce((a, u) => a + (u[key] || 0), 0);
  const totalInside = sum('insideMs');
  const totalOutside = sum('outsideMs');
  const totalKnown = totalInside + totalOutside;
  const totalBeats = sum('beats');
  const totalInsideBeats = perUser.reduce((a, u) => a + (u.insideShareByBeats || 0) * u.beats, 0);
  // A plain average over people counts someone with four minutes of data the
  // same as someone with a full day, which pulled this ten points high. Only
  // people with a real span measured are averaged, and the rest are counted.
  const MIN_FOR_AVERAGE_MS = 60 * 60 * 1000;
  const withShare = perUser.filter((u) => u.insideShare !== null && u.measuredMs >= MIN_FOR_AVERAGE_MS);
  const tooThinToAverage = perUser.filter((u) => u.insideShare !== null && u.measuredMs < MIN_FOR_AVERAGE_MS).length;

  return {
    generatedAt: new Date().toISOString(),
    perUser,
    visits: visits.sort((a, b) => (a.enteredAt < b.enteredAt ? 1 : -1)),
    openVisits: visits.filter((v) => v.open),
    totals: {
      people: perUser.length,
      insideMs: totalInside,
      outsideMs: totalOutside,
      unknownMs: sum('unknownMs'),
      measuredMs: sum('measuredMs'),
      silentMs: sum('silentMs'),
      visits: visits.length,
      jitterVisits: visits.filter((v) => v.jitter).length,
      // Named rather than numbered, because these answer "how much of the time
      // was spent on site" differently and the gap between them is the point.
      // byTime is the one to show; byBeats is what the console used to imply.
      insideShareByTime: totalKnown > 0 ? totalInside / totalKnown : null,
      insideShareByPerson: withShare.length ? withShare.reduce((a, u) => a + u.insideShare, 0) / withShare.length : null,
      insideShareByPersonOf: withShare.length,
      insideShareByPersonExcluded: tooThinToAverage,
      insideShareByBeats: totalBeats > 0 ? totalInsideBeats / totalBeats : null,
      insideNow: perUser.filter((u) => u.insideNow).length,
      neverExited: perUser.filter((u) => u.neverExited).length,
    },
  };
}

/** @returns {'none'|'sparse'|'ok'} how far the crossing markers can be trusted. */
function coverageOf(visitCount, measuredMs) {
  if (!visitCount) return 'none';
  const hours = measuredMs / 3600000;
  // Under one crossing per eight hours watched, the count is clearly a floor
  // rather than a total.
  if (hours >= 8 && visitCount / (hours / 8) < 1) return 'sparse';
  return 'ok';
}

/**
 * Shared by /api/fence-time and the issue detectors, so asking both questions
 * in one page load costs one partition sort rather than two.
 */
const store = memo.create({ ttlMs: 60 * 1000, maxKeys: 8 });
const fenceTimeCached = (query = {}) => store.through(query, () => fenceTime(query));

module.exports = { fenceTime, fenceTimeCached, pairVisits, CAP_MS, JITTER_MS };
