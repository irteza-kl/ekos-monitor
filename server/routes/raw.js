'use strict';
/**
 * Raw documents, newest first.
 *
 * The Query Explorer answers "show me the documents matching this"; this page
 * answers "show me what just arrived", which is a different question and needs
 * no query written to ask it. Nothing is interpreted, grouped or normalised -
 * the document is rendered as stored.
 *
 * Two things are NOT raw, deliberately:
 *
 *  - **Redaction still applies.** These documents embed the whole employee
 *    record, which in this store carries SSN, bank and routing numbers, home
 *    address and emergency contacts. A page whose entire purpose is to show
 *    documents verbatim is exactly the one that would put all of it on screen.
 *    Every other raw-document view in this console goes through lib/redact,
 *    and so does this one.
 *  - **Kinds are not separated.** A collection here can hold more than one kind
 *    mixed together, and the rest of the console isolates them so the stats
 *    stay honest. This page does the opposite on purpose: "what is actually in
 *    this collection" is the question, so every document is listed and each row
 *    is labelled with the kind it looks like instead.
 */
const express = require('express');
const config = require('../config');
const { getDb, resolveCollections } = require('../db');
const F = require('../lib/filters');
const { redact } = require('../lib/redact');

const router = express.Router();

// Raw documents are large - a heartbeat carries the whole embedded employee
// record - and a Vercel function may return at most 4.5 MB. Responses are
// gzipped (see app.js), but the page is meant for reading, not bulk export.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/**
 * Deep paging is a `skip` the server has to walk. This is a viewer, and past
 * a few thousand documents the answer is a filter or the Query Explorer, not a
 * longer walk - so the wall is explicit rather than a query that quietly takes
 * thirty seconds.
 */
const MAX_SKIP = 20000;

/**
 * What to order by.
 *
 * `createdAt` descending is what was asked for and what these collections are
 * written with. A collection that does not carry it cannot be ordered by it,
 * and silently ordering by something else would be the worst outcome - the
 * page would look sorted and not be. So the fallback is `_id`, which for an
 * ObjectId is generated from a timestamp and therefore *is* arrival order, and
 * the response says which one was used so the page can print it.
 */
async function sortFieldFor(col) {
  try {
    const hit = await col.findOne({ createdAt: { $exists: true } }, { projection: { _id: 1 }, maxTimeMS: 8000 });
    if (hit) return { field: 'createdAt', reason: null };
  } catch (err) {
    /* fall through to _id */
  }
  return {
    field: '_id',
    reason: 'no document in this collection carries createdAt, so these are ordered by _id - which for an ObjectId is generated from its creation time, and is the same order',
  };
}

router.get('/raw/collections', async (req, res, next) => {
  try {
    const db = await getDb();
    const map = await resolveCollections();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'));

    const known = {};
    for (const kind of ['snapshots', 'clockInLogs', 'exitWindows', 'shiftTrails']) {
      if (map[kind]) known[map[kind]] = (known[map[kind]] || []).concat(kind);
    }

    const rows = await Promise.all(
      names.map(async (name) => {
        let count = null;
        try {
          count = await db.collection(name).estimatedDocumentCount();
        } catch (err) {
          /* unreadable collections still list, without a count */
        }
        return { name, count, holds: known[name] || [] };
      })
    );
    res.json({ database: map.database, collections: rows });
  } catch (err) {
    next(err);
  }
});

/** A label for what a document looks like, so a mixed collection stays legible. */
function kindOf(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.type === 'exit_window' || (Array.isArray(doc.samples) && doc.fence)) return 'exit window';
  if (doc.runId !== undefined && doc.runId !== null) return 'shift trail';
  if (doc.currentUser || doc.currentUserLocation) return 'heartbeat';
  if (doc.requestBody && doc.response) return 'clock-in check';
  return null;
}

router.get('/raw', async (req, res, next) => {
  try {
    const db = await getDb();
    const map = await resolveCollections();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'));
    if (!names.length) return res.json({ rows: [], total: 0, page: 1, limit: 0, collections: [], unavailable: 'This database has no collections.' });

    const wanted = F.str(req.query.collection);
    const collection = wanted && names.includes(wanted) ? wanted : map.snapshots && names.includes(map.snapshots) ? map.snapshots : names[0];
    if (wanted && !names.includes(wanted)) {
      throw F.badRequest('No collection named "' + wanted + '" in ' + map.database);
    }

    const col = db.collection(collection);
    const limit = Math.min(Math.max(F.num(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const page = Math.max(F.num(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;
    if (skip > MAX_SKIP) {
      throw F.badRequest(
        'This view pages back ' + MAX_SKIP.toLocaleString() + ' documents. Narrow the date range, or use the Query Explorer for anything deeper.'
      );
    }

    const sort = await sortFieldFor(col);
    // The range applies to the field actually being ordered by, so the window
    // on the filter bar and the order on the page can never disagree.
    const range = sort.field === 'createdAt' ? F.dateRange(req.query, 'createdAt') : null;
    const match = F.and([range]);

    const [docs, total] = await Promise.all([
      col
        .find(match)
        .sort({ [sort.field]: -1 })
        .skip(skip)
        .limit(limit)
        .maxTimeMS(config.queryTimeoutMs)
        .toArray(),
      // An unfiltered count of a large collection is a full scan; the metadata
      // estimate is the same number for this purpose and is instant.
      Object.keys(match).length
        ? col.countDocuments(match, { maxTimeMS: config.queryTimeoutMs })
        : col.estimatedDocumentCount(),
    ]);

    res.json({
      collection,
      database: map.database,
      sortField: sort.field,
      sortNote: sort.reason,
      rangeApplies: sort.field === 'createdAt',
      page,
      limit,
      total,
      rows: docs.map((doc) => ({
        id: String(doc._id),
        kind: kindOf(doc),
        // Whichever clock this collection is ordered by, so the row header can
        // show the value the ordering actually used.
        at: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt || null,
        doc: redact(doc),
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
