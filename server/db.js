'use strict';
const { MongoClient } = require('mongodb');
const config = require('./config');

// A serverless function is frozen and thawed between requests, so the client is
// parked on globalThis: one connection per warm instance instead of one per
// request (which would exhaust the Atlas connection limit).
const store = globalThis.__phantomMonitor || (globalThis.__phantomMonitor = {});

async function getDb() {
  if (store.db) return store.db;
  if (!config.mongoUri) throw new Error('MONGODB_URI is not set (see .env or your Vercel project settings)');
  if (!store.connecting) {
    store.connecting = (async () => {
      const client = new MongoClient(config.mongoUri, {
        serverSelectionTimeoutMS: 20000,
        maxPoolSize: 10,
        minPoolSize: 0,
        maxIdleTimeMS: 60000,
      });
      await client.connect();
      store.client = client;
      store.db = client.db(config.dbName);
      return store.db;
    })().catch((err) => {
      store.connecting = null; // let the next request retry
      throw err;
    });
  }
  return store.connecting;
}

/** Documents of this shape are exit windows, wherever they live. */
const EXIT_WINDOW_FILTER = {
  $or: [{ type: 'exit_window' }, { samples: { $type: 'array' }, 'fence.lat': { $exists: true } }],
};

/**
 * Documents of this shape are shift trails, wherever they live.
 *
 * `runId` is the discriminator because it is the one field no other kind in
 * this store has, and it is not optional on a line: the whole point of the
 * payload is that a changed runId means the app process was recreated. The
 * writer may add a `type` later - that is asked for in the payload review -
 * and this accepts it either way rather than waiting for it.
 *
 * Shape, not name: the same rule the other two kinds are found by, so the
 * lines are picked up whether they land in their own collection or get mixed
 * into ekosClientState the way the exit windows are.
 */
const SHIFT_TRAIL_FILTER = {
  $or: [{ type: 'device_state' }, { runId: { $exists: true, $ne: null } }],
};

/** Every kind this app reads, in the order a shared collection is split by. */
const KINDS = ['snapshots', 'clockInLogs', 'exitWindows', 'shiftTrails'];

/**
 * Figures out which collection holds what.
 *  - snapshots   : ekosClientState-style device/user heartbeat documents
 *  - clockInLogs : validateClockInLogs-style geofence validation calls
 *  - exitWindows : { type: 'exit_window' } documents
 *  - shiftTrails : runId-carrying device state lines
 *
 * Document kinds are MIXED inside a collection here - the app writes exit
 * windows into ekosClientState alongside the heartbeats - so each collection is
 * probed for every kind rather than being classified by one sample. Env vars
 * only nominate where to look first.
 */
async function resolveCollections({ force = false } = {}) {
  if (store.resolved && !force) return store.resolved;
  const db = await getDb();
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

  const out = {
    database: config.dbName,
    available: names,
    snapshots: config.collections.snapshots || null,
    clockInLogs: config.collections.clockInLogs || null,
    exitWindows: config.collections.exitWindows || null,
    shiftTrails: config.collections.shiftTrails || null,
    counts: {},
    detected: {},
  };

  for (const name of names) {
    if (name.startsWith('system.')) continue;
    const col = db.collection(name);

    // A collection can hold more than one kind, so probe for each of them.
    let exitHit = null;
    let snapshotHit = null;
    let logHit = null;
    let lineHit = null;
    try {
      [exitHit, snapshotHit, logHit, lineHit] = await Promise.all([
        col.findOne(EXIT_WINDOW_FILTER, { projection: { _id: 1 }, maxTimeMS: 8000 }),
        col.findOne(
          { $or: [{ currentUser: { $exists: true } }, { currentUserLocation: { $exists: true } }] },
          { projection: { _id: 1 }, maxTimeMS: 8000 }
        ),
        col.findOne(
          { requestBody: { $exists: true }, response: { $exists: true } },
          { projection: { _id: 1 }, maxTimeMS: 8000 }
        ),
        col.findOne(SHIFT_TRAIL_FILTER, { projection: { _id: 1 }, maxTimeMS: 8000 }),
      ]);
    } catch (err) {
      continue; // unreadable collection
    }

    if (exitHit && !out.detected.exitWindows) out.detected.exitWindows = name;
    if (snapshotHit && !out.detected.snapshots) out.detected.snapshots = name;
    if (logHit && !out.detected.clockInLogs) out.detected.clockInLogs = name;
    if (lineHit && !out.detected.shiftTrails) out.detected.shiftTrails = name;
  }

  for (const key of KINDS) {
    if (!out[key] || !names.includes(out[key])) out[key] = out.detected[key] || null;
  }
  // The env var can name a collection that does not hold that kind at all (the
  // exit-window one is left empty by default): trust the probe over the name.
  if (out.exitWindows && out.detected.exitWindows && out.exitWindows !== out.detected.exitWindows) {
    out.exitWindowsNamed = out.exitWindows;
    out.exitWindows = out.detected.exitWindows;
  }

  // A single collection may hold more than one kind mixed together.
  const sharesWith = (kind) => KINDS.filter((k) => k !== kind && out[k] && out[k] === out[kind]);
  out.exitWindowsSharesCollection = !!out.exitWindows && sharesWith('exitWindows').length > 0;
  out.shiftTrailsSharesCollection = !!out.shiftTrails && sharesWith('shiftTrails').length > 0;

  for (const key of KINDS) {
    if (!out[key]) continue;
    try {
      const col = db.collection(out[key]);
      const base = baseFilterFor(key, out);
      // Shared collection: count each kind separately so the sidebar totals
      // and the empty-state checks stay honest. Alone in its collection, the
      // cheap estimate is enough.
      out.counts[key] = Object.keys(base).length
        ? await col.countDocuments(base, { maxTimeMS: 15000 })
        : await col.estimatedDocumentCount();
    } catch (err) {
      out.counts[key] = null;
    }
  }

  store.resolved = out;
  return out;
}

/**
 * The filter that isolates one kind inside whatever collection holds it.
 *
 * Empty when the kind has its collection to itself. Otherwise the two
 * recognisable kinds are selected *positively* by their own shape, and the two
 * that have no marker of their own - heartbeats and clock-in logs - are what is
 * left once the others are excluded.
 *
 * That exclusion has to name every other kind present, which is the whole
 * reason this function exists. It used to be the bare negation
 * `{ type: { $ne: 'exit_window' } }`, written when exit windows were the only
 * other thing in ekosClientState. A third kind landing in that collection is
 * not an exit window either, so every shift trail would have been counted as a
 * heartbeat - in the sidebar, in /api/stats and in the Heartbeats table - and
 * normalize.snapshot would have rendered it as a row of nulls rather than
 * failing loudly. A negation is only ever as correct as the list of things it
 * was written against.
 */
function baseFilterFor(kind, map) {
  const name = map[kind];
  const shares = KINDS.filter((k) => k !== kind && map[k] && map[k] === name);
  if (!shares.length) return {};
  if (kind === 'exitWindows') return EXIT_WINDOW_FILTER;
  if (kind === 'shiftTrails') return SHIFT_TRAIL_FILTER;

  const clauses = [];
  if (shares.includes('exitWindows')) clauses.push({ type: { $ne: 'exit_window' } });
  if (shares.includes('shiftTrails')) clauses.push({ runId: { $exists: false } });
  if (!clauses.length) return {};
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/** Collection handle plus the base filter that isolates that document kind. */
async function collectionFor(kind) {
  const db = await getDb();
  const map = await resolveCollections();
  const name = map[kind];
  if (!name) {
    const err = new Error('No collection found for "' + kind + '" in database ' + config.dbName);
    err.status = 404;
    err.code = 'COLLECTION_MISSING';
    throw err;
  }
  return { col: db.collection(name), name, base: baseFilterFor(kind, map) };
}

async function ping() {
  const db = await getDb();
  const started = Date.now();
  await db.command({ ping: 1 });
  return Date.now() - started;
}

async function close() {
  if (store.client) await store.client.close();
  store.client = null;
  store.db = null;
  store.connecting = null;
  store.resolved = null;
}

module.exports = {
  getDb,
  resolveCollections,
  collectionFor,
  ping,
  close,
  EXIT_WINDOW_FILTER,
  SHIFT_TRAIL_FILTER,
  KINDS,
};
