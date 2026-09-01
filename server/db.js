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
 * Figures out which collection holds what.
 *  - snapshots   : ekosClientState-style device/user heartbeat documents
 *  - clockInLogs : validateClockInLogs-style geofence validation calls
 *  - exitWindows : { type: 'exit_window' } documents
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
    try {
      [exitHit, snapshotHit, logHit] = await Promise.all([
        col.findOne(EXIT_WINDOW_FILTER, { projection: { _id: 1 }, maxTimeMS: 8000 }),
        col.findOne(
          { $or: [{ currentUser: { $exists: true } }, { currentUserLocation: { $exists: true } }] },
          { projection: { _id: 1 }, maxTimeMS: 8000 }
        ),
        col.findOne(
          { requestBody: { $exists: true }, response: { $exists: true } },
          { projection: { _id: 1 }, maxTimeMS: 8000 }
        ),
      ]);
    } catch (err) {
      continue; // unreadable collection
    }

    if (exitHit && !out.detected.exitWindows) out.detected.exitWindows = name;
    if (snapshotHit && !out.detected.snapshots) out.detected.snapshots = name;
    if (logHit && !out.detected.clockInLogs) out.detected.clockInLogs = name;
  }

  for (const key of ['snapshots', 'clockInLogs', 'exitWindows']) {
    if (!out[key] || !names.includes(out[key])) out[key] = out.detected[key] || null;
  }
  // The env var can name a collection that does not hold that kind at all (the
  // exit-window one is left empty by default): trust the probe over the name.
  if (out.exitWindows && out.detected.exitWindows && out.exitWindows !== out.detected.exitWindows) {
    out.exitWindowsNamed = out.exitWindows;
    out.exitWindows = out.detected.exitWindows;
  }

  // A single collection may hold exit windows mixed in with another kind.
  out.exitWindowsSharesCollection =
    !!out.exitWindows && (out.exitWindows === out.snapshots || out.exitWindows === out.clockInLogs);

  for (const key of ['snapshots', 'clockInLogs', 'exitWindows']) {
    if (!out[key]) continue;
    try {
      const col = db.collection(out[key]);
      if (out.exitWindowsSharesCollection && out.exitWindows === out[key]) {
        // Shared collection: count each kind separately so the sidebar totals
        // and the empty-state checks stay honest.
        out.counts[key] =
          key === 'exitWindows'
            ? await col.countDocuments(EXIT_WINDOW_FILTER, { maxTimeMS: 15000 })
            : await col.countDocuments({ type: { $ne: 'exit_window' } }, { maxTimeMS: 15000 });
      } else {
        out.counts[key] = await col.estimatedDocumentCount();
      }
    } catch (err) {
      out.counts[key] = null;
    }
  }

  store.resolved = out;
  return out;
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
  let base = {};
  if (map.exitWindowsSharesCollection && map.exitWindows === name) {
    // Isolate the kind: exit windows in, or everything that is not one out.
    base = kind === 'exitWindows' ? EXIT_WINDOW_FILTER : { type: { $ne: 'exit_window' } };
  }
  return { col: db.collection(name), name, base };
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

module.exports = { getDb, resolveCollections, collectionFor, ping, close, EXIT_WINDOW_FILTER };
