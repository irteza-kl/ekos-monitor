'use strict';
const { EJSON } = require('bson');
const { ACCURACY_BANDS } = require('./geo');

/** Operators that can execute code, write, or reach other collections. */
const FORBIDDEN = new Set([
  '$where', '$function', '$accumulator', '$out', '$merge', '$unionWith',
  '$lookup', '$graphLookup', '$currentOp', '$listSessions', '$listLocalSessions',
  '$planCacheStats', '$collStats', '$indexStats', '$documents', '$search',
]);

const MAX_DEPTH = 14;

/**
 * Rejects anything that could execute JS, write, or read another collection.
 * Everything else (including $expr, $regex, $elemMatch) is allowed so the
 * where-clause box stays genuinely useful.
 */
function assertReadOnly(node, depth = 0, path = '$') {
  if (depth > MAX_DEPTH) throw badRequest('Query nests deeper than ' + MAX_DEPTH + ' levels');
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertReadOnly(v, depth + 1, path + '[' + i + ']'));
    return node;
  }
  if (!node || typeof node !== 'object') return node;
  if (node._bsontype) return node; // ObjectId, Date-likes, Decimal128...
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN.has(key)) throw badRequest('Operator ' + key + ' is not allowed (read-only console)');
    if (key.startsWith('$') && /\$(where|function|accumulator)/i.test(key)) {
      throw badRequest('Operator ' + key + ' is not allowed');
    }
    assertReadOnly(value, depth + 1, path + '.' + key);
  }
  return node;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Parses a user-supplied where clause. Accepts relaxed extended JSON so
 * {"currentUser.data.id": 98} and {"createdAt": {"$gte": {"$date": "..."}}}
 * both work.
 */
function parseWhere(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let text = String(raw).trim();
  let parsed;
  try {
    parsed = EJSON.parse(text, { relaxed: true });
  } catch (err) {
    throw badRequest('Where clause is not valid JSON: ' + err.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Where clause must be a JSON object, e.g. {"deviceType": "ios"}');
  }
  return assertReadOnly(parsed);
}

// ---------------------------------------------------------------------------
// query-string helpers
// ---------------------------------------------------------------------------

function str(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function num(v) {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  const s = str(v);
  if (s === null) return null;
  if (['true', '1', 'yes', 'on'].includes(s.toLowerCase())) return true;
  if (['false', '0', 'no', 'off'].includes(s.toLowerCase())) return false;
  return null;
}

/** Comma-separated or repeated params -> array of strings. */
function list(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

function nums(v) {
  return list(v).map(Number).filter(Number.isFinite);
}

function dateRange(q, field) {
  const range = {};
  const from = str(q.from);
  const to = str(q.to);
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) range.$gte = d;
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) range.$lte = d;
  }
  return Object.keys(range).length ? { [field]: range } : null;
}

function and(clauses) {
  const list_ = clauses.filter((c) => c && Object.keys(c).length);
  if (!list_.length) return {};
  if (list_.length === 1) return list_[0];
  return { $and: list_ };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// snapshots (ekosClientState)
// ---------------------------------------------------------------------------

const SNAP = {
  userId: 'currentUser.data.id',
  tenantId: 'currentUser.data.tenantId',
  fullName: 'currentUser.data.fullName',
  email: 'currentUser.data.email',
  phone: 'currentUser.data.phone',
  employeeRef: 'currentUser.data.tenantAccount.employeeReferenceId',
  tenantName: 'currentUser.data.tenantAccount.tenant.name',
  accuracy: 'currentUserLocation.accuracy',
  // The device's own fix time. Epoch today, expected to become an ISODate -
  // see normalize.flexibleIso and pipelines.capturedAtExpr, which both read it.
  capturedAt: 'currentUserLocation.capturedAt',
  lat: 'currentUserLocation.latitude',
  lng: 'currentUserLocation.longitude',
  appVersion: 'buildVersion.applicationVersion',
  build: 'buildVersion.buildVersion',
  jobSiteId: 'clockedInJobDetail.jobSiteId',
  jobSiteIdAlt: 'clockedInJobSiteLocation.jobSiteId',
};

/**
 * Filters that can run before any $group (indexed / plain document fields).
 */
function snapshotMatch(q) {
  const clauses = [];
  const range = dateRange(q, 'createdAt');
  if (range) clauses.push(range);

  // "anonymous" / "null" selects the devices that report without a session, so
  // the per-user views work for them too.
  const userTokens = list(q.userId);
  const users = nums(q.userId);
  const wantsAnonymous = userTokens.some((t) => t === 'null' || t === 'anonymous');
  if (users.length || wantsAnonymous) {
    const or = [];
    if (users.length) or.push({ [SNAP.userId]: { $in: users } });
    if (wantsAnonymous) or.push({ [SNAP.userId]: null });
    clauses.push(or.length === 1 ? or[0] : { $or: or });
  }

  const tenants = nums(q.tenantId);
  if (tenants.length) clauses.push({ [SNAP.tenantId]: { $in: tenants } });

  const devices = list(q.deviceType);
  if (devices.length) clauses.push({ deviceType: { $in: devices } });

  const versions = list(q.appVersion);
  if (versions.length) clauses.push({ [SNAP.appVersion]: { $in: versions } });

  const timezones = list(q.timezone);
  if (timezones.length) clauses.push({ timezone: { $in: timezones } });

  const sites = nums(q.jobSiteId);
  if (sites.length) {
    clauses.push({ $or: [{ [SNAP.jobSiteId]: { $in: sites } }, { [SNAP.jobSiteIdAlt]: { $in: sites } }] });
  }

  const clockedIn = bool(q.clockedIn);
  if (clockedIn !== null) clauses.push({ clockedIn });

  const inside = bool(q.insideGeofence);
  if (inside !== null) clauses.push({ isInsideGeofence: inside });
  if (str(q.insideGeofence) === 'null') clauses.push({ isInsideGeofence: null });

  const connected = bool(q.connected);
  if (connected !== null) clauses.push({ isConnected: connected });

  const reachable = bool(q.reachable);
  if (reachable !== null) clauses.push({ isReachable: reachable });

  const loggedIn = bool(q.loggedIn);
  if (loggedIn !== null) clauses.push({ isUserLoggedIn: loggedIn });

  const accuracy = {};
  if (num(q.accuracyMin) !== null) accuracy.$gte = num(q.accuracyMin);
  if (num(q.accuracyMax) !== null) accuracy.$lte = num(q.accuracyMax);
  if (Object.keys(accuracy).length) clauses.push({ [SNAP.accuracy]: accuracy });

  const battery = {};
  if (num(q.batteryMin) !== null) battery.$gte = num(q.batteryMin);
  if (num(q.batteryMax) !== null) battery.$lte = num(q.batteryMax);
  if (Object.keys(battery).length) clauses.push({ batteryPercentage: battery });

  if (bool(q.hasLocation) === true) clauses.push({ [SNAP.lat]: { $ne: null } });
  if (bool(q.hasLocation) === false) clauses.push({ [SNAP.lat]: null });

  // Accuracy bands and staleness are ranges over stored fields. Expressing
  // them here (rather than over $addFields output) keeps $match+$sort at the
  // front of the pipeline, where the createdAt index can serve the sort.
  const bands = list(q.accuracyBand);
  if (bands.length) {
    const or = [];
    let low = 0;
    for (const band of ACCURACY_BANDS) {
      if (bands.includes(band.key)) {
        const range = { $gte: low };
        if (Number.isFinite(band.max)) range.$lt = band.max;
        or.push({ [SNAP.accuracy]: range });
      }
      low = Number.isFinite(band.max) ? band.max : low;
    }
    if (bands.includes('unknown')) or.push({ [SNAP.accuracy]: null });
    if (or.length) clauses.push(or.length === 1 ? or[0] : { $or: or });
  }

  const stale = num(q.staleMinutes);
  if (stale !== null) clauses.push({ createdAt: { $lte: new Date(Date.now() - stale * 60000) } });
  const active = num(q.activeMinutes);
  if (active !== null) clauses.push({ createdAt: { $gte: new Date(Date.now() - active * 60000) } });

  const missing = list(q.permissionMissing);
  if (missing.length) clauses.push({ permissionsEnabled: { $nin: missing } });

  const granted = list(q.permissionGranted);
  if (granted.length) clauses.push({ permissionsEnabled: { $all: granted } });

  const search = str(q.search);
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    const or = [
      { [SNAP.fullName]: rx },
      { [SNAP.email]: rx },
      { [SNAP.phone]: rx },
      { [SNAP.employeeRef]: rx },
      { [SNAP.tenantName]: rx },
      { timezone: rx },
    ];
    const asNumber = Number(search);
    if (Number.isFinite(asNumber)) or.push({ [SNAP.userId]: asNumber });
    clauses.push({ $or: or });
  }

  const where = parseWhere(q.where);
  if (where) clauses.push(where);

  return and(clauses);
}

/**
 * Kept as the hook for filters that genuinely need computed fields. Accuracy
 * bands and staleness moved into snapshotMatch (see the note there), so this is
 * empty today - filtering here would re-filter what the index already did.
 */
function snapshotPostMatch() {
  return {};
}

// ---------------------------------------------------------------------------
// clock-in / geofence validation logs (validateClockInLogs)
// ---------------------------------------------------------------------------

const LOG = {
  accuracy: 'requestBody.accuracy',
  lat: 'requestBody.latitude',
  lng: 'requestBody.longitude',
  siteId: 'siteAreaData.siteArea.id',
  radius: 'siteAreaData.siteArea.locations.radiusMeters',
  address: 'siteAreaData.siteArea.locations.address',
  within: 'response.isWithinRadius',
  actual: 'response.actualIsWithinRadius',
  outsideCount: 'response.outsideCount',
  effectiveRadius: 'response.effectiveRadius',
  clockOut: 'response.clockOut',
};

function logMatch(q) {
  const clauses = [];
  const range = dateRange(q, 'createdAt');
  if (range) clauses.push(range);

  const users = nums(q.userId);
  if (users.length) clauses.push({ userId: { $in: users } });

  const sites = nums(q.jobSiteId);
  if (sites.length) clauses.push({ [LOG.siteId]: { $in: sites } });

  const within = bool(q.withinRadius);
  if (within !== null) clauses.push({ [LOG.within]: within });

  const actual = bool(q.actualWithinRadius);
  if (actual !== null) clauses.push({ [LOG.actual]: actual });

  const clockOut = bool(q.triggeredClockOut);
  if (clockOut !== null) clauses.push({ [LOG.clockOut]: clockOut });

  // Reported verdict disagrees with the raw geometry verdict.
  if (bool(q.mismatch) === true) {
    clauses.push({ $expr: { $ne: ['$' + LOG.within, '$' + LOG.actual] } });
  }

  const unmapped = bool(q.unmapped);
  if (unmapped === true) clauses.push({ unmappedClockInData: { $ne: null } });
  if (unmapped === false) clauses.push({ unmappedClockInData: null });

  const accuracy = {};
  if (num(q.accuracyMin) !== null) accuracy.$gte = num(q.accuracyMin);
  if (num(q.accuracyMax) !== null) accuracy.$lte = num(q.accuracyMax);
  if (Object.keys(accuracy).length) clauses.push({ [LOG.accuracy]: accuracy });

  if (num(q.outsideCountMin) !== null) clauses.push({ [LOG.outsideCount]: { $gte: num(q.outsideCountMin) } });

  const search = str(q.search);
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    const or = [{ [LOG.address]: rx }];
    const asNumber = Number(search);
    if (Number.isFinite(asNumber)) {
      or.push({ userId: asNumber }, { [LOG.siteId]: asNumber });
    }
    clauses.push({ $or: or });
  }

  const where = parseWhere(q.where);
  if (where) clauses.push(where);

  return and(clauses);
}

// ---------------------------------------------------------------------------
// exit windows ({ type: 'exit_window' })
// ---------------------------------------------------------------------------

function exitWindowMatch(q) {
  const clauses = [];

  const from = str(q.from);
  const to = str(q.to);
  if (from || to) {
    const iso = {};
    const epoch = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) {
        iso.$gte = d;
        epoch.$gte = d.getTime();
      }
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) {
        iso.$lte = d;
        epoch.$lte = d.getTime();
      }
    }
    // openedAt is epoch millis, pushedAt/createdAt are dates - accept either.
    clauses.push({ $or: [{ openedAt: epoch }, { pushedAt: iso }, { createdAt: iso }] });
  }

  const users = nums(q.userId);
  if (users.length) clauses.push({ userId: { $in: users } });

  const companies = nums(q.tenantId);
  if (companies.length) clauses.push({ $or: [{ companyId: { $in: companies } }, { tenantId: { $in: companies } }] });

  const devices = list(q.deviceType);
  if (devices.length) clauses.push({ deviceType: { $in: devices } });

  const statuses = list(q.status);
  if (statuses.length) clauses.push({ status: { $in: statuses } });

  const resolutions = list(q.resolution);
  if (resolutions.length) clauses.push({ resolution: { $in: resolutions } });

  const openedBy = list(q.openedBy);
  if (openedBy.length) clauses.push({ openedBy: { $in: openedBy } });

  const versions = list(q.appVersion);
  if (versions.length) clauses.push({ applicationVersion: { $in: versions } });

  const search = str(q.search);
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    const or = [{ employeeId: rx }, { id: rx }, { shiftKey: rx }, { deviceId: rx }, { timezone: rx }];
    const asNumber = Number(search);
    if (Number.isFinite(asNumber)) or.push({ userId: asNumber });
    clauses.push({ $or: or });
  }

  const where = parseWhere(q.where);
  if (where) clauses.push(where);

  return and(clauses);
}

/** Applied after sample statistics have been computed. */
function exitWindowPostMatch(q) {
  const clauses = [];
  if (num(q.minSamples) !== null) clauses.push({ 'stats.sampleCount': { $gte: num(q.minSamples) } });
  if (num(q.minDistance) !== null) clauses.push({ 'stats.maxDistanceFromBoundary': { $gte: num(q.minDistance) } });
  if (num(q.accuracyMax) !== null) clauses.push({ 'stats.avgAccuracy': { $lte: num(q.accuracyMax) } });
  if (num(q.minDurationMinutes) !== null) {
    clauses.push({ 'stats.durationMinutes': { $gte: num(q.minDurationMinutes) } });
  }
  if (bool(q.hasUnknown) === true) clauses.push({ 'stats.verdicts.unknown': { $gte: 1 } });
  return and(clauses);
}

// ---------------------------------------------------------------------------

function pagination(q, defaultLimit = 50, maxLimit = 500) {
  const limit = Math.min(Math.max(num(q.limit) || defaultLimit, 1), maxLimit);
  const page = Math.max(num(q.page) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
}

/** Whitelisted sort, so a sort param can never inject an expression. */
/**
 * Fields whose sort key is computed in the pipeline rather than stored.
 *
 * `capturedAt` is the obvious one: it is not a stored field at all, it is the
 * fix time coalesced with two fallback clocks, and it has to be converted to
 * a single type before it can be ordered (see pipelines.capturedAtExpr).
 * Callers add the $addFields stage; this only maps the name.
 */
const COMPUTED_SORT = {
  capturedAt: '_heartbeatAt',
};

function sortSpec(q, allowed, fallback) {
  const field = str(q.sortBy);
  const dir = str(q.sortDir) === 'asc' ? 1 : -1;
  if (field && allowed.includes(field)) return { [COMPUTED_SORT[field] || field]: dir };
  return fallback;
}

module.exports = {
  SNAP,
  dateRange,
  LOG,
  snapshotMatch,
  snapshotPostMatch,
  logMatch,
  exitWindowMatch,
  exitWindowPostMatch,
  parseWhere,
  assertReadOnly,
  pagination,
  sortSpec,
  COMPUTED_SORT,
  and,
  str,
  num,
  bool,
  list,
  nums,
  escapeRegex,
  badRequest,
};
