'use strict';
const express = require('express');
const { EJSON } = require('bson');
const config = require('../config');
const { getDb, resolveCollections } = require('../db');
const F = require('../lib/filters');

const router = express.Router();

/** Only collections the dashboard knows about can be queried. */
async function allowedCollections() {
  const map = await resolveCollections();
  return [map.snapshots, map.clockInLogs, map.exitWindows].filter(Boolean);
}

function parseObject(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return F.assertReadOnly(value);
  try {
    const parsed = EJSON.parse(String(value), { relaxed: true });
    return F.assertReadOnly(parsed);
  } catch (err) {
    throw F.badRequest(label + ' is not valid JSON: ' + err.message);
  }
}

/**
 * Read-only query console.
 * body: { collection, filter, projection, sort, limit, skip, pipeline }
 */
router.post('/query', async (req, res, next) => {
  try {
    const body = req.body || {};
    const allowed = await allowedCollections();
    const collection = F.str(body.collection) || allowed[0];
    if (!allowed.includes(collection)) {
      throw F.badRequest('Collection must be one of: ' + allowed.join(', '));
    }

    const db = await getDb();
    const col = db.collection(collection);
    const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 500);
    const skip = Math.max(Number(body.skip) || 0, 0);
    const started = Date.now();

    if (body.pipeline) {
      const pipeline = parseObject(body.pipeline, 'Pipeline');
      if (!Array.isArray(pipeline)) throw F.badRequest('Pipeline must be a JSON array of stages');
      if (pipeline.length > 25) throw F.badRequest('Pipeline is limited to 25 stages');
      const docs = await col
        .aggregate([...pipeline, { $limit: limit }], {
          allowDiskUse: true,
          maxTimeMS: config.queryTimeoutMs,
        })
        .toArray();
      return res.json({
        mode: 'aggregate',
        collection,
        took: Date.now() - started,
        count: docs.length,
        limit,
        rows: EJSON.serialize(docs, { relaxed: true }),
      });
    }

    const filter = parseObject(body.filter, 'Filter') || {};
    const projection = parseObject(body.projection, 'Projection') || undefined;
    const sort = parseObject(body.sort, 'Sort') || { _id: -1 };

    const cursor = col
      .find(filter, { projection })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .maxTimeMS(config.queryTimeoutMs);

    const [docs, total, explain] = await Promise.all([
      cursor.toArray(),
      body.count === false
        ? Promise.resolve(null)
        : col.countDocuments(filter, { maxTimeMS: config.queryTimeoutMs }).catch(() => null),
      body.explain
        ? col.find(filter, { projection }).sort(sort).limit(limit).explain('queryPlanner').catch(() => null)
        : Promise.resolve(null),
    ]);

    res.json({
      mode: 'find',
      collection,
      took: Date.now() - started,
      count: docs.length,
      total,
      limit,
      skip,
      rows: EJSON.serialize(docs, { relaxed: true }),
      plan: explain
        ? {
            stage: explain.queryPlanner && explain.queryPlanner.winningPlan,
            indexFilterSet: explain.queryPlanner && explain.queryPlanner.indexFilterSet,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/** Field inventory for the explorer's autocomplete. */
router.get('/query/fields', async (req, res, next) => {
  try {
    const allowed = await allowedCollections();
    const collection = F.str(req.query.collection) || allowed[0];
    if (!allowed.includes(collection)) throw F.badRequest('Unknown collection');
    const db = await getDb();
    const docs = await db
      .collection(collection)
      .find({})
      .sort({ _id: -1 })
      .limit(20)
      .maxTimeMS(config.queryTimeoutMs)
      .toArray();

    const fields = new Map();
    for (const doc of docs) walk(doc, '', fields, 0);
    res.json({
      collection,
      collections: allowed,
      fields: [...fields.entries()]
        .map(([path, types]) => ({ path, types: [...types] }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    });
  } catch (err) {
    next(err);
  }
});

function walk(node, prefix, out, depth) {
  if (depth > 6 || !node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '_id' && prefix) continue;
    const path = prefix ? prefix + '.' + key : key;
    const type = Array.isArray(value)
      ? 'array'
      : value === null
        ? 'null'
        : value instanceof Date
          ? 'date'
          : typeof value;
    if (!out.has(path)) out.set(path, new Set());
    out.get(path).add(type);
    if (type === 'object') walk(value, path, out, depth + 1);
    if (type === 'array' && value.length && typeof value[0] === 'object') walk(value[0], path, out, depth + 1);
  }
}

module.exports = router;
