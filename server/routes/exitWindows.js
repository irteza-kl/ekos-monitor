'use strict';
const express = require('express');
const { ObjectId } = require('mongodb');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const normalize = require('../lib/normalize');
const csv = require('../lib/csv');
const { attachWindowSite } = require('../lib/sites');
const { redact } = require('../lib/redact');
const { attributeWindows } = require('../lib/attribution');
// The list query is shared with the Exit windows tab on a user page, so it
// lives in lib and neither caller owns it. See lib/exitWindows.js.
const { listWindows } = require('../lib/exitWindows');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

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
    res.json({ row, raw: redact(doc) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
