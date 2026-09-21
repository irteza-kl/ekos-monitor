'use strict';
const express = require('express');
const { ObjectId } = require('mongodb');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const normalize = require('../lib/normalize');
const csv = require('../lib/csv');
const { redact } = require('../lib/redact');
const { listTrail, summary, namesFor, attachSites } = require('../lib/shiftTrails');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

/**
 * A store with no trails in it yet is a normal state, not an error - the
 * writer ships on its own schedule. Every endpoint answers with an empty
 * result and the reason, so the page can explain itself instead of showing a
 * failure.
 */
function unavailable(err, res, body) {
  if (err.code !== 'COLLECTION_MISSING') return false;
  res.json({ ...body, unavailable: err.message });
  return true;
}

router.get('/shift-trails', async (req, res, next) => {
  try {
    res.json(await listTrail(req.query));
  } catch (err) {
    if (unavailable(err, res, { rows: [], total: 0, page: 1, limit: 0 })) return;
    next(err);
  }
});

router.get('/shift-trails/summary', async (req, res, next) => {
  try {
    res.json(await summary(req.query));
  } catch (err) {
    if (unavailable(err, res, { total: 0, users: 0, entries: 0, fixes: 0, runtimeStarts: 0, timeline: [] })) return;
    next(err);
  }
});

/** The filter dropdowns: shift-level values, and the entry values inside them. */
router.get('/shift-trails/meta', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('shiftTrails');
    const facet = await col
      .aggregate(
        [
          { $match: base },
          {
            $facet: {
              users: [{ $group: { _id: '$userId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              sites: [{ $group: { _id: '$siteId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              tenants: [{ $group: { _id: '$tenantId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              devices: [{ $group: { _id: '$deviceType', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              versions: [{ $group: { _id: '$applicationVersion', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              timezones: [{ $group: { _id: '$timezone', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              permissions: [
                { $unwind: '$entries' },
                { $group: { _id: '$entries.locationPermission', n: { $sum: 1 } } },
                { $sort: { n: -1 } },
              ],
              precisions: [
                { $unwind: '$entries' },
                { $group: { _id: '$entries.locationPrecision', n: { $sum: 1 } } },
                { $sort: { n: -1 } },
              ],
              kinds: [{ $unwind: '$entries' }, { $group: { _id: '$entries.kind', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
            },
          },
        ],
        opts
      )
      .next();

    const asList = (arr, keepNull) =>
      (arr || []).map((x) => ({ key: x._id, count: x.n })).filter((x) => keepNull || (x.key !== null && x.key !== undefined));
    const userIds = (facet.users || []).map((u) => u._id).filter((u) => u !== null && u !== undefined);
    const { names, seenInHeartbeats } = await namesFor(userIds);

    res.json({
      available: true,
      users: (facet.users || [])
        .filter((u) => u._id !== null && u._id !== undefined)
        .map((u) => ({ id: u._id, count: u.n, name: names.get(u._id) || null, heartbeatKnown: seenInHeartbeats.has(u._id) })),
      // Null is a value here: a shift with no site is an unmapped clock-in.
      sites: asList(facet.sites, true),
      tenants: asList(facet.tenants),
      devices: asList(facet.devices),
      versions: asList(facet.versions),
      timezones: asList(facet.timezones),
      permissions: asList(facet.permissions),
      // And "not reported" is what every iOS entry says for precision.
      precisions: asList(facet.precisions, true),
      entryKinds: asList(facet.kinds),
    });
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') {
      return res.json({ available: false, reason: err.message, users: [], sites: [], devices: [], versions: [], permissions: [], precisions: [], entryKinds: [] });
    }
    next(err);
  }
});

const CSV_COLUMNS = [
  { key: 'shiftKey', label: 'Shift Key' },
  { key: 'userId', label: 'User ID' },
  { key: 'name', label: 'User (named from heartbeats)' },
  { key: 'heartbeatKnown', label: 'Known To Heartbeats' },
  { key: 'tenantId', label: 'Tenant' },
  { key: 'siteId', label: 'Site ID' },
  { key: 'siteName', label: 'Site Name', get: (r) => (r.site ? r.site.displayName || r.site.name : null) },
  { key: 'clockIn', label: 'Clock In (UTC)' },
  { key: 'clockOut', label: 'Clock Out (UTC)' },
  { key: 'durationMinutes', label: 'Shift Duration (min)' },
  { key: 'sealedAt', label: 'Sealed At (UTC)' },
  { key: 'pushedAt', label: 'Pushed At (UTC)' },
  { key: 'sealLagSeconds', label: 'Seal Lag (s)' },
  { key: 'pushLagSeconds', label: 'Push Lag (s)' },
  { key: 'entries', label: 'Entries', get: (r) => r.stats.entryCount },
  { key: 'fixes', label: 'Fixes', get: (r) => r.stats.fixCount },
  { key: 'runtimeStarts', label: 'Restarts', get: (r) => r.stats.runtimeStartCount },
  { key: 'reportedRuntimeStarts', label: 'Restarts (app reported)', get: (r) => r.reported.runtimeStarts },
  { key: 'runtimeStartsDisagree', label: 'Restart Counts Disagree', get: (r) => r.stats.runtimeStartsDisagree },
  { key: 'serviceMissingOnRestart', label: 'Restarts With No Foreground Service', get: (r) => r.stats.serviceMissingOnRestart },
  { key: 'distinctRuns', label: 'Distinct Runs', get: (r) => r.stats.distinctRuns },
  { key: 'positionedMinutes', label: 'Positioned (min)', get: (r) => r.stats.positionedMinutes },
  { key: 'coverage', label: 'Coverage (%)', get: (r) => r.stats.coverage },
  { key: 'absenceCount', label: 'Absences' },
  { key: 'absentMinutes', label: 'Absent (min)' },
  { key: 'absencesWithRestart', label: 'Absences With A Restart' },
  { key: 'longestEntryGapMinutes', label: 'Longest Gap Between Entries (min)', get: (r) => r.stats.longestEntryGapMinutes },
  { key: 'travelledMetres', label: 'Travelled (m)', get: (r) => r.stats.travelledMetres },
  { key: 'largestStepMetres', label: 'Largest Step (m)', get: (r) => r.stats.largestStepMetres },
  { key: 'avgAccuracy', label: 'Avg Accuracy (m)', get: (r) => r.stats.avgAccuracy },
  { key: 'maxAccuracy', label: 'Worst Accuracy (m)', get: (r) => r.stats.maxAccuracy },
  { key: 'coarseFixes', label: 'Coarse Fixes', get: (r) => r.stats.coarseFixes },
  { key: 'worstPermission', label: 'Worst Location Permission', get: (r) => r.stats.worstPermission },
  { key: 'permissionChanged', label: 'Permission Changed Mid-Shift', get: (r) => r.stats.permissionChanged },
  { key: 'batteryStart', label: 'Battery Start (%)', get: (r) => r.stats.batteryStart },
  { key: 'batteryEnd', label: 'Battery End (%)', get: (r) => r.stats.batteryEnd },
  { key: 'batteryDrop', label: 'Battery Drop (%)', get: (r) => r.stats.batteryDrop },
  { key: 'fenceInside', label: 'Fixes Inside Fence', get: (r) => (r.fence ? r.fence.inside : null) },
  { key: 'fenceOutside', label: 'Fixes Outside Fence', get: (r) => (r.fence ? r.fence.outside : null) },
  { key: 'fenceFurthest', label: 'Furthest Outside Fence (m)', get: (r) => (r.fence ? r.fence.furthestOutside : null) },
  { key: 'deviceType', label: 'Device' },
  { key: 'appVersion', label: 'App Version' },
  { key: 'buildVersion', label: 'Build' },
  { key: 'timezone', label: 'Timezone' },
  { key: 'id', label: 'Document ID' },
];

router.get('/shift-trails.csv', async (req, res, next) => {
  try {
    const data = await listTrail({ ...req.query, limit: 500 });
    csv.send(res, 'phantom-shift-trails.csv', csv.toCsv(data.rows, CSV_COLUMNS));
  } catch (err) {
    // An empty export still carries its header row, rather than handing back a
    // JSON error where the button asked for a file.
    if (err.code === 'COLLECTION_MISSING') {
      return csv.send(res, 'phantom-shift-trails.csv', csv.toCsv([], CSV_COLUMNS));
    }
    next(err);
  }
});

router.get('/shift-trails/:id', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('shiftTrails');
    const or = [];
    if (ObjectId.isValid(req.params.id)) or.push({ _id: new ObjectId(req.params.id) });
    // A shift is also findable by the key the app knows it as, which is what
    // anybody chasing one from the app's own logs will be holding.
    or.push({ shiftKey: String(req.params.id) });
    const doc = await col.findOne(F.and([base, { $or: or }]));
    if (!doc) return res.status(404).json({ error: 'Shift trail not found' });

    const row = normalize.shiftTrail(doc);
    await attachSites([row]);
    const { names, seenInHeartbeats } = await namesFor([row.userId]);
    row.name = names.get(row.userId) || null;
    row.heartbeatKnown = seenInHeartbeats.has(row.userId);

    res.json({ row, raw: redact(doc) });
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') return res.status(404).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
