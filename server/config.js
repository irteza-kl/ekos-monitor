'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// The gate: one username, one password, asked for by the browser itself (HTTP
// Basic - see server/lib/auth.js). Set both to switch it on; leave either empty
// and the console is open to anyone who can reach it.
const USERNAME = str(process.env.APP_USERNAME);
const PASSWORD = str(process.env.APP_PASSWORD);
const AUTH_REQUIRED = !!(USERNAME && PASSWORD);

module.exports = {
  port: int(process.env.PORT, 4310),
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB || 'phantomstage',
  collections: {
    snapshots: process.env.COLLECTION_SNAPSHOTS || 'ekosClientState',
    clockInLogs: process.env.COLLECTION_CLOCKIN_LOGS || 'validateClockInLogs',
    exitWindows: process.env.COLLECTION_EXIT_WINDOWS || '', // '' => auto-detect
  },
  username: USERNAME,
  password: PASSWORD,
  authRequired: AUTH_REQUIRED,
  queryTimeoutMs: int(process.env.QUERY_TIMEOUT_MS, 25000),
  publicDir: path.join(__dirname, '..', 'public'),
};

// A password with no username (or the reverse) is almost always a half-finished
// setup, and silently leaving the console open is the worst way to report it.
if (!AUTH_REQUIRED && (USERNAME || PASSWORD)) {
  console.warn(
    '[phantom-monitor] ' +
      (USERNAME ? 'APP_USERNAME is set but APP_PASSWORD is empty' : 'APP_PASSWORD is set but APP_USERNAME is empty') +
      ' - both are needed, so the console is currently OPEN.'
  );
}

if (!AUTH_REQUIRED && process.env.NODE_ENV === 'production') {
  console.warn(
    '[phantom-monitor] No password is configured - this deployment is readable by anyone who can reach it, ' +
      'and the raw document views expose employee contact details and live coordinates.'
  );
}
