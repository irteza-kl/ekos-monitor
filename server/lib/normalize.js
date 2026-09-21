'use strict';
const geo = require('./geo');

const ALL_PERMISSIONS = [
  'LOCATION_FOREGROUND',
  'LOCATION_BACKGROUND',
  'CAMERA',
  'NOTIFICATIONS',
  'MEDIA_LIBRARY',
];

function n(v) {
  return Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
}

function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A timestamp whose wire format is not settled.
 *
 * `currentUserLocation.capturedAt` is epoch today and is expected to become a
 * DateTime/ISODate like every other date in the store. Both have to keep
 * working from the same code, because the collection will hold documents in
 * both shapes for as long as old heartbeats are kept - there is no migration
 * that makes one of these go away.
 *
 * Accepts: a BSON/JS Date, epoch milliseconds, epoch **seconds**, a numeric
 * string, or an ISO string. Returns an ISO string, or null when the value
 * cannot be read as a time.
 *
 * The seconds-vs-milliseconds split is the one real trap. A bare number is
 * ambiguous, so it is resolved by magnitude: 1e11 ms is 1973 and 1e11 seconds
 * is the year 5138, so nothing plausible sits on both sides of it. Guessing
 * wrong is not subtle - a fix would read as 1970 - but it would be wrong on
 * every row, so the boundary is stated here rather than left implicit.
 */
const EPOCH_MS_FLOOR = 1e11;
// Anything outside this is a broken clock or a misread unit, not a heartbeat.
const SANE_FROM_MS = Date.UTC(2000, 0, 1);
const SANE_TO_MS = Date.UTC(2100, 0, 1);

function flexibleIso(value) {
  if (value === null || value === undefined || value === '') return null;

  let ms = null;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    ms = num < EPOCH_MS_FLOOR ? num * 1000 : num;
  } else if (typeof value === 'string') {
    const parsed = new Date(value);
    ms = parsed.getTime();
  } else if (typeof value === 'object' && typeof value.getTime === 'function') {
    // Anything Date-like the driver hands back.
    ms = value.getTime();
  }

  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms < SANE_FROM_MS || ms >= SANE_TO_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * When a heartbeat actually happened, and how sure we are of that.
 *
 * Three clocks describe one heartbeat and they are not the same:
 *
 *   currentUserLocation.capturedAt  when the GPS fix was taken   (the truth)
 *   currentDateTime                 the device's own clock       (close)
 *   createdAt                       when the server stored it    (arrival)
 *
 * For a live device they are seconds apart and it does not matter. For one that
 * was offline they are hours apart, and using arrival time puts a morning fix
 * on the map at the time the phone reconnected in the afternoon. So the fix
 * time wins where it exists, `source` records which clock was used, and
 * `receivedAt` keeps arrival so the lag between them stays visible instead of
 * being flattened away.
 */
function heartbeatTime(doc) {
  const loc = (doc && doc.currentUserLocation) || {};
  const fix = flexibleIso(loc.capturedAt);
  if (fix) return { at: fix, source: 'fix' };
  const deviceClock = flexibleIso(doc && doc.currentDateTime);
  const arrival = flexibleIso(doc && doc.createdAt);
  if (deviceClock) return { at: deviceClock, source: 'device' };
  if (arrival) return { at: arrival, source: 'server' };
  return { at: null, source: null };
}
function minutesSince(v) {
  const t = iso(v);
  if (!t) return null;
  return geo.round((Date.now() - new Date(t).getTime()) / 60000, 1);
}

/**
 * ekosClientState document -> flat row used by the tables, maps and KPIs.
 */
function snapshot(doc) {
  if (!doc) return null;
  const user = (doc.currentUser && doc.currentUser.data) || {};
  const tenantAccount = (Array.isArray(user.tenantAccount) ? user.tenantAccount[0] : user.tenantAccount) || {};
  const tenant = tenantAccount.tenant || {};
  const timeEntry = (Array.isArray(user.timeEntry) ? user.timeEntry[0] : user.timeEntry) || {};
  const loc = doc.currentUserLocation || {};
  const jobDetail = doc.clockedInJobDetail || {};
  const jobSiteLoc = doc.clockedInJobSiteLocation || {};
  const siteRecord = doc.siteDetails || {};

  const lat = n(loc.latitude);
  const lng = n(loc.longitude);
  const accuracy = n(loc.accuracy);
  const permissionsEnabled = doc.permissionsEnabled || [];

  const when = heartbeatTime(doc);
  const receivedAt = iso(doc.createdAt);

  return {
    id: String(doc._id),
    kind: 'snapshot',
    // When the heartbeat HAPPENED: the GPS fix time out of
    // currentUserLocation.capturedAt where the device sent one, not when the
    // server stored it. For a device that was offline those are hours apart,
    // and using arrival put a morning fix on the map at the afternoon moment
    // the phone reconnected.
    capturedAt: when.at,
    capturedAtSource: when.source, // 'fix' | 'device' | 'server'
    // Kept alongside, never folded in: the gap between them IS the offline
    // sync lag, and it is only visible while both are on the row.
    receivedAt,
    syncLagMinutes:
      when.at && receivedAt && when.source !== 'server'
        ? geo.round((new Date(receivedAt).getTime() - new Date(when.at).getTime()) / 60000, 1)
        : null,
    // How old our knowledge of their POSITION is.
    ageMinutes: minutesSince(when.at),
    // How long the device has been SILENT. Not the same question, and not the
    // same answer for anything that synced late: a phone reporting every minute
    // can carry a fix from hours ago, and calling that "quiet" is a false alarm
    // on a critical alert.
    receivedAgeMinutes: minutesSince(receivedAt),

    userId: n(user.id),
    name: user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || null,
    email: user.email || null,
    phone: user.phone || null,
    accountStatus: user.status || null,
    accountType: user.accountType || null,
    role: tenantAccount.role || user.accountType || null,
    employeeRef: tenantAccount.employeeReferenceId || null,
    avatarPath: (tenantAccount.profilePicture && tenantAccount.profilePicture.path) || null,

    tenantId: n(user.tenantId) || n(tenantAccount.tenantId) || n(tenant.id),
    tenantName: tenant.name || null,
    tenantCode: tenant.code || null,
    tenantSettings: tenant.tenantSetting || null,
    subscription: user.subscriptionPurchases ? user.subscriptionPurchases.name : null,

    deviceType: doc.deviceType || null,
    appVersion: (doc.buildVersion && doc.buildVersion.applicationVersion) || null,
    buildVersion: (doc.buildVersion && doc.buildVersion.buildVersion) || null,
    battery: n(doc.batteryPercentage),
    batteryOptimizationPermission: doc.batteryOptimizationPermission,
    isConnected: doc.isConnected === true,
    isReachable: doc.isReachable === true,
    offline: doc.isConnected === false || doc.isReachable === false,

    sessionLoggedIn: doc.sessionLoggedIn === true,
    isUserLoggedIn: doc.isUserLoggedIn === true,
    clockedIn: doc.clockedIn === true,
    clockedOut: doc.clockedOut === true,

    permissionsEnabled,
    permissionsDisabled: doc.permissionsDisabled || [],
    permissionsMissing: ALL_PERMISSIONS.filter((p) => !permissionsEnabled.includes(p)),
    locationAlways: doc.allowEveryTimeOnLocationCheck === true,

    location: lat === null || lng === null ? null : { lat, lng, accuracy },
    accuracy,
    accuracyBand: geo.accuracyBand(accuracy),

    // Three paths carry the id. siteDetails.id is the newest and the one that
    // comes with the site itself, so it leads.
    jobSiteId:
      n(siteRecord.id) != null
        ? n(siteRecord.id)
        : n(jobDetail.jobSiteId) != null
          ? n(jobDetail.jobSiteId)
          : n(jobSiteLoc.jobSiteId),
    /**
     * The site as the device had it at that moment.
     *
     * Not a registry lookup: this is the record the app handed the handset
     * with that heartbeat, so it is contemporaneous. A site renamed or a
     * fence moved since does not rewrite what this row means - which is
     * exactly the property a monitoring console needs, and the reason this
     * is kept beside the registry rather than replaced by it.
     *
     * Null on every heartbeat from a build that does not send it yet, so
     * every reader has to fall back to the registry by id.
     */
    site:
      n(siteRecord.id) === null
        ? null
        : {
            siteId: n(siteRecord.id),
            name: siteRecord.name || null,
            address: siteRecord.address || siteRecord.formattedAddress || null,
            city: siteRecord.city || null,
            state: siteRecord.state || null,
            country: siteRecord.country || null,
            zipCode: siteRecord.zipCode || null,
            siteAreaId: n(siteRecord.siteAreaId),
            // A fence on record, so it can be drawn as one.
            fence:
              n(siteRecord.latitude) === null || n(siteRecord.longitude) === null
                ? null
                : {
                    lat: n(siteRecord.latitude),
                    lng: n(siteRecord.longitude),
                    radius: n(siteRecord.radiusMeters),
                  },
            // Strings in the store, not dates.
            recordUpdatedAt: iso(siteRecord.updatedAt),
            recordCreatedAt: iso(siteRecord.createdAt),
            deletedAt: iso(siteRecord.deletedAt),
            source: 'heartbeat',
          },
    jobSiteLocation:
      n(jobSiteLoc.latitude) === null || n(jobSiteLoc.longitude) === null
        ? null
        : { lat: n(jobSiteLoc.latitude), lng: n(jobSiteLoc.longitude) },
    mapped: jobDetail.mapped === undefined ? null : jobDetail.mapped,

    isInsideGeofence: doc.isInsideGeofence === null || doc.isInsideGeofence === undefined ? null : doc.isInsideGeofence,
    geofenceIn: iso(doc.geofenceIn),
    geofenceOut: iso(doc.geofenceOut),

    timezone: doc.timezone || null,
    timezoneOffsetMinutes: n(doc.timezoneOffsetMinutes),
    deviceTime: doc.currentLocalTime || null,
    deviceTimeUtc: iso(doc.currentDateTime),
    clockDriftSeconds:
      iso(doc.currentDateTime) && iso(doc.createdAt)
        ? geo.round((new Date(iso(doc.createdAt)).getTime() - new Date(iso(doc.currentDateTime)).getTime()) / 1000, 1)
        : null,

    timeEntry: timeEntry.id
      ? {
          id: n(timeEntry.id),
          date: timeEntry.date || null,
          status: timeEntry.status || null,
          clockIn: iso(timeEntry.clockIn),
          clockOut: iso(timeEntry.clockOut),
          clockInNetworkStatus: timeEntry.clockInNetworkStatus || null,
          clockOutNetworkStatus: timeEntry.clockOutNetworkStatus || null,
          geoFenceClockIn: iso(timeEntry.geoFenceClockIn),
          geoFenceClockOut: iso(timeEntry.geoFenceClockOut),
          totalDuration: timeEntry.totalDuration,
          siteAreaId: n(timeEntry.siteAreaId),
          requiredFacialVerification: n(timeEntry.requiredFacialVerification),
          completedFacialVerification: n(timeEntry.completedFacialVerification),
          facialVerificationInterval: n(timeEntry.facialVerificationInterval),
        }
      : null,

    facialVerification: {
      enabled: user.enableFacialRecognition === true,
      required: n(timeEntry.requiredFacialVerification),
      completed: n(timeEntry.completedFacialVerification),
      intervalSeconds: n(timeEntry.facialVerificationInterval) || n(jobDetail.facialVerificationInterval),
      pending:
        n(timeEntry.requiredFacialVerification) !== null &&
        n(timeEntry.requiredFacialVerification) > (n(timeEntry.completedFacialVerification) || 0),
    },
  };
}

/**
 * A sealed shift trail -> one flat row per SHIFT.
 *
 * The document is an envelope the app seals at clock-out: the shift's own
 * facts, a `summary` it computed itself, and an `entries` array. An entry is
 * either a `fix` (a GPS position) or a `runtime_start` (the app process being
 * created), so the entries are both the path and the log of what interrupted
 * it.
 *
 * The row is per shift, not per entry, because the document is: a shift is the
 * thing that has a duration, a coverage, an outcome and a person. The entries
 * ride along so the drawer can draw the path and the table can summarise it.
 *
 * Everything the app already worked out is kept as it sent it, and the things
 * it did not are derived here - distance walked, accuracy spread, battery
 * drain, whether the permission changed mid-shift, how long the seal took to
 * arrive. Where a derived number can be checked against the app's own
 * (`runtimeStarts` against the distinct runIds seen), both are kept and the
 * disagreement is reported rather than one of them silently winning.
 */
const ENTRY_FIX = 'fix';
const ENTRY_RUNTIME_START = 'runtime_start';
const ENTRY_GAP = 'gap';

/** A step this long AND this fast is a bad fix, not a journey. See below. */
const IMPOSSIBLE_STEP_METRES = 1000;
const IMPOSSIBLE_STEP_KMH = 300;
const LOCATION_PERMISSIONS = ['always', 'when_in_use', 'denied'];

/** Worst-first, so "the worst this shift ever was" is a max over this order. */
const PERMISSION_SEVERITY = { denied: 3, when_in_use: 2, always: 1 };

function shiftTrail(doc) {
  if (!doc) return null;

  const summary = doc.summary || {};
  const rawEntries = Array.isArray(doc.entries) ? doc.entries : [];

  const entries = rawEntries.map((e) => {
    const lat = n(e.latitude);
    const lng = n(e.longitude);
    const accuracy = n(e.accuracy);
    return {
      kind: e.kind || null,
      isFix: e.kind === ENTRY_FIX,
      isRuntimeStart: e.kind === ENTRY_RUNTIME_START,
      isGap: e.kind === ENTRY_GAP,
      // A kind nobody here has seen before. Carried as a flag so the reader
      // gets the app's own word for it rather than being shown one of the
      // kinds we do know - which is exactly what went wrong when `gap` arrived
      // and every one of them was labelled `fix` by a test that only asked
      // "is this a runtime start?".
      isKnownKind: [ENTRY_FIX, ENTRY_RUNTIME_START, ENTRY_GAP].includes(e.kind),
      // Why the app could not see the device. `services_disabled` is the one
      // that matters most: location services switched off mid-shift, which no
      // other document in this store records.
      reason: e.reason || null,
      // When the app wrote the entry, and - on a fix - when the GPS actually
      // read. Kept apart for the same reason the heartbeat keeps them apart:
      // the gap between them is how stale the position was when it was logged.
      recordedAt: flexibleIso(e.recordedAt),
      capturedAt: flexibleIso(e.capturedAt),
      fixLagSeconds:
        flexibleIso(e.capturedAt) && flexibleIso(e.recordedAt)
          ? geo.round((new Date(flexibleIso(e.recordedAt)).getTime() - new Date(flexibleIso(e.capturedAt)).getTime()) / 1000, 1)
          : null,
      runId: e.runId ? String(e.runId) : null,
      siteId: n(e.siteId),
      deviceType: e.deviceType || null,
      battery: n(e.batteryPercentage),
      locationPermission: e.locationPermission || null,
      locationPrecision: e.locationPrecision || null,
      coarse: e.locationPrecision === 'coarse',
      // Only a runtime_start carries this: whether the foreground service was
      // still alive when the process came back, which is the difference
      // between the OS restarting the app and the app being killed outright.
      foregroundServicePresent:
        e.foregroundServicePresent === undefined ? null : e.foregroundServicePresent,
      location: lat === null || lng === null ? null : { lat, lng, accuracy },
      accuracy,
      accuracyBand: geo.accuracyBand(accuracy),
    };
  });

  /**
   * Chronological, because the stored array is not.
   *
   * One trail in this store holds a `runtime_start` stamped 17:17:40 at index
   * 3, after a `fix` stamped 17:17:41 at index 2 - the app appends entries as
   * it generates them, and a restart can be written with a timestamp slightly
   * behind a fix already queued. Rendered in array order the drawer showed
   * time running backwards for a row, and `batteryStart`/`batteryEnd` read the
   * wrong ends of the shift.
   *
   * The raw document tab still shows the stored order, so nothing is hidden -
   * this is the order the shift happened in.
   */
  entries.sort((a, b) => {
    const at = a.recordedAt ? new Date(a.recordedAt).getTime() : Infinity;
    const bt = b.recordedAt ? new Date(b.recordedAt).getTime() : Infinity;
    return at - bt;
  });

  const fixes = entries.filter((e) => e.location);
  const runtimeStarts = entries.filter((e) => e.isRuntimeStart);
  const gaps = entries.filter((e) => e.isGap);
  const unknownKinds = [...new Set(entries.filter((e) => !e.isKnownKind).map((e) => e.kind).filter(Boolean))];
  const gapReasons = [...new Set(gaps.map((e) => e.reason).filter(Boolean))];

  // The path, in the order the fixes were taken rather than the order they sit
  // in the array - a path drawn in the wrong order measures the wrong pairs.
  const path = fixes
    .slice()
    .sort((a, b) => new Date(a.capturedAt || a.recordedAt || 0) - new Date(b.capturedAt || b.recordedAt || 0));

  /**
   * Distance walked, with the teleports left out.
   *
   * One fix in this store lands 13,547 km from the one 53 seconds before it -
   * reported at ±10 m, more confidently than the three real fixes around it -
   * and summing it produced a 2.7-minute shift that had travelled the width of
   * a planet. That is not a distance, and printing it makes the column
   * worthless for the shifts where it is right.
   *
   * A step is discarded only when it is BOTH long and impossibly fast. Either
   * test alone would be wrong: GPS jitter of 20 m across half a second is
   * hundreds of km/h and is perfectly real, while a kilometre over ten minutes
   * is just a walk. Measured on this store's 114 steps, the rule discards
   * exactly one - the teleport - and the next largest step it keeps is 787 m
   * at 38 km/h. The 708 m step at 110 km/h, somebody in a vehicle, survives.
   *
   * Discarded distance is reported rather than erased, because a fix that
   * wrong is itself the finding.
   */
  let travelledMetres = null;
  let largestStepMetres = null;
  let impossibleSteps = 0;
  let discardedMetres = 0;
  if (path.length > 1) {
    travelledMetres = 0;
    largestStepMetres = 0;
    for (let i = 1; i < path.length; i += 1) {
      const step = geo.haversine(path[i - 1].location, path[i].location);
      if (step === null) continue;
      const fromAt = path[i - 1].capturedAt || path[i - 1].recordedAt;
      const toAt = path[i].capturedAt || path[i].recordedAt;
      const seconds = fromAt && toAt ? (new Date(toAt).getTime() - new Date(fromAt).getTime()) / 1000 : null;
      const kmh = seconds && seconds > 0 ? (step / seconds) * 3.6 : null;
      if (step > IMPOSSIBLE_STEP_METRES && (kmh === null || kmh > IMPOSSIBLE_STEP_KMH)) {
        impossibleSteps += 1;
        discardedMetres += step;
        continue;
      }
      travelledMetres += step;
      if (step > largestStepMetres) largestStepMetres = step;
    }
    travelledMetres = geo.round(travelledMetres, 1);
    largestStepMetres = geo.round(largestStepMetres, 1);
  }

  // The longest silence BETWEEN entries, which is not the same as the app's
  // `absences`: the app decides what counts as an absence, this is simply the
  // biggest hole in what it sent.
  let longestEntryGapMinutes = null;
  const stamped = entries
    .map((e) => e.recordedAt)
    .filter(Boolean)
    .sort();
  for (let i = 1; i < stamped.length; i += 1) {
    const gap = (new Date(stamped[i]).getTime() - new Date(stamped[i - 1]).getTime()) / 60000;
    if (longestEntryGapMinutes === null || gap > longestEntryGapMinutes) longestEntryGapMinutes = gap;
  }
  longestEntryGapMinutes = geo.round(longestEntryGapMinutes, 1);

  const accuracies = fixes.map((e) => e.accuracy).filter((v) => v !== null);
  const batteries = entries.map((e) => e.battery).filter((v) => v !== null);
  const permissions = [...new Set(entries.map((e) => e.locationPermission).filter(Boolean))];
  const precisions = [...new Set(entries.map((e) => e.locationPrecision).filter(Boolean))];
  const runIds = [...new Set(entries.map((e) => e.runId).filter(Boolean))];

  const clockIn = iso(doc.clockIn);
  const clockOut = iso(doc.clockOut);
  const inMs = clockIn ? new Date(clockIn).getTime() : null;
  const outMs = clockOut ? new Date(clockOut).getTime() : null;
  const durationMinutes = inMs !== null && outMs !== null ? geo.round((outMs - inMs) / 60000, 1) : null;

  const positionedMinutes = n(summary.positionedMinutes);
  const absences = (Array.isArray(summary.absences) ? summary.absences : []).map((a) => ({
    from: iso(a.from),
    to: iso(a.to),
    minutes: n(a.minutes),
    runtimeRestarted: a.runtimeRestarted === true,
  }));
  const absentMinutes = absences.reduce((total, a) => total + (a.minutes || 0), 0);

  const sealedAt = iso(doc.sealedAt);
  const pushedAt = iso(doc.pushedAt);

  /**
   * How much of the shift the app could actually say where the person was.
   *
   * `positionedMinutes` is NOT elapsed positioned time - it is a count of the
   * distinct wall-clock minutes that contain a fix. Checked against every
   * trail in the store: it equals the number of distinct minute buckets the
   * fixes fall into on 19 of 21, and is one lower on the other two.
   *
   * So dividing it by the shift's elapsed duration divides a count by a
   * duration, and the answer exceeded 100% on 13 of 21 shifts - a 3.20-minute
   * shift reporting 4 positioned minutes. It was clamped to 100%, which turned
   * a unit error into a tile reading "100.0% · 5 of 4 min": visibly wrong, and
   * the clamp was what hid the cause.
   *
   * The denominator is now the same kind of thing as the numerator - how many
   * wall-clock minutes the shift touches at all - so both sides count minute
   * buckets and the ratio means something. A shift from 16:26:50 to 16:29:02
   * touches four of them.
   */
  const shiftMinutes =
    inMs === null || outMs === null ? null : Math.floor(outMs / 60000) - Math.floor(inMs / 60000) + 1;
  const coverage =
    shiftMinutes && shiftMinutes > 0 && positionedMinutes !== null
      ? geo.round(Math.min(100, (positionedMinutes / shiftMinutes) * 100), 1)
      : null;
  // The clamp above stays, because the app's own count can still exceed the
  // buckets by one - but when it does, that is reported rather than smoothed
  // away, which is the mistake this whole comment exists to record.
  const coverageClamped = !!(shiftMinutes && positionedMinutes !== null && positionedMinutes > shiftMinutes);

  const worstPermission = permissions.length
    ? permissions.slice().sort((a, b) => (PERMISSION_SEVERITY[b] || 0) - (PERMISSION_SEVERITY[a] || 0))[0]
    : null;

  return {
    id: String(doc._id),
    kind: 'shiftTrail',
    type: doc.type || 'shift_location_trail',
    shiftKey: doc.shiftKey ? String(doc.shiftKey) : null,

    userId: n(doc.userId),
    tenantId: n(doc.tenantId),
    siteId: n(doc.siteId),
    deviceId: doc.deviceId || null,

    clockIn,
    clockOut,
    sealedAt,
    pushedAt,
    createdAt: iso(doc.createdAt),
    // The instant the rest of the console orders and filters rows by.
    capturedAt: clockOut || sealedAt || iso(doc.createdAt),
    durationMinutes,
    ageMinutes: minutesSince(clockOut || sealedAt || iso(doc.createdAt)),

    // Sealing happens at clock-out and pushing when the network allows, so
    // these two lags separate "the app was slow to close the shift" from "the
    // phone had no signal until later".
    sealLagSeconds:
      clockOut && sealedAt ? geo.round((new Date(sealedAt).getTime() - new Date(clockOut).getTime()) / 1000, 1) : null,
    pushLagSeconds:
      sealedAt && pushedAt ? geo.round((new Date(pushedAt).getTime() - new Date(sealedAt).getTime()) / 1000, 1) : null,

    deviceType: doc.deviceType || null,
    appVersion: doc.applicationVersion || null,
    buildVersion: doc.buildVersion || null,
    timezone: doc.timezone || null,
    timezoneOffsetMinutes: n(doc.timezoneOffsetMinutes),

    // What the app said about itself, untouched.
    reported: {
      entries: n(summary.entries),
      fixes: n(summary.fixes),
      gaps: n(summary.gaps),
      runtimeStarts: n(summary.runtimeStarts),
      firstEntryAt: iso(summary.firstEntryAt),
      lastEntryAt: iso(summary.lastEntryAt),
      positionedMinutes,
    },

    absences,
    absenceCount: absences.length,
    absentMinutes: geo.round(absentMinutes, 1),
    absencesWithRestart: absences.filter((a) => a.runtimeRestarted).length,

    entries,
    path: path.map((e) => ({ lat: e.location.lat, lng: e.location.lng, at: e.capturedAt || e.recordedAt, accuracy: e.accuracy })),
    firstFix: path.length ? path[0] : null,
    lastFix: path.length ? path[path.length - 1] : null,
    location: path.length ? path[path.length - 1].location : null,

    stats: {
      entryCount: entries.length,
      fixCount: fixes.length,
      runtimeStartCount: runtimeStarts.length,
      gapCount: gaps.length,
      gapReasons,
      // Same treatment as the restart counts: the app reports its own gap
      // total, this counts the gap entries it actually sent, and where they
      // disagree both numbers stay on the row.
      gapsDisagree: n(summary.gaps) !== null && gaps.length !== n(summary.gaps),
      // A kind this console does not know. Surfaced rather than swallowed, so
      // the next new entry type is noticed on arrival instead of being drawn
      // as whatever it is not.
      unknownKinds,
      // The app counts restarts itself. This counts the distinct runIds it
      // actually sent. They should agree - a run beginning IS a restart after
      // the first - and when they do not, that is a finding about the writer
      // rather than about the shift, so both numbers stay on the row.
      distinctRuns: runIds.length,
      runtimeStartsDisagree:
        n(summary.runtimeStarts) !== null && runtimeStarts.length !== n(summary.runtimeStarts),
      // A foreground service that was gone when the process restarted is the
      // strongest evidence in this payload that the OS killed the app.
      serviceMissingOnRestart: runtimeStarts.filter((e) => e.foregroundServicePresent === false).length,

      coverage,
      coverageClamped,
      positionedMinutes,
      // Both counts of wall-clock minutes, so they can be subtracted. The
      // denominator coverage is measured against, and the minutes with no fix
      // in them - which is what "where did the rest of the shift go" means.
      shiftMinutes,
      unpositionedMinutes:
        shiftMinutes !== null && positionedMinutes !== null
          ? Math.max(0, shiftMinutes - positionedMinutes)
          : null,
      longestEntryGapMinutes,

      travelledMetres,
      largestStepMetres,
      // Steps left out of `travelledMetres` because they were long AND
      // impossibly fast. Reported, not erased: a fix that wrong is the finding.
      impossibleSteps,
      discardedMetres: impossibleSteps ? geo.round(discardedMetres, 1) : null,

      minAccuracy: accuracies.length ? geo.round(Math.min(...accuracies), 1) : null,
      maxAccuracy: accuracies.length ? geo.round(Math.max(...accuracies), 1) : null,
      avgAccuracy: accuracies.length ? geo.round(accuracies.reduce((a, b) => a + b, 0) / accuracies.length, 1) : null,

      batteryStart: batteries.length ? batteries[0] : null,
      batteryEnd: batteries.length ? batteries[batteries.length - 1] : null,
      batteryMin: batteries.length ? Math.min(...batteries) : null,
      // Negative means it was charging. Reported as measured either way.
      batteryDrop: batteries.length > 1 ? geo.round(batteries[0] - batteries[batteries.length - 1], 1) : null,

      permissions,
      worstPermission,
      // A permission that changed mid-shift explains a trail that stops dead
      // halfway through, and nothing else in this document would show it.
      permissionChanged: permissions.length > 1,
      precisions,
      precisionChanged: precisions.length > 1,
      coarseFixes: fixes.filter((e) => e.coarse).length,
      unknownAccuracy: fixes.filter((e) => e.accuracy === null).length,
    },
  };
}
/**
 * validateClockInLogs document -> flat row. Recomputes the geometry from the
 * stored coordinates so the dashboard can show what the device reported next to
 * what the numbers actually say.
 */
function clockInLog(doc, siteLookup) {
  if (!doc) return null;
  const body = doc.requestBody || {};
  const res = doc.response || {};
  const siteArea = (doc.siteAreaData && doc.siteAreaData.siteArea) || {};
  const siteLoc = siteArea.locations || {};
  const lat = n(body.latitude);
  const lng = n(body.longitude);
  const accuracy = n(body.accuracy);
  const unmapped = doc.unmappedClockInData || null;

  // What the registry knows about this site: its name always, its geometry
  // only when a fence is genuinely on record.
  const known = (siteLookup && siteArea.id != null && siteLookup[siteArea.id]) || null;

  let fence = null;
  if (n(siteLoc.latitude) !== null && n(siteLoc.longitude) !== null) {
    fence = { lat: n(siteLoc.latitude), lng: n(siteLoc.longitude), radius: n(siteLoc.radiusMeters) };
  } else if (known && known.lat != null) {
    fence = { lat: known.lat, lng: known.lng, radius: known.radius };
  }

  const point = lat === null || lng === null ? null : { lat, lng };
  const relation = fence ? geo.fenceRelation(point, fence) : null;
  const judged = fence ? geo.verdictWithAccuracy(point, fence, accuracy) : null;

  return {
    id: String(doc._id),
    kind: 'clockInLog',
    capturedAt: iso(doc.createdAt),
    ageMinutes: minutesSince(doc.createdAt),
    deviceTimestamp: iso(body.timeStamp),
    userId: n(doc.userId),

    location: point ? { lat, lng, accuracy } : null,
    accuracy,
    accuracyBand: geo.accuracyBand(accuracy),

    siteId: n(siteArea.id),
    // These calls carry no site name of their own, so it comes from the
    // registry - which learns names from the heartbeats' siteDetails. Null when
    // no heartbeat has ever named this site.
    siteName: (known && (known.name || known.displayName)) || null,
    timeEntryId: n(doc.siteAreaData && doc.siteAreaData.id),
    fence,
    siteAddress: siteLoc.address || (known && known.address) || null,
    siteCity: siteLoc.city || null,
    siteCountry: siteLoc.country || null,

    isWithinRadius: res.isWithinRadius === undefined ? null : res.isWithinRadius,
    actualIsWithinRadius: res.actualIsWithinRadius === undefined ? null : res.actualIsWithinRadius,
    graceApplied: res.isWithinRadius === true && res.actualIsWithinRadius === false,
    mismatch: res.isWithinRadius !== undefined && res.isWithinRadius !== res.actualIsWithinRadius,
    triggeredClockOut: res.clockOut === true,
    outsideCount: n(res.outsideCount),
    effectiveRadius: n(res.effectiveRadius),
    radiusPadding:
      n(res.effectiveRadius) !== null && n(siteLoc.radiusMeters) !== null
        ? geo.round(n(res.effectiveRadius) - n(siteLoc.radiusMeters), 2)
        : null,

    relation,
    verdict: judged ? judged.verdict : 'unknown',
    verdictReason: judged ? judged.reason : 'no geofence on record',

    unmapped: !!unmapped || body.isUnmapped === true,
    unmappedEntry: unmapped
      ? {
          id: n(unmapped.id),
          requestId: n(unmapped.requestId),
          clockIn: iso(unmapped.clockIn),
          clockOut: iso(unmapped.clockOut),
          geoFenceClockIn: iso(unmapped.geoFenceClockIn),
          geoFenceClockOut: iso(unmapped.geoFenceClockOut),
          lat: n(unmapped.latitude),
          lng: n(unmapped.longitude),
          networkStatus: unmapped.clockInNetworkStatus || null,
        }
      : null,
  };
}

/**
 * { type: 'exit_window' } document -> flat row with sample statistics. Handles
 * documents that carry their own per-sample verdicts as well as ones that only
 * carry coordinates (verdicts are then recomputed from the fence).
 */
function exitWindow(doc) {
  if (!doc) return null;
  const fenceRaw = doc.fence || {};
  const fence =
    n(fenceRaw.lat) === null || n(fenceRaw.lng) === null
      ? null
      : { lat: n(fenceRaw.lat), lng: n(fenceRaw.lng), radius: n(fenceRaw.radius) };

  const samples = (Array.isArray(doc.samples) ? doc.samples : []).map((s) => {
    const lat = n(s.lat);
    const lng = n(s.lng);
    const accuracy = n(s.accuracy);
    const point = lat === null || lng === null ? null : { lat, lng };
    const computed = fence ? geo.verdictWithAccuracy(point, fence, accuracy) : null;
    const reported = n(s.distanceFromBoundary);
    const distance = geo.round(
      reported !== null ? reported : computed && computed.relation ? computed.relation.distanceFromBoundary : null,
      1
    );
    return {
      at: iso(s.t) || iso(s.at) || iso(s.timestamp),
      epoch: n(s.t) || (iso(s.at) ? new Date(iso(s.at)).getTime() : null),
      lat,
      lng,
      accuracy: geo.round(accuracy, 1),
      accuracyBand: geo.accuracyBand(accuracy),
      distanceFromBoundary: distance,
      verdict: s.verdict || (computed ? computed.verdict : 'unknown'),
      computedVerdict: computed ? computed.verdict : null,
      verdictDisagrees: !!(s.verdict && computed && s.verdict !== computed.verdict),
      bearing: computed && computed.relation ? computed.relation.bearing : null,
      compass: computed && computed.relation ? computed.relation.compass : null,
    };
  });

  const accs = samples.map((s) => s.accuracy).filter((v) => v !== null);
  const dists = samples.map((s) => s.distanceFromBoundary).filter((v) => v !== null);
  const verdicts = samples.reduce(
    (acc, s) => {
      acc[s.verdict] = (acc[s.verdict] || 0) + 1;
      return acc;
    },
    { in: 0, out: 0, unknown: 0 }
  );

  const openedAt = iso(doc.openedAt);
  const closedAt = iso(doc.resolvedAt) || iso(doc.closedAt);
  const expiresAt = iso(doc.expiresAt);
  const endedAt = closedAt || expiresAt;
  const durationMinutes =
    openedAt && endedAt ? geo.round((new Date(endedAt).getTime() - new Date(openedAt).getTime()) / 60000, 1) : null;

  const last = samples.length ? samples[samples.length - 1] : null;
  const summary = doc.summary || {};

  return {
    id: String(doc.id || doc._id),
    docId: String(doc._id),
    kind: 'exitWindow',
    type: doc.type || 'exit_window',
    seq: n(doc.seq),
    rev: n(doc.rev),
    shiftKey: doc.shiftKey || null,

    userId: n(doc.userId),
    employeeRef: doc.employeeId || null,
    tenantId: n(doc.companyId) != null ? n(doc.companyId) : n(doc.tenantId),

    deviceType: doc.deviceType || (doc.diagnostics && doc.diagnostics.platform) || null,
    deviceId: doc.deviceId || null,
    appVersion: doc.applicationVersion || null,
    buildVersion: doc.buildVersion || null,
    timezone: doc.timezone || null,
    timezoneOffsetMinutes: n(doc.timezoneOffsetMinutes),

    openedBy: doc.openedBy || null,
    status: doc.status || null,
    resolution: doc.resolution || null,
    openedAt,
    expiresAt,
    resolvedAt: closedAt,
    pushedAt: iso(doc.pushedAt),
    capturedAt: iso(doc.pushedAt) || openedAt || iso(doc.createdAt),
    expired: !!(expiresAt && !closedAt && new Date(expiresAt).getTime() < Date.now()),

    fence,
    jobSiteId: n(doc.jobSiteId) != null ? n(doc.jobSiteId) : n(fenceRaw.siteId),
    siteAddress: doc.fence && doc.fence.address ? doc.fence.address : null,
    diagnostics: doc.diagnostics || null,
    battery: n(doc.diagnostics && doc.diagnostics.batteryLevel),
    offline: !!(doc.diagnostics && doc.diagnostics.isConnected === false),
    permissionStatus: (doc.diagnostics && doc.diagnostics.permissionStatus) || null,
    servicesEnabled: doc.diagnostics ? doc.diagnostics.servicesEnabled : null,

    samples,
    lastSample: last,
    location: last && last.lat !== null ? { lat: last.lat, lng: last.lng, accuracy: last.accuracy } : null,

    stats: {
      sampleCount: samples.length,
      durationMinutes,
      verdicts,
      reportedSummary: Object.keys(summary).length ? summary : null,
      consecutiveOut: consecutive(samples, 'out'),
      consecutiveIn: consecutive(samples, 'in'),
      unknownRatio: samples.length ? geo.round(verdicts.unknown / samples.length, 3) : null,
      minAccuracy: accs.length ? geo.round(Math.min(...accs), 1) : null,
      maxAccuracy: accs.length ? geo.round(Math.max(...accs), 1) : null,
      avgAccuracy: accs.length ? geo.round(accs.reduce((a, b) => a + b, 0) / accs.length, 1) : null,
      maxDistanceFromBoundary: dists.length ? geo.round(Math.max(...dists), 1) : null,
      lastDistanceFromBoundary: last ? last.distanceFromBoundary : null,
      driftMetres:
        samples.length > 1 && samples[0].lat !== null && last.lat !== null
          ? geo.round(geo.haversine({ lat: samples[0].lat, lng: samples[0].lng }, { lat: last.lat, lng: last.lng }), 1)
          : null,
      disagreements: samples.filter((s) => s.verdictDisagrees).length,
    },
  };
}

/** Longest run of a given verdict at the tail of the sample list. */
function consecutive(samples, verdict) {
  let count = 0;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i].verdict !== verdict) break;
    count += 1;
  }
  return count;
}

module.exports = {
  flexibleIso,
  heartbeatTime, snapshot, clockInLog, exitWindow, shiftTrail,
  ALL_PERMISSIONS, LOCATION_PERMISSIONS, iso, num: n };
