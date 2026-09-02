'use strict';
const express = require('express');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const { SNAP, LOG } = F;
const P = require('../lib/pipelines');
const normalize = require('../lib/normalize');
const geo = require('../lib/geo');
const cache = require('../lib/cache');

const router = express.Router();
const store = cache.create({ ttlMs: 60 * 1000, maxKeys: 12 });
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

const LOW_BATTERY = 20;
const STALE_MINUTES = 15;
const POOR_ACCURACY = 50;

/** hour buckets for short windows, day buckets for long ones */
function granularity(q, fallbackHours = 96) {
  if (F.str(q.granularity)) return F.str(q.granularity);
  const from = F.str(q.from) ? new Date(F.str(q.from)) : null;
  const to = F.str(q.to) ? new Date(F.str(q.to)) : new Date();
  const hours = from ? (to - from) / 3600000 : fallbackHours;
  if (hours <= 6) return 'minute15';
  if (hours <= 120) return 'hour';
  return 'day';
}

function truncExpr(unit, field = '$createdAt') {
  if (unit === 'minute15') return { $dateTrunc: { date: field, unit: 'minute', binSize: 15 } };
  if (unit === 'day') return { $dateTrunc: { date: field, unit: 'day' } };
  return { $dateTrunc: { date: field, unit: 'hour' } };
}

/**
 * Every number the Overview and Heartbeats pages draw.
 *
 * Extracted from the route handler so it can go through the cache: this walks
 * every heartbeat in range through several facets and took two to three seconds
 * on every filter click, warm or cold, which is most of what made the console
 * feel slow.
 */
async function buildStats(q) {
  const unit = granularity(q);
  const out = { generatedAt: new Date().toISOString(), granularity: unit, filtersApplied: describeFilters(q) };

  // ---------------------------------------------------------------- devices
  try {
    const { col, base } = await collectionFor('snapshots');
    const match = F.and([base, F.snapshotMatch(q)]);
    const postMatch = F.snapshotPostMatch(q);

    // KPIs are computed on the newest snapshot per user (the "current" view).
    const latest = await col
      .aggregate(
        P.latestPerUser({ match, postMatch, sort: { createdAt: -1 }, skip: 0, limit: 500 }),
        opts
      )
      .next();
    const rows = (latest.rows || []).map((doc) => {
      const row = normalize.snapshot(doc);
      row.agg = doc._agg || null;
      return row;
    });

    const accs = rows.map((r) => r.accuracy).filter((v) => v !== null);
    out.devices = {
      trackedUsers: rows.length,
      clockedIn: rows.filter((r) => r.clockedIn).length,
      clockedOut: rows.filter((r) => !r.clockedIn).length,
      insideGeofence: rows.filter((r) => r.isInsideGeofence === true).length,
      outsideGeofence: rows.filter((r) => r.isInsideGeofence === false).length,
      geofenceUnknown: rows.filter((r) => r.isInsideGeofence === null).length,
      insideAndClockedIn: rows.filter((r) => r.clockedIn && r.isInsideGeofence === true).length,
      outsideButClockedIn: rows.filter((r) => r.clockedIn && r.isInsideGeofence === false).length,
      offline: rows.filter((r) => r.offline).length,
      lowBattery: rows.filter((r) => r.battery !== null && r.battery <= LOW_BATTERY).length,
      stale: rows.filter((r) => r.ageMinutes !== null && r.ageMinutes > STALE_MINUTES).length,
      poorAccuracy: rows.filter((r) => r.accuracy !== null && r.accuracy > POOR_ACCURACY).length,
      noLocation: rows.filter((r) => !r.location).length,
      permissionGaps: rows.filter((r) => r.permissionsMissing.length > 0).length,
      locationBackgroundMissing: rows.filter((r) => !r.permissionsEnabled.includes('LOCATION_BACKGROUND')).length,
      facialPending: rows.filter((r) => r.facialVerification.pending).length,
      avgAccuracy: accs.length ? geo.round(accs.reduce((a, b) => a + b, 0) / accs.length, 1) : null,
      medianAccuracy: median(accs),
      worstAccuracy: accs.length ? geo.round(Math.max(...accs), 1) : null,
      ios: rows.filter((r) => r.deviceType === 'ios').length,
      android: rows.filter((r) => r.deviceType === 'android').length,
    };

    // Distributions and the timeline run over every matching snapshot.
    const facet = await col
      .aggregate(
        [
          { $match: match },
          { $addFields: P.computedFields },
          { $match: postMatch },
          {
            $facet: {
              total: [{ $count: 'value' }],
              accuracyBands: [{ $group: { _id: '$accuracyBand', n: { $sum: 1 } } }],
              accuracyHistogram: [
                {
                  $bucket: {
                    groupBy: '$' + SNAP.accuracy,
                    boundaries: [0, 5, 10, 20, 30, 50, 75, 100, 200, 500, 10000],
                    default: 'none',
                    output: { n: { $sum: 1 } },
                  },
                },
              ],
              geofence: [{ $group: { _id: '$isInsideGeofence', n: { $sum: 1 } } }],
              devices: [{ $group: { _id: '$deviceType', n: { $sum: 1 } } }],
              batteryBuckets: [
                {
                  $bucket: {
                    groupBy: '$batteryPercentage',
                    boundaries: [0, 10, 20, 40, 60, 80, 101],
                    default: 'none',
                    output: { n: { $sum: 1 } },
                  },
                },
              ],
              connectivity: [
                {
                  $group: {
                    _id: null,
                    online: { $sum: { $cond: [{ $eq: ['$isConnected', true] }, 1, 0] } },
                    offline: { $sum: { $cond: [{ $eq: ['$isConnected', false] }, 1, 0] } },
                    unreachable: { $sum: { $cond: [{ $eq: ['$isReachable', false] }, 1, 0] } },
                  },
                },
              ],
              topSites: [
                {
                  $group: {
                    _id: { $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt] },
                    n: { $sum: 1 },
                    inside: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', true] }, 1, 0] } },
                    outside: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', false] }, 1, 0] } },
                    avgAccuracy: { $avg: '$' + SNAP.accuracy },
                  },
                },
                { $sort: { n: -1 } },
                { $limit: 12 },
              ],
              perUser: [
                {
                  $group: {
                    _id: '$' + SNAP.userId,
                    name: { $last: '$' + SNAP.fullName },
                    n: { $sum: 1 },
                    inside: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', true] }, 1, 0] } },
                    outside: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', false] }, 1, 0] } },
                    offline: { $sum: { $cond: [{ $eq: ['$isConnected', false] }, 1, 0] } },
                    avgAccuracy: { $avg: '$' + SNAP.accuracy },
                    worstAccuracy: { $max: '$' + SNAP.accuracy },
                    minBattery: { $min: '$batteryPercentage' },
                    firstSeenAt: { $min: '$createdAt' },
                    lastSeenAt: { $max: '$createdAt' },
                  },
                },
                { $sort: { n: -1 } },
              ],
              permissions: [
                { $unwind: { path: '$permissionsEnabled', preserveNullAndEmptyArrays: false } },
                { $group: { _id: '$permissionsEnabled', n: { $sum: 1 } } },
              ],
              timeline: [
                {
                  $group: {
                    _id: truncExpr(unit),
                    n: { $sum: 1 },
                    inside: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', true] }, 1, 0] } },
                    outside: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', false] }, 1, 0] } },
                    unknown: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', null] }, 1, 0] } },
                    clockedIn: { $sum: { $cond: [{ $eq: ['$clockedIn', true] }, 1, 0] } },
                    offline: { $sum: { $cond: [{ $eq: ['$isConnected', false] }, 1, 0] } },
                    avgAccuracy: { $avg: '$' + SNAP.accuracy },
                    worstAccuracy: { $max: '$' + SNAP.accuracy },
                    users: { $addToSet: '$' + SNAP.userId },
                  },
                },
                { $sort: { _id: 1 } },
                { $limit: 800 },
              ],
            },
          },
        ],
        opts
      )
      .next();

    out.devices.totalSnapshots = (facet.total[0] || {}).value || 0;
    out.accuracyBands = keyed(facet.accuracyBands);
    out.accuracyHistogram = facet.accuracyHistogram.map((b) => ({ from: b._id, count: b.n }));
    out.geofenceSplit = {
      inside: pickCount(facet.geofence, true),
      outside: pickCount(facet.geofence, false),
      unknown: pickCount(facet.geofence, null),
    };
    out.deviceSplit = keyed(facet.devices);
    out.batteryBuckets = facet.batteryBuckets.map((b) => ({ from: b._id, count: b.n }));
    const conn = facet.connectivity[0] || {};
    out.connectivity = {
      online: conn.online || 0,
      offline: conn.offline || 0,
      unreachable: conn.unreachable || 0,
    };
    out.topSites = facet.topSites.map((s) => ({
      siteId: s._id,
      snapshots: s.n,
      inside: s.inside,
      outside: s.outside,
      avgAccuracy: geo.round(s.avgAccuracy, 1),
    }));
    out.perUser = facet.perUser.map((u) => ({
      userId: u._id,
      name: u.name || (u._id === null ? 'Unidentified device' : 'User ' + u._id),
      snapshots: u.n,
      inside: u.inside,
      outside: u.outside,
      offline: u.offline,
      avgAccuracy: geo.round(u.avgAccuracy, 1),
      worstAccuracy: geo.round(u.worstAccuracy, 1),
      minBattery: u.minBattery,
      firstSeenAt: u.firstSeenAt,
      lastSeenAt: u.lastSeenAt,
    }));
    out.permissionCounts = keyed(facet.permissions);
    out.timeline = facet.timeline.map((t) => ({
      at: t._id,
      count: t.n,
      inside: t.inside,
      outside: t.outside,
      unknown: t.unknown,
      clockedIn: t.clockedIn,
      offline: t.offline,
      avgAccuracy: geo.round(t.avgAccuracy, 1),
      worstAccuracy: geo.round(t.worstAccuracy, 1),
      users: (t.users || []).filter((u) => u !== null).length,
    }));
  } catch (err) {
    if (err.code !== 'COLLECTION_MISSING') throw err;
    out.devicesUnavailable = err.message;
  }

  // ------------------------------------------------------- geofence checks
  try {
    const { col } = await collectionFor('clockInLogs');
    const match = F.logMatch(q);
    const facet = await col
      .aggregate(
        [
          { $match: match },
          {
            $facet: {
              summary: [
                {
                  $group: {
                    _id: null,
                    total: { $sum: 1 },
                    within: { $sum: { $cond: [{ $eq: ['$' + LOG.within, true] }, 1, 0] } },
                    outside: { $sum: { $cond: [{ $eq: ['$' + LOG.within, false] }, 1, 0] } },
                    actualOutside: { $sum: { $cond: [{ $eq: ['$' + LOG.actual, false] }, 1, 0] } },
                    grace: {
                      $sum: {
                        $cond: [
                          { $and: [{ $eq: ['$' + LOG.within, true] }, { $eq: ['$' + LOG.actual, false] }] },
                          1,
                          0,
                        ],
                      },
                    },
                    clockOuts: { $sum: { $cond: [{ $eq: ['$' + LOG.clockOut, true] }, 1, 0] } },
                    unmapped: { $sum: { $cond: [{ $ne: ['$unmappedClockInData', null] }, 1, 0] } },
                    avgAccuracy: { $avg: '$' + LOG.accuracy },
                    worstAccuracy: { $max: '$' + LOG.accuracy },
                    bestAccuracy: { $min: '$' + LOG.accuracy },
                    avgPadding: {
                      $avg: { $subtract: ['$' + LOG.effectiveRadius, '$' + LOG.radius] },
                    },
                    maxOutsideCount: { $max: '$' + LOG.outsideCount },
                    users: { $addToSet: '$userId' },
                    sites: { $addToSet: '$' + LOG.siteId },
                  },
                },
              ],
              perSite: [
                {
                  $group: {
                    _id: '$' + LOG.siteId,
                    total: { $sum: 1 },
                    within: { $sum: { $cond: [{ $eq: ['$' + LOG.within, true] }, 1, 0] } },
                    actualOutside: { $sum: { $cond: [{ $eq: ['$' + LOG.actual, false] }, 1, 0] } },
                    clockOuts: { $sum: { $cond: [{ $eq: ['$' + LOG.clockOut, true] }, 1, 0] } },
                    avgAccuracy: { $avg: '$' + LOG.accuracy },
                    radius: { $last: '$' + LOG.radius },
                    address: { $last: '$' + LOG.address },
                  },
                },
                { $sort: { total: -1 } },
              ],
              timeline: [
                {
                  $group: {
                    _id: truncExpr(unit),
                    total: { $sum: 1 },
                    within: { $sum: { $cond: [{ $eq: ['$' + LOG.within, true] }, 1, 0] } },
                    outside: { $sum: { $cond: [{ $eq: ['$' + LOG.actual, false] }, 1, 0] } },
                    clockOuts: { $sum: { $cond: [{ $eq: ['$' + LOG.clockOut, true] }, 1, 0] } },
                    avgAccuracy: { $avg: '$' + LOG.accuracy },
                  },
                },
                { $sort: { _id: 1 } },
                { $limit: 800 },
              ],
            },
          },
        ],
        opts
      )
      .next();

    const s = facet.summary[0] || {};
    out.geofenceChecks = {
      total: s.total || 0,
      within: s.within || 0,
      outside: s.outside || 0,
      actualOutside: s.actualOutside || 0,
      grace: s.grace || 0,
      clockOuts: s.clockOuts || 0,
      unmapped: s.unmapped || 0,
      avgAccuracy: geo.round(s.avgAccuracy, 1),
      worstAccuracy: geo.round(s.worstAccuracy, 1),
      bestAccuracy: geo.round(s.bestAccuracy, 1),
      avgRadiusPadding: geo.round(s.avgPadding, 1),
      maxOutsideCount: s.maxOutsideCount ?? null,
      users: (s.users || []).filter((u) => u !== null).length,
      sites: (s.sites || []).filter((u) => u !== null).length,
      complianceRate: s.total ? geo.round((100 * (s.total - s.actualOutside)) / s.total, 1) : null,
    };
    out.geofencePerSite = facet.perSite.map((r) => ({
      siteId: r._id,
      total: r.total,
      within: r.within,
      actualOutside: r.actualOutside,
      clockOuts: r.clockOuts,
      avgAccuracy: geo.round(r.avgAccuracy, 1),
      radius: r.radius,
      address: r.address,
    }));
    out.geofenceTimeline = facet.timeline.map((t) => ({
      at: t._id,
      total: t.total,
      within: t.within,
      outside: t.outside,
      clockOuts: t.clockOuts,
      avgAccuracy: geo.round(t.avgAccuracy, 1),
    }));
  } catch (err) {
    if (err.code !== 'COLLECTION_MISSING') throw err;
    out.geofenceChecksUnavailable = err.message;
  }

  // --------------------------------------------------------- exit windows
  out.exitWindows = { available: false };
  try {
    const { col, base } = await collectionFor('exitWindows');
    const match = F.and([base, F.exitWindowMatch(q)]);
    const facet = await col
      .aggregate(
        [
          { $match: match },
          P.exitWindowStats(),
          { $match: F.exitWindowPostMatch(q) },
          {
            $facet: {
              summary: [
                {
                  $group: {
                    _id: null,
                    total: { $sum: 1 },
                    open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
                    resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
                    clockOuts: { $sum: { $cond: [{ $eq: ['$resolution', 'closed_clockout'] }, 1, 0] } },
                    returned: { $sum: { $cond: [{ $eq: ['$resolution', 'closed_returned'] }, 1, 0] } },
                    needsReview: { $sum: { $cond: [{ $eq: ['$resolution', 'needs_review'] }, 1, 0] } },
                    expired: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } },
                    avgDuration: { $avg: '$stats.durationMinutes' },
                    avgSamples: { $avg: '$stats.sampleCount' },
                    avgAccuracy: { $avg: '$stats.avgAccuracy' },
                    maxDistance: { $max: '$stats.maxDistanceFromBoundary' },
                    unknownSamples: { $sum: '$stats.verdicts.unknown' },
                    outSamples: { $sum: '$stats.verdicts.out' },
                    inSamples: { $sum: '$stats.verdicts.in' },
                    users: { $addToSet: '$userId' },
                  },
                },
              ],
              statuses: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
              resolutions: [{ $group: { _id: '$resolution', n: { $sum: 1 } } }],
              openedBy: [{ $group: { _id: '$openedBy', n: { $sum: 1 } } }],
              timeline: [
                {
                  $group: {
                    _id: truncExpr(unit, { $toDate: '$openedAt' }),
                    n: { $sum: 1 },
                    clockOuts: { $sum: { $cond: [{ $eq: ['$resolution', 'closed_clockout'] }, 1, 0] } },
                  },
                },
                { $sort: { _id: 1 } },
                { $limit: 800 },
              ],
            },
          },
        ],
        opts
      )
      .next();
    const s = facet.summary[0] || {};
    out.exitWindows = {
      available: true,
      total: s.total || 0,
      open: s.open || 0,
      resolved: s.resolved || 0,
      expired: s.expired || 0,
      returned: s.returned || 0,
      needsReview: s.needsReview || 0,
      clockOuts: s.clockOuts || 0,
      avgDurationMinutes: geo.round(s.avgDuration, 1),
      avgSamples: geo.round(s.avgSamples, 1),
      avgAccuracy: geo.round(s.avgAccuracy, 1),
      maxDistanceFromBoundary: geo.round(s.maxDistance, 1),
      samples: { in: s.inSamples || 0, out: s.outSamples || 0, unknown: s.unknownSamples || 0 },
      users: (s.users || []).filter((u) => u !== null).length,
      statuses: keyed(facet.statuses),
      resolutions: keyed(facet.resolutions),
      openedBy: keyed(facet.openedBy),
      timeline: facet.timeline.map((t) => ({ at: t._id, count: t.n, clockOuts: t.clockOuts })),
    };
  } catch (err) {
    if (err.code !== 'COLLECTION_MISSING') throw err;
  }

  out.perPerson = perPersonBasis(out);
  return out;
}

/**
 * How trustworthy the heartbeat-weighted figures on this page are.
 *
 * Every percentage elsewhere in this response counts heartbeats, and reporting
 * rates here differ by a factor of over two hundred. Two devices produce four
 * fifths of all heartbeats, so those percentages largely describe two phones.
 * `dominance` and `ratePerHour` say how bad the skew is for this filter, which
 * is what lets the page caveat its own numbers instead of implying they are
 * evenly sampled.
 *
 * Deliberately NOT here: a per-person "share of time inside the fence". A share
 * of one person’s heartbeats is still rate-biased whenever their reporting rate
 * changes with the thing being measured - which it does, sharply, for being
 * offline or outside a fence. Averaging those per person also weights somebody
 * with four minutes of data equally with somebody with a full day. /api/fence-time
 * answers that question properly by integrating time, and it is the only place
 * that should.
 *
 * accuracyMedian earns its place: it is a median over per-person averages, so
 * one chatty device cannot drag it, and GPS accuracy does not govern how often
 * a device reports.
 */
function perPersonBasis(out) {
  const people = (out.perUser || []).filter((u) => u.snapshots > 0);
  if (!people.length) return null;

  const rateOf = (u) => {
    if (!u.firstSeenAt || !u.lastSeenAt) return null;
    const hours = (new Date(u.lastSeenAt) - new Date(u.firstSeenAt)) / 3600000;
    return hours > 0 ? u.snapshots / hours : null;
  };

  const rates = people.map(rateOf).filter((v) => v !== null);
  const beats = people.map((u) => u.snapshots).sort((a, b) => b - a);
  const totalBeats = beats.reduce((a, b) => a + b, 0);
  // How much of the evidence comes from the two loudest devices. Above about
  // half, any heartbeat-weighted percentage is really about them.
  const topTwo = beats.slice(0, 2).reduce((a, b) => a + b, 0);

  return {
    people: people.length,
    accuracyMedian: median(people.map((u) => u.avgAccuracy).filter((v) => v !== null && v !== undefined)),
    ratePerHour: {
      median: rates.length ? median(rates) : null,
      slowest: rates.length ? geo.round(Math.min(...rates), 1) : null,
      fastest: rates.length ? geo.round(Math.max(...rates), 1) : null,
      // The factor between the chattiest and the quietest device.
      spread: rates.length && Math.min(...rates) > 0 ? geo.round(Math.max(...rates) / Math.min(...rates), 1) : null,
    },
    dominance: totalBeats > 0 ? topTwo / totalBeats : null,
    dominanceOf: Math.min(2, beats.length),
  };
}

router.get('/stats', async (req, res, next) => {
  try {
    res.json(await store.through(req.query, () => buildStats(req.query)));
  } catch (err) {
    next(err);
  }
});

function keyed(rows) {
  const out = {};
  for (const r of rows || []) out[r._id === null ? 'null' : String(r._id)] = r.n;
  return out;
}

function pickCount(rows, value) {
  const hit = (rows || []).find((r) => r._id === value);
  return hit ? hit.n : 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return geo.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, 1);
}

/** Echoes back which filters were understood, so the UI can show them. */
function describeFilters(q) {
  const keys = [
    'from', 'to', 'userId', 'tenantId', 'deviceType', 'appVersion', 'timezone', 'jobSiteId',
    'clockedIn', 'insideGeofence', 'connected', 'reachable', 'loggedIn', 'accuracyMin', 'accuracyMax',
    'accuracyBand', 'batteryMin', 'batteryMax', 'hasLocation', 'permissionMissing', 'permissionGranted',
    'search', 'where', 'status', 'resolution', 'openedBy', 'withinRadius', 'actualWithinRadius',
    'mismatch', 'unmapped', 'triggeredClockOut', 'outsideCountMin', 'staleMinutes', 'activeMinutes',
  ];
  const out = {};
  for (const k of keys) if (F.str(q[k]) !== null) out[k] = q[k];
  return out;
}

module.exports = router;
