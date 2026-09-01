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

  const lat = n(loc.latitude);
  const lng = n(loc.longitude);
  const accuracy = n(loc.accuracy);
  const permissionsEnabled = doc.permissionsEnabled || [];

  return {
    id: String(doc._id),
    kind: 'snapshot',
    capturedAt: iso(doc.createdAt) || iso(doc.currentDateTime),
    ageMinutes: minutesSince(doc.createdAt || doc.currentDateTime),

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

    jobSiteId: n(jobDetail.jobSiteId) != null ? n(jobDetail.jobSiteId) : n(jobSiteLoc.jobSiteId),
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

  let fence = null;
  if (n(siteLoc.latitude) !== null && n(siteLoc.longitude) !== null) {
    fence = { lat: n(siteLoc.latitude), lng: n(siteLoc.longitude), radius: n(siteLoc.radiusMeters) };
  } else if (siteLookup && siteArea.id != null && siteLookup[siteArea.id]) {
    const s = siteLookup[siteArea.id];
    fence = { lat: s.lat, lng: s.lng, radius: s.radius };
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
    timeEntryId: n(doc.siteAreaData && doc.siteAreaData.id),
    fence,
    siteAddress: siteLoc.address || null,
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

module.exports = { snapshot, clockInLog, exitWindow, ALL_PERMISSIONS, iso, num: n };
