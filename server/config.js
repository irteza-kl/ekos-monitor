'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);

module.exports = {
  port: int(process.env.PORT, 4310),
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB || 'phantomstage',
  collections: {
    snapshots: process.env.COLLECTION_SNAPSHOTS || 'ekosClientState',
    clockInLogs: process.env.COLLECTION_CLOCKIN_LOGS || 'validateClockInLogs',
    exitWindows: process.env.COLLECTION_EXIT_WINDOWS || '', // '' => auto-detect
  },
  // Empty / unset APP_PASSWORD means the dashboard is open: no login screen and
  // no cookie check. Set it to any value to switch the gate back on.
  password: process.env.APP_PASSWORD || '',
  authRequired: !!(process.env.APP_PASSWORD || ''),
  sessionSecret: process.env.SESSION_SECRET || 'phantom-monitor-dev-secret',
  queryTimeoutMs: int(process.env.QUERY_TIMEOUT_MS, 25000),
  publicDir: path.join(__dirname, '..', 'public'),
};

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('[phantom-monitor] SESSION_SECRET is unset - sessions are signed with the built-in dev secret.');
}
