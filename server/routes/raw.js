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
const { ObjectId } = require('mongodb');
const config = require('../config');
const { getDb, resolveCollections } = require('../db');
const F = require('../lib/filters');
const { redact } = require('../lib/redact');
const cache = require('../lib/cache');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

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

/**
 * What each kind looks like, in the order a document is tested against them.
 *
 * ONE definition, used three ways: to label a row, to filter by kind, and to
 * count the kinds for the dropdown. Writing the same shapes a second time in
 * the aggregation language would have been two definitions to keep in step,
 * and the one that drifted would have produced a filter that disagreed with
 * the label beside it.
 *
 * Order is precedence and matters: an exit window also has no `runId`, and a
 * heartbeat test would match plenty of things that are really something else.
 * Each kind's filter below is its own shape AND none of the shapes above it,
 * which is exactly what kindOf() does by returning early.
 */
const KIND_SHAPES = [
  { key: 'exit window', filter: { $or: [{ type: 'exit_window' }, { samples: { $type: 'array' }, fence: { $exists: true } }] } },
  // A sealed shift envelope: a summary and an `entries` array, with runId on
  // each entry rather than at the top level.
  { key: 'shift trail', filter: { $or: [{ type: 'shift_location_trail' }, { entries: { $type: 'array' }, shiftKey: { $exists: true } }] } },
  { key: 'heartbeat', filter: { $or: [{ currentUser: { $exists: true } }, { currentUserLocation: { $exists: true } }] } },
  { key: 'clock-in check', filter: { requestBody: { $exists: true }, response: { $exists: true } } },
];

const UNRECOGNISED = 'unrecognised';

/**
 * The dropdown contents for one collection: which kinds are in it, and whose
 * names appear on them.
 *
 * Both are full scans - nothing indexes "documents shaped like an exit window"
 * - so this goes through a cache with a long TTL. What it returns changes over
 * days (a new person, a new kind of document starting to arrive), not over
 * seconds, and the Refresh button sends refresh=1 to step past it.
 */
const metaCache = cache.create({ ttlMs: 5 * 60 * 1000, maxKeys: 6 });

/** A label for what a document looks like, so a mixed collection stays legible. */
function kindOf(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.type === 'exit_window' || (Array.isArray(doc.samples) && doc.fence)) return 'exit window';
  if (doc.type === 'shift_location_trail' || (Array.isArray(doc.entries) && doc.shiftKey)) return 'shift trail';
  if (doc.currentUser || doc.currentUserLocation) return 'heartbeat';
  if (doc.requestBody && doc.response) return 'clock-in check';
  return null;
}

/** The query that selects exactly the documents kindOf() would give this label. */
function filterForKind(key) {
  if (key === UNRECOGNISED) return { $nor: KIND_SHAPES.map((s) => s.filter) };
  const index = KIND_SHAPES.findIndex((s) => s.key === key);
  if (index === -1) return null;
  const earlier = KIND_SHAPES.slice(0, index).map((s) => s.filter);
  if (!earlier.length) return KIND_SHAPES[index].filter;
  return { $and: [KIND_SHAPES[index].filter, { $nor: earlier }] };
}

/**
 * Where a person's name lives, both of them.
 *
 * The Android client sends `currentUser` unwrapped on about a quarter of its
 * heartbeats while iOS wraps it in `data`, so a name filter that knew only one
 * path would quietly miss thousands of documents - which on a filter is worse
 * than on a column, because nothing on screen hints that rows are missing.
 */
const NAME_PATHS = ['currentUser.data.fullName', 'currentUser.fullName'];
const NAME_EXPR = { $ifNull: ['$currentUser.data.fullName', '$currentUser.fullName'] };

router.get('/raw/meta', async (req, res, next) => {
  try {
    const db = await getDb();
    const map = await resolveCollections();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'));
    const wanted = F.str(req.query.collection);
    const collection = wanted && names.includes(wanted) ? wanted : map.snapshots && names.includes(map.snapshots) ? map.snapshots : names[0];
    if (!collection) return res.json({ available: false, kinds: [], names: [] });

    const data = await metaCache.through({ collection, refresh: req.query.refresh }, async () => {
      const col = db.collection(collection);
      const keys = KIND_SHAPES.map((s) => s.key).concat(UNRECOGNISED);

      const [counts, people] = await Promise.all([
        Promise.all(
          keys.map(async (key) => {
            try {
              return { key, count: await col.countDocuments(filterForKind(key), { maxTimeMS: config.queryTimeoutMs }) };
            } catch (err) {
              // A kind that times out is still a kind; it just cannot say how
              // many, and an absent count beats a dropdown that fails to open.
              return { key, count: null };
            }
          })
        ),
        col
          .aggregate(
            [
              { $match: { $or: NAME_PATHS.map((p) => ({ [p]: { $nin: [null, ''] } })) } },
              { $group: { _id: NAME_EXPR, n: { $sum: 1 } } },
              { $sort: { n: -1 } },
              { $limit: 300 },
            ],
            opts
          )
          .toArray()
          .catch(() => []),
      ]);

      return {
        available: true,
        collection,
        // Only the kinds actually present: a dropdown offering four options
        // that return nothing is four ways to empty the table.
        kinds: counts.filter((k) => k.count === null || k.count > 0),
        names: people
          .filter((p) => p._id !== null && p._id !== undefined && p._id !== '')
          .map((p) => ({ key: p._id, count: p.n })),
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

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

    // Kind and name are matched in Mongo, not over the page that came back.
    // Filtering a page of 25 would return three rows, call it page 1 of 80,243
    // and page backwards into nothing - a filter has to narrow the query or it
    // is not a filter.
    const kinds = F.list(req.query.kind);
    const kindClauses = kinds.map(filterForKind).filter(Boolean);
    const kindClause = kindClauses.length ? (kindClauses.length === 1 ? kindClauses[0] : { $or: kindClauses }) : null;

    /**
     * Matched on the words, not on the exact string.
     *
     * These names are stored dirty - "Yenny  Montoya " has a double space and a
     * trailing one - and an exact `$in` missed every one of them, because the
     * query string is trimmed on the way in and so no longer equalled the value
     * it was picked from. Rather than carefully preserving whitespace through
     * the whole round trip so two pieces of dirt can match each other, each
     * selected name becomes a pattern anchored at both ends whose gaps accept
     * any run of whitespace. "Yenny Montoya" typed by hand then finds the same
     * rows the dropdown does, which is the behaviour anybody would expect.
     */
    const wantedNames = F.list(req.query.name);
    const nameClause = wantedNames.length
      ? {
          $or: wantedNames.flatMap((name) => {
            const pattern = '^\\s*' + name.split(/\s+/).map(F.escapeRegex).join('\\s+') + '\\s*$';
            return NAME_PATHS.map((p) => ({ [p]: { $regex: pattern, $options: 'i' } }));
          }),
        }
      : null;

    // Free text: a name fragment, or the id of a document somebody was handed.
    // Both are what people actually arrive at this page holding.
    const search = F.str(req.query.search);
    let searchClause = null;
    if (search) {
      const rx = { $regex: F.escapeRegex(search), $options: 'i' };
      const or = NAME_PATHS.map((p) => ({ [p]: rx }));
      if (ObjectId.isValid(search)) or.push({ _id: new ObjectId(search) });
      searchClause = { $or: or };
    }

    const match = F.and([range, kindClause, nameClause, searchClause]);

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
