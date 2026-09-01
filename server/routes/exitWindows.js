'use strict';
const express = require('express');
const { ObjectId } = require('mongodb');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const P = require('../lib/pipelines');
const normalize = require('../lib/normalize');
const csv = require('../lib/csv');
const { getSites, siteForFence, attachWindowSite, FENCE_MATCH_METRES } = require('../lib/sites');
const geo = require('../lib/geo');
const { attributeWindows } = require('../lib/attribution');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

const SORTABLE = ['openedAt', 'resolvedAt', 'pushedAt', 'userId', 'status', 'stats.sampleCount', 'stats.maxDistanceFromBoundary', 'stats.avgAccuracy', 'stats.durationMinutes'];

async function listWindows(q) {
  const { col, base } = await collectionFor('exitWindows');
  // These documents carry fence coordinates but no site id, so a site filter
  // becomes a bounding box around that site's recorded centre.
  const siteIds = F.nums(q.jobSiteId);
  let siteClause = null;
  if (siteIds.length) {
    const sites = await getSites();
    const boxes = sites
      .filter((s) => siteIds.includes(s.siteId) && s.lat != null && s.lng != null)
      .map((s) => {
        const dLat = FENCE_MATCH_METRES / 111320;
        const dLng = FENCE_MATCH_METRES / (111320 * Math.cos((s.lat * Math.PI) / 180));
        // Same rule as the label matcher: near the centre AND a compatible
        // radius, so a 20 m fence never absorbs a 100 m one at the same spot.
        const tolerance = s.radius == null ? null : Math.max(5, s.radius * 0.2);
        const box = {
          'fence.lat': { $gte: s.lat - dLat, $lte: s.lat + dLat },
          'fence.lng': { $gte: s.lng - dLng, $lte: s.lng + dLng },
        };
        if (tolerance !== null) {
          box.$or = [
            { 'fence.radius': { $gte: s.radius - tolerance, $lte: s.radius + tolerance } },
            { 'fence.radius': { $exists: false } },
            { 'fence.radius': null },
          ];
        }
        return { $or: [{ jobSiteId: s.siteId }, { 'fence.siteId': s.siteId }, box] };
      });
    // A site we know nothing about can match nothing.
    siteClause = boxes.length ? { $or: boxes } : { _id: null };
  }

  // userId is applied after attribution (see below), not in Mongo.
  const match = F.and([base, F.exitWindowMatch({ ...q, jobSiteId: undefined, userId: undefined }), siteClause]);
  const postMatch = F.exitWindowPostMatch(q);
  const { limit, page, skip } = F.pagination(q, 50, 500);
  const sort = F.sortSpec(q, SORTABLE, { openedAt: -1 });

  const result = await col
    .aggregate(
      [
        { $match: match },
        P.exitWindowStats(),
        { $match: postMatch },
        { $sort: sort },
        {
          $facet: {
            rows: [{ $skip: skip }, { $limit: limit }],
            total: [{ $count: 'value' }],
          },
        },
      ],
      opts
    )
    .next();

  let rows = (result.rows || []).map(normalize.exitWindow);
  const verdicts = F.list(q.verdict);
  if (verdicts.length) {
    rows = rows.filter((row) => row.samples.some((s) => verdicts.includes(s.verdict)));
  }
  rows = await Promise.all(rows.map(attachWindowSite));
  // Join to a person: exact when the document names one, inferred from
  // heartbeat presence at the fence otherwise.
  await attributeWindows(rows);

  // Filtering by user has to happen after attribution, since the documents
  // themselves carry userId: null.
  const wantedUsers = F.nums(q.userId);
  if (wantedUsers.length) {
    rows = rows.filter((r) => r.attribution && wantedUsers.includes(r.attribution.userId));
  }
  return { rows, total: (result.total[0] || {}).value || rows.length, page, limit };
}


router.get('/exit-windows', async (req, res, next) => {
  try {
    res.json(await listWindows(req.query));
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') {
      return res.json({ rows: [], total: 0, page: 1, limit: 0, unavailable: err.message });
    }
    next(err);
  }
});

router.get('/exit-windows/meta', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('exitWindows');
    const rows = await col
      .aggregate([{ $match: base }, { $group: { _id: null, statuses: { $addToSet: '$status' } } }], opts)
      .next();
    res.json({ available: true, sample: false, statuses: (rows && rows.statuses) || [] });
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') return res.json({ available: false, reason: err.message });
    next(err);
  }
});

router.get('/exit-windows.csv', async (req, res, next) => {
  try {
    const data = await listWindows({ ...req.query, limit: 500 });
    const text = csv.toCsv(data.rows, [
      { key: 'id', label: 'Window ID' },
      { key: 'userId', label: 'User ID (from the document)' },
      { key: 'attributedUserId', label: 'Attributed User ID', get: (r) => (r.attribution ? r.attribution.userId : null) },
      { key: 'attributedName', label: 'Attributed User', get: (r) => (r.attribution ? r.attribution.name : null) },
      { key: 'attributionMethod', label: 'Attribution', get: (r) => (r.attribution ? r.attribution.method : null) },
      { key: 'attributionConfidence', label: 'Attribution Confidence', get: (r) => (r.attribution ? r.attribution.confidence : null) },
      { key: 'attributionEvidence', label: 'Attribution Evidence', get: (r) => (r.attribution ? r.attribution.note : null) },
      { key: 'employeeRef', label: 'Employee' },
      { key: 'tenantId', label: 'Company' },
      { key: 'openedBy', label: 'Opened By' },
      { key: 'status', label: 'Status' },
      { key: 'resolution', label: 'Resolution' },
      { key: 'openedAt', label: 'Opened At (UTC)' },
      { key: 'expiresAt', label: 'Expires At (UTC)' },
      { key: 'resolvedAt', label: 'Resolved At (UTC)' },
      { key: 'stats.durationMinutes', label: 'Duration (min)', get: (r) => r.stats.durationMinutes },
      { key: 'stats.sampleCount', label: 'Samples', get: (r) => r.stats.sampleCount },
      { key: 'in', label: 'Samples In', get: (r) => r.stats.verdicts.in },
      { key: 'out', label: 'Samples Out', get: (r) => r.stats.verdicts.out },
      { key: 'unknown', label: 'Samples Unknown', get: (r) => r.stats.verdicts.unknown },
      { key: 'stats.avgAccuracy', label: 'Avg Accuracy (m)', get: (r) => r.stats.avgAccuracy },
      { key: 'stats.maxAccuracy', label: 'Worst Accuracy (m)', get: (r) => r.stats.maxAccuracy },
      { key: 'stats.maxDistanceFromBoundary', label: 'Max Distance Outside (m)', get: (r) => r.stats.maxDistanceFromBoundary },
      { key: 'stats.driftMetres', label: 'Total Drift (m)', get: (r) => r.stats.driftMetres },
      { key: 'site', label: 'Site (matched by fence centre)', get: (r) => (r.site ? r.site.siteId : null) },
      { key: 'siteAddress', label: 'Site Address' },
      { key: 'fence.lat', label: 'Fence Lat', get: (r) => (r.fence ? r.fence.lat : null) },
      { key: 'fence.lng', label: 'Fence Lng', get: (r) => (r.fence ? r.fence.lng : null) },
      { key: 'fence.radius', label: 'Fence Radius (m)', get: (r) => (r.fence ? r.fence.radius : null) },
      { key: 'battery', label: 'Battery %' },
      { key: 'permissionStatus', label: 'Permission Status' },
      { key: 'offline', label: 'Offline' },
      { key: 'timezone', label: 'Timezone' },
    ]);
    csv.send(res, 'phantom-exit-windows.csv', text);
  } catch (err) {
    next(err);
  }
});

router.get('/exit-windows/:id', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('exitWindows');
    const or = [{ id: req.params.id }];
    if (ObjectId.isValid(req.params.id)) or.push({ _id: new ObjectId(req.params.id) });
    const doc = await col.findOne(F.and([base, { $or: or }]));
    if (!doc) return res.status(404).json({ error: 'Exit window not found' });
    const row = await attachWindowSite(normalize.exitWindow(doc));
    await attributeWindows([row]);
    res.json({ row, raw: doc });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
