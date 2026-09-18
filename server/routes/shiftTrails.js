'use strict';
const express = require('express');
const { ObjectId } = require('mongodb');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const normalize = require('../lib/normalize');
const csv = require('../lib/csv');
const { redact } = require('../lib/redact');
const { listTrail, summary, namesFor } = require('../lib/shiftTrails');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

/**
 * A store with no trail entries in it yet is the normal state, not an error - the
 * writer is being built while this page is. Every endpoint here answers with an
 * empty result and the reason, so the page can explain itself instead of
 * showing a failure.
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
    if (unavailable(err, res, { rows: [], total: 0, page: 1, limit: 0, runs: { total: 0, restarts: 0, people: 0 } })) return;
    next(err);
  }
});

router.get('/shift-trails/summary', async (req, res, next) => {
  try {
    res.json(await summary(req.query));
  } catch (err) {
    if (unavailable(err, res, { total: 0, users: 0, runs: 0, restarts: 0, timeline: [] })) return;
    next(err);
  }
});

/**
 * The filter dropdowns. Small enough to group the whole collection: these are
 * scalar fields with a handful of distinct values each, not the seven-way facet
 * over every heartbeat that /api/meta has to cache for ten minutes.
 */
router.get('/shift-trails/meta', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('shiftTrails');
    const facet = await col
      .aggregate(
        [
          { $match: base },
          {
            $facet: {
              devices: [{ $group: { _id: '$deviceType', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              permissions: [{ $group: { _id: '$locationPermission', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              precisions: [{ $group: { _id: '$locationPrecision', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              sites: [{ $group: { _id: '$siteId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              users: [{ $group: { _id: '$userId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
            },
          },
        ],
        opts
      )
      .next();

    const asList = (arr) => (arr || []).map((x) => ({ key: x._id, count: x.n }));
    const userIds = (facet.users || []).map((u) => u._id).filter((u) => u !== null && u !== undefined);
    const { names, seenInHeartbeats } = await namesFor(userIds);

    res.json({
      available: true,
      devices: asList(facet.devices).filter((d) => d.key !== null),
      permissions: asList(facet.permissions).filter((p) => p.key !== null),
      // Null is kept here: "not reported" is what every iOS line says, and it
      // has to be selectable rather than filtered out of its own dropdown.
      precisions: asList(facet.precisions),
      sites: asList(facet.sites),
      users: (facet.users || [])
        .filter((u) => u._id !== null && u._id !== undefined)
        .map((u) => ({
          id: u._id,
          count: u.n,
          name: names.get(u._id) || null,
          heartbeatKnown: seenInHeartbeats.has(u._id),
        })),
      anonymousEntries: (facet.users || []).filter((u) => u._id === null || u._id === undefined).reduce((a, u) => a + u.n, 0),
    });
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') {
      return res.json({ available: false, reason: err.message, devices: [], permissions: [], precisions: [], sites: [], users: [] });
    }
    next(err);
  }
});

const CSV_COLUMNS = [
      { key: 'recordedAt', label: 'Recorded At (UTC)' },
      { key: 'userId', label: 'User ID' },
      { key: 'name', label: 'User (named from heartbeats)' },
      { key: 'heartbeatKnown', label: 'Known To Heartbeats' },
      { key: 'runId', label: 'Run ID' },
      { key: 'runOrdinal', label: 'Run # For This User', get: (r) => (r.run ? r.run.ordinal : null) },
      { key: 'runOf', label: 'Runs In Range', get: (r) => (r.run ? r.run.of : null) },
      { key: 'runLines', label: 'Entries In This Run', get: (r) => (r.run ? r.run.entries : null) },
      { key: 'restart', label: 'Restart Boundary' },
      { key: 'siteId', label: 'Site ID' },
      { key: 'deviceType', label: 'Device' },
      { key: 'battery', label: 'Battery %' },
      { key: 'locationPermission', label: 'Location Permission (live)' },
      { key: 'locationPrecision', label: 'Location Precision' },
  { key: 'id', label: 'Document ID' },
];

router.get('/shift-trails.csv', async (req, res, next) => {
  try {
    const data = await listTrail({ ...req.query, limit: 2000 });
    csv.send(res, 'phantom-shift-trails.csv', csv.toCsv(data.rows, CSV_COLUMNS));
  } catch (err) {
    // An empty trail is not a failure anywhere else on this page, and it should
    // not be the one place that hands back a JSON error instead of the file
    // the button asked for. An empty export still carries its header row.
    if (err.code === 'COLLECTION_MISSING') {
      return csv.send(res, 'phantom-shift-trails.csv', csv.toCsv([], CSV_COLUMNS));
    }
    next(err);
  }
});

router.get('/shift-trails/:id', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('shiftTrails');
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Shift trail not found' });
    const doc = await col.findOne(F.and([base, { _id: new ObjectId(req.params.id) }]));
    if (!doc) return res.status(404).json({ error: 'Shift trail not found' });

    const row = normalize.shiftTrail(doc);
    const { names, seenInHeartbeats } = await namesFor([row.userId]);
    row.name = names.get(row.userId) || null;
    row.heartbeatKnown = seenInHeartbeats.has(row.userId);

    // Every line this run has written, so the drawer can say how long the
    // process has been alive and how many entries it has produced. Bounded:
    // without a runStartedAt on the payload, the run's own first line in the
    // store is the only start there is.
    const run = row.runId
      ? await col
          .aggregate(
            [
              { $match: F.and([base, { runId: row.runId, userId: row.userId }]) },
              {
                $group: {
                  _id: null,
                  entries: { $sum: 1 },
                  firstAt: { $min: { $convert: { input: '$recordedAt', to: 'date', onError: null, onNull: null } } },
                  lastAt: { $max: { $convert: { input: '$recordedAt', to: 'date', onError: null, onNull: null } } },
                },
              },
            ],
            opts
          )
          .next()
      : null;

    res.json({
      row,
      run: run
        ? {
            entries: run.entries,
            firstAt: run.firstAt ? new Date(run.firstAt).toISOString() : null,
            lastAt: run.lastAt ? new Date(run.lastAt).toISOString() : null,
          }
        : null,
      raw: redact(doc),
    });
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') return res.status(404).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
