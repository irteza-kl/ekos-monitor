'use strict';
const express = require('express');
const { ObjectId } = require('mongodb');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const { LOG } = F;
const normalize = require('../lib/normalize');
const csv = require('../lib/csv');
const { siteLookup } = require('../lib/sites');
const { redact } = require('../lib/redact');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

const SORTABLE = ['createdAt', 'userId', 'requestBody.accuracy', 'response.outsideCount', 'siteAreaData.siteArea.id'];

async function listLogs(q) {
  const { col } = await collectionFor('clockInLogs');
  const match = F.logMatch(q);
  const { limit, page, skip } = F.pagination(q, 100, 2000);
  const sort = F.sortSpec(q, SORTABLE, { createdAt: -1 });

  const [docs, total, lookup] = await Promise.all([
    col.find(match).sort(sort).skip(skip).limit(limit).maxTimeMS(config.queryTimeoutMs).toArray(),
    col.countDocuments(match, { maxTimeMS: config.queryTimeoutMs }),
    siteLookup(),
  ]);

  let rows = docs.map((d) => normalize.clockInLog(d, lookup));

  // Recomputed-verdict filters can only be applied once geometry is known.
  const verdicts = F.list(q.verdict);
  if (verdicts.length) rows = rows.filter((r) => verdicts.includes(r.verdict));
  const bands = F.list(q.accuracyBand);
  if (bands.length) rows = rows.filter((r) => bands.includes(r.accuracyBand));

  return { rows, total, page, limit, matched: rows.length };
}

router.get('/logs', async (req, res, next) => {
  try {
    res.json(await listLogs(req.query));
  } catch (err) {
    next(err);
  }
});

router.get('/logs.csv', async (req, res, next) => {
  try {
    const data = await listLogs({ ...req.query, limit: 2000 });
    const text = csv.toCsv(data.rows, [
      { key: 'capturedAt', label: 'Logged At (UTC)' },
      { key: 'deviceTimestamp', label: 'Device Timestamp' },
      { key: 'userId', label: 'User ID' },
      { key: 'siteId', label: 'Site ID' },
      { key: 'siteAddress', label: 'Site Address' },
      { key: 'location.lat', label: 'Latitude', get: (r) => (r.location ? r.location.lat : null) },
      { key: 'location.lng', label: 'Longitude', get: (r) => (r.location ? r.location.lng : null) },
      { key: 'accuracy', label: 'Accuracy (m)' },
      { key: 'accuracyBand', label: 'Accuracy Band' },
      { key: 'fence.radius', label: 'Fence Radius (m)', get: (r) => (r.fence ? r.fence.radius : null) },
      { key: 'effectiveRadius', label: 'Effective Radius (m)' },
      { key: 'radiusPadding', label: 'Accuracy Padding (m)' },
      { key: 'relation.distanceFromCenter', label: 'Distance From Centre (m)', get: (r) => (r.relation ? r.relation.distanceFromCenter : null) },
      { key: 'relation.distanceFromBoundary', label: 'Distance From Boundary (m)', get: (r) => (r.relation ? r.relation.distanceFromBoundary : null) },
      { key: 'isWithinRadius', label: 'Within Radius (reported)' },
      { key: 'actualIsWithinRadius', label: 'Within Radius (actual)' },
      { key: 'graceApplied', label: 'Accuracy Grace Applied' },
      { key: 'verdict', label: 'Verdict (recomputed)' },
      { key: 'outsideCount', label: 'Consecutive Outside' },
      { key: 'triggeredClockOut', label: 'Triggered Clock-Out' },
      { key: 'unmapped', label: 'Unmapped Clock-In' },
    ]);
    csv.send(res, 'phantom-geofence-checks.csv', text);
  } catch (err) {
    next(err);
  }
});

router.get('/logs/:id', async (req, res, next) => {
  try {
    const { col } = await collectionFor('clockInLogs');
    let doc = null;
    if (ObjectId.isValid(req.params.id)) doc = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Log not found' });
    const lookup = await siteLookup();
    res.json({ row: normalize.clockInLog(doc, lookup), raw: redact(doc) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
