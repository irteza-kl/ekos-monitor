'use strict';
/**
 * OPT-IN WRITE. Creates the indexes this dashboard's queries want.
 *
 *   node scripts/ensure-indexes.js         # show what would be created
 *   node scripts/ensure-indexes.js --yes   # create them
 *
 * The dashboard works without these - Mongo just scans more documents. On the
 * staging collection (~87k snapshots) that is a second or two per query; index
 * them if the dataset keeps growing or the pages feel slow.
 *
 * Index builds on Atlas are background operations, but they are still writes to
 * a shared database, so nothing happens unless you pass --yes.
 */
const { MongoClient } = require('mongodb');
const config = require('../server/config');
const { SNAP, LOG } = require('../server/lib/filters');

const PLAN = [
  {
    collection: 'snapshots',
    indexes: [
      { key: { createdAt: -1 }, name: 'createdAt_desc', why: 'every time-range filter and the newest-per-user sort' },
      { key: { [SNAP.userId]: 1, createdAt: -1 }, name: 'user_createdAt', why: 'per-user history and the users table grouping' },
      { key: { [SNAP.tenantId]: 1, createdAt: -1 }, name: 'tenant_createdAt', why: 'tenant filter' },
      { key: { isInsideGeofence: 1, createdAt: -1 }, name: 'geofence_createdAt', why: 'inside/outside filters and the KPI tiles' },
      { key: { [SNAP.jobSiteId]: 1, createdAt: -1 }, name: 'site_createdAt', why: 'site filter and per-site rollups' },
      { key: { [SNAP.accuracy]: 1 }, name: 'accuracy', why: 'accuracy thresholds and the histogram' },
    ],
  },
  {
    collection: 'clockInLogs',
    indexes: [
      { key: { createdAt: -1 }, name: 'createdAt_desc', why: 'the checks table default sort' },
      { key: { userId: 1, createdAt: -1 }, name: 'user_createdAt', why: 'per-user geofence calls' },
      { key: { [LOG.siteId]: 1, createdAt: -1 }, name: 'site_createdAt', why: 'site registry and per-site rollups' },
      { key: { [LOG.actual]: 1, createdAt: -1 }, name: 'actualWithinRadius_createdAt', why: 'compliance and breach filters' },
    ],
  },
  {
    collection: 'exitWindows',
    indexes: [
      { key: { openedAt: -1 }, name: 'openedAt_desc', why: 'the exit-window table default sort' },
      { key: { userId: 1, openedAt: -1 }, name: 'user_openedAt', why: 'per-user windows' },
      { key: { status: 1, openedAt: -1 }, name: 'status_openedAt', why: 'open/expired/resolved filters' },
    ],
  },
];

(async () => {
  const confirmed = process.argv.includes('--yes');
  if (!config.mongoUri) throw new Error('MONGODB_URI is not set');

  const { resolveCollections, close } = require('../server/db');
  const map = await resolveCollections();

  console.log('Database:', map.database, confirmed ? '(creating indexes)' : '(dry run)');
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();

  try {
    for (const group of PLAN) {
      const name = map[group.collection];
      if (!name) {
        console.log('\n' + group.collection + ': not present in this database, skipping');
        continue;
      }
      console.log('\n' + group.collection + ' -> ' + name);
      const col = client.db(map.database).collection(name);
      // A single-field index serves both sort directions, so compare on the
      // field list and only keep direction meaningful for compound indexes.
      const signatureOf = (key) => {
        const entries = Object.entries(key);
        return entries.length === 1
          ? entries[0][0]
          : entries.map(([field, dir]) => field + ':' + dir).join(',');
      };
      const existing = (await col.indexes()).map((i) => signatureOf(i.key));

      for (const index of group.indexes) {
        const signature = signatureOf(index.key);
        if (existing.includes(signature)) {
          console.log('  = ' + index.name.padEnd(30) + 'already present');
          continue;
        }
        if (!confirmed) {
          console.log('  + ' + index.name.padEnd(30) + index.why);
          continue;
        }
        const created = await col.createIndex(index.key, { name: index.name, background: true });
        console.log('  + ' + created.padEnd(30) + index.why);
      }
    }
    if (!confirmed) console.log('\nNothing was written. Re-run with --yes to create the indexes above.');
  } finally {
    await client.close();
    await close().catch(() => {});
  }
})().catch((err) => {
  console.error('index check failed:', err.message);
  process.exit(1);
});
