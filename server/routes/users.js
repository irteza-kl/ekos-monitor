'use strict';
const express = require('express');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const { SNAP, LOG } = F;
const P = require('../lib/pipelines');
const normalize = require('../lib/normalize');
const geo = require('../lib/geo');
const csv = require('../lib/csv');
const { attachWindowSite, siteLookup, getSites } = require('../lib/sites');
const { redact } = require('../lib/redact');
const { windowsForUser } = require('../lib/attribution');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

const SORTABLE = [
  'createdAt',
  'currentUser.data.fullName',
  'currentUserLocation.accuracy',
  'batteryPercentage',
  'deviceType',
  'isInsideGeofence',
  'clockedIn',
  'ageMinutes',
  'accuracyBand',
];

/** Enriches a normalized row with the site it is clocked into. */
function attachSite(row, sites) {
  if (!row) return row;
  const site = row.jobSiteId != null ? sites.find((s) => s.siteId === row.jobSiteId) : null;
  row.site = site
    ? {
        siteId: site.siteId,
        label: site.label,
        address: site.address,
        lat: site.lat,
        lng: site.lng,
        radius: site.radius,
        source: site.source,
        hasFence: site.hasFence,
        centreSource: site.centreSource,
        radiusSource: site.radiusSource,
        radiusIsAuthoritative: site.radiusIsAuthoritative,
        centreIsEstimate: site.centreIsEstimate,
        centreConfidence: site.centreConfidence,
      }
    : null;

  // A verdict needs a fence that was actually on record. An estimated centre, or
  // a radius borrowed from a nearby fence record, would produce a confident
  // inside/outside for a boundary nobody ever configured.
  const fence =
    site && site.radiusIsAuthoritative && site.lat != null && site.lng != null
      ? { lat: site.lat, lng: site.lng, radius: site.radius }
      : null;
  if (fence && row.location) {
    const judged = geo.verdictWithAccuracy(
      { lat: row.location.lat, lng: row.location.lng },
      fence,
      row.location.accuracy
    );
    row.fence = fence;
    row.relation = judged.relation;
    row.computedVerdict = judged.verdict;
    row.verdictReason = judged.reason;
    // The device flag and the geometry can disagree - that is worth surfacing.
    row.verdictDisagrees =
      row.isInsideGeofence !== null && judged.verdict !== 'unknown' && row.isInsideGeofence !== (judged.verdict === 'in');
    row.guide =
      row.relation && !row.relation.inside
        ? {
            distanceMetres: row.relation.distanceFromBoundary,
            bearing: row.relation.bearing,
            compass: row.relation.compass,
            directionsUrl:
              'https://www.google.com/maps/dir/?api=1&origin=' +
              row.location.lat + ',' + row.location.lng +
              '&destination=' + fence.lat + ',' + fence.lng + '&travelmode=walking',
          }
        : null;
  } else {
    row.fence = fence;
    row.relation = null;
    row.computedVerdict = null;
    row.verdictDisagrees = false;
    row.guide = null;
  }
  return row;
}

async function listUsers(q) {
  const { col, base } = await collectionFor('snapshots');
  const match = F.and([base, F.snapshotMatch(q)]);
  const postMatch = F.snapshotPostMatch(q);
  const { limit, page, skip } = F.pagination(q, 50, 500);
  const sort = F.sortSpec(q, SORTABLE, { createdAt: -1 });

  const result = await col
    .aggregate(P.latestPerUser({ match, postMatch, sort, skip, limit }), opts)
    .next();

  const sites = await getSites();
  const rows = (result.rows || []).map((doc) => {
    const row = normalize.snapshot(doc);
    row.agg = doc._agg
      ? {
          snapshots: doc._agg.snapshotCount,
          firstSeenAt: normalize.iso(doc._agg.firstSeenAt),
          lastSeenAt: normalize.iso(doc._agg.lastSeenAt),
          avgAccuracy: doc._agg.avgAccuracy,
          bestAccuracy: geo.round(doc._agg.bestAccuracy, 1),
          worstAccuracy: geo.round(doc._agg.worstAccuracy, 1),
          insideCount: doc._agg.insideCount,
          outsideCount: doc._agg.outsideCount,
          offlineCount: doc._agg.offlineCount,
          minBattery: doc._agg.minBattery,
          siteIds: doc._agg.siteIds || [],
        }
      : null;
    return attachSite(row, sites);
  });

  return { rows, total: (result.total[0] || {}).value || rows.length, page, limit };
}

router.get('/users', async (req, res, next) => {
  try {
    const data = await listUsers(req.query);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/users.csv', async (req, res, next) => {
  try {
    const data = await listUsers({ ...req.query, limit: 500 });
    const text = csv.toCsv(data.rows, [
      { key: 'userId', label: 'User ID' },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'employeeRef', label: 'Employee Ref' },
      { key: 'tenantName', label: 'Tenant' },
      { key: 'role', label: 'Role' },
      { key: 'deviceType', label: 'Device' },
      { key: 'appVersion', label: 'App Version' },
      { key: 'buildVersion', label: 'Build' },
      { key: 'battery', label: 'Battery %' },
      { key: 'isConnected', label: 'Connected' },
      { key: 'clockedIn', label: 'Clocked In' },
      { key: 'isInsideGeofence', label: 'Inside Geofence (device)' },
      { key: 'computedVerdict', label: 'Verdict (recomputed)' },
      { key: 'verdictDisagrees', label: 'Verdict Mismatch' },
      { key: 'jobSiteId', label: 'Site ID' },
      { key: 'site.address', label: 'Site Address', get: (r) => (r.site ? r.site.address : null) },
      {
        key: 'relation.distanceFromBoundary',
        label: 'Distance From Boundary (m, negative = inside)',
        get: (r) => (r.relation ? r.relation.distanceFromBoundary : null),
      },
      { key: 'accuracy', label: 'Accuracy (m)' },
      { key: 'accuracyBand', label: 'Accuracy Band' },
      { key: 'location.lat', label: 'Latitude', get: (r) => (r.location ? r.location.lat : null) },
      { key: 'location.lng', label: 'Longitude', get: (r) => (r.location ? r.location.lng : null) },
      { key: 'timezone', label: 'Timezone' },
      { key: 'capturedAt', label: 'Last Seen (UTC)' },
      { key: 'ageMinutes', label: 'Age (min)' },
      { key: 'permissionsMissing', label: 'Missing Permissions' },
    ]);
    csv.send(res, 'phantom-users.csv', text);
  } catch (err) {
    next(err);
  }
});

/** Paged raw snapshot feed (the activity log view). */
router.get('/snapshots', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('snapshots');
    const match = F.and([base, F.snapshotMatch(req.query)]);
    const postMatch = F.snapshotPostMatch(req.query);
    const { limit, page, skip } = F.pagination(req.query, 100, 2000);
    const sort = F.sortSpec(req.query, SORTABLE, { createdAt: -1 });

    // $match and $sort stay at the front so the createdAt index can serve the
    // sort; the computed fields are added only to the page being returned.
    const result = await col
      .aggregate(
        [
          { $match: match },
          { $sort: sort },
          {
            $facet: {
              rows: [{ $skip: skip }, { $limit: limit }, { $addFields: P.computedFields }, { $match: postMatch }],
              total: [{ $count: 'value' }],
            },
          },
        ],
        opts
      )
      .next();

    const sites = await getSites();
    res.json({
      rows: (result.rows || []).map((d) => attachSite(normalize.snapshot(d), sites)),
      total: (result.total[0] || {}).value || 0,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

/** Heartbeat feed as CSV, with the recomputed geometry included. */
router.get('/snapshots.csv', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('snapshots');
    const match = F.and([base, F.snapshotMatch(req.query)]);
    const limit = Math.min(Number(req.query.limit) || 2000, 5000);
    const docs = await col
      .find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .maxTimeMS(config.queryTimeoutMs)
      .toArray();
    const sites = await getSites();
    const rows = docs.map((d) => attachSite(normalize.snapshot(d), sites));
    const text = csv.toCsv(rows, [
      { key: 'capturedAt', label: 'Captured At (UTC)' },
      { key: 'userId', label: 'User ID' },
      { key: 'name', label: 'Name' },
      { key: 'location.lat', label: 'Latitude', get: (x) => (x.location ? x.location.lat : null) },
      { key: 'location.lng', label: 'Longitude', get: (x) => (x.location ? x.location.lng : null) },
      { key: 'accuracy', label: 'Accuracy (m)' },
      { key: 'accuracyBand', label: 'Accuracy Band' },
      { key: 'isInsideGeofence', label: 'Inside Geofence (device)' },
      { key: 'computedVerdict', label: 'Verdict (recomputed)' },
      { key: 'verdictDisagrees', label: 'Verdict Mismatch' },
      {
        key: 'relation.distanceFromBoundary',
        label: 'Distance From Boundary (m, negative = inside)',
        get: (x) => (x.relation ? x.relation.distanceFromBoundary : null),
      },
      { key: 'jobSiteId', label: 'Site ID' },
      { key: 'clockedIn', label: 'Clocked In' },
      { key: 'battery', label: 'Battery %' },
      { key: 'isConnected', label: 'Connected' },
      { key: 'isReachable', label: 'Reachable' },
      { key: 'deviceType', label: 'Device' },
      { key: 'appVersion', label: 'App Version' },
      { key: 'buildVersion', label: 'Build' },
      { key: 'isUserLoggedIn', label: 'Logged In' },
      { key: 'sessionLoggedIn', label: 'Session Active' },
      { key: 'deviceTime', label: 'Device Local Time' },
      { key: 'timezone', label: 'Timezone' },
      { key: 'permissionsMissing', label: 'Missing Permissions' },
      { key: 'id', label: 'Document ID' },
    ]);
    csv.send(res, 'phantom-heartbeats.csv', text);
  } catch (err) {
    next(err);
  }
});

router.get('/users/:userId', async (req, res, next) => {
  try {
    const userId = req.params.userId === 'anonymous' ? null : Number(req.params.userId);
    const { col, base } = await collectionFor('snapshots');
    const idMatch = userId === null ? { [SNAP.userId]: null } : { [SNAP.userId]: userId };
    const match = F.and([base, idMatch, F.snapshotMatch({ ...req.query, userId: undefined })]);
    // The trail is the NEWEST `historyLimit` heartbeats, which is not the same
    // thing as the range. Reporting rates here differ by over 200x - one device
    // sends a heartbeat a second - so for the fast ones 800 documents is the
    // last quarter of an hour of a 24-hour window, and the map silently showed
    // that while every count above it described the whole day. The response now
    // says so and the map prints it.
    //
    // The ceiling was 5,000 while the user page asked for 800, so asking for
    // more than 800 was impossible from the UI and more than 5,000 impossible
    // at all. A day of one 1 Hz device is 86,400 heartbeats, so "show me all of
    // them" needs real headroom: the cap is now 100,000 and the page lets you
    // choose. The projection is nine small fields, so the cost is transfer, not
    // the query - and the page reports when it hits the ceiling.
    const HISTORY_CEILING = 100000;
    const historyLimit = Math.max(1, Math.min(Number(req.query.historyLimit) || 500, HISTORY_CEILING));

    const [latestDoc, history, agg] = await Promise.all([
      col.find(match).sort({ createdAt: -1 }).limit(1).maxTimeMS(config.queryTimeoutMs).next(),
      col
        .find(match, {
          // Exactly what the track emits, and nothing else. This projection
          // used to pull fourteen fields (including `permissionsEnabled`, an
          // array) to build a seven-field point - wasted on one document, and
          // wasted tens of megabytes over the wire from Atlas now that this
          // limit reaches 100,000 of them. `currentUserLocation` is asked for
          // whole because the sub-fields are all used.
          projection: {
            createdAt: 1,
            currentUserLocation: 1,
            isInsideGeofence: 1,
            clockedIn: 1,
            batteryPercentage: 1,
          },
        })
        .sort({ createdAt: -1 })
        .limit(historyLimit)
        .maxTimeMS(config.queryTimeoutMs)
        .toArray(),
      col
        .aggregate(
          [
            { $match: match },
            {
              $group: {
                _id: null,
                snapshots: { $sum: 1 },
                firstSeenAt: { $min: '$createdAt' },
                lastSeenAt: { $max: '$createdAt' },
                avgAccuracy: { $avg: '$' + SNAP.accuracy },
                worstAccuracy: { $max: '$' + SNAP.accuracy },
                bestAccuracy: { $min: '$' + SNAP.accuracy },
                inside: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', true] }, 1, 0] } },
                outside: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', false] }, 1, 0] } },
                offline: { $sum: { $cond: [{ $eq: ['$isConnected', false] }, 1, 0] } },
                clockedInSnapshots: { $sum: { $cond: [{ $eq: ['$clockedIn', true] }, 1, 0] } },
                minBattery: { $min: '$batteryPercentage' },
                maxBattery: { $max: '$batteryPercentage' },
                sites: { $addToSet: { $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt] } },
              },
            },
          ],
          opts
        )
        .next(),
    ]);

    if (!latestDoc) {
      // Nothing in this window. Whether the user is quiet or unknown is a
      // different answer, so look outside the range before saying which.
      const ever = await col
        .find(F.and([base, idMatch]))
        .project({ createdAt: 1 })
        .sort({ createdAt: -1 })
        .limit(1)
        .maxTimeMS(config.queryTimeoutMs)
        .next();
      if (!ever) return res.status(404).json({ error: 'No snapshots found for that user' });
      return res.status(404).json({
        error: 'No heartbeats from this user in the selected range',
        lastSeenAt: ever.createdAt instanceof Date ? ever.createdAt.toISOString() : ever.createdAt,
        outOfRange: true,
      });
    }

    const sites = await getSites();
    const current = attachSite(normalize.snapshot(latestDoc), sites);

    // A heartbeat with no coordinates cannot go on a map, but it is still a
    // heartbeat and it is still in the count above the map. That silent
    // difference is a third reason "not all my heartbeats are showing" - so it
    // is counted here and named in the UI rather than left to be inferred from
    // two numbers that do not match.
    const trackAll = history
      .slice()
      .reverse()
      .map((d) => {
        const loc = d.currentUserLocation || {};
        return {
          // Seven fields, and every one of them is read by the map or the
          // History charts. `accuracyBand`, `connected` and `jobSiteId` used to
          // ride along here too and nothing on the client ever looked at them -
          // 52 bytes a point of dead weight, which at the limits this endpoint
          // now serves is megabytes. The band is derivable from `accuracy`
          // anyway, and the other two are on `current` and on the Heartbeats
          // rows, which is where they are actually used.
          at: normalize.iso(d.createdAt),
          lat: normalize.num(loc.latitude),
          lng: normalize.num(loc.longitude),
          accuracy: normalize.num(loc.accuracy),
          insideGeofence: d.isInsideGeofence === undefined ? null : d.isInsideGeofence,
          clockedIn: d.clockedIn === true,
          battery: normalize.num(d.batteryPercentage),
        };
      });
    const track = trackAll.filter((p) => p.lat !== null && p.lng !== null);
    const trackNoFix = trackAll.length - track.length;

    // Distance actually travelled across the tracked window.
    let travelled = 0;
    for (let i = 1; i < track.length; i += 1) {
      const d = geo.haversine(track[i - 1], track[i]);
      if (d !== null) travelled += d;
    }

    // Related geofence validation calls.
    //
    // These were fetched by user id alone, ignoring the range the rest of the
    // page is filtered to. So the trail map plotted clock-in checks from months
    // outside the window - marks with no heartbeat anywhere near them, in a
    // frame chosen for the heartbeats - and the tab count disagreed with the
    // Geofence Checks page for the same filters.
    let logs = [];
    try {
      const lookup = await siteLookup();
      const logCol = await collectionFor('clockInLogs');
      const logDocs = await logCol.col
        .find(
          F.and([
            logCol.base,
            userId === null ? { userId: null } : { userId },
            F.logMatch({ from: req.query.from, to: req.query.to }),
          ])
        )
        .sort({ createdAt: -1 })
        .limit(100)
        .maxTimeMS(config.queryTimeoutMs)
        .toArray();
      logs = logDocs.map((d) => normalize.clockInLog(d, lookup));
    } catch (err) {
      if (err.code !== 'COLLECTION_MISSING') throw err;
    }

    // Related exit windows. The documents carry userId: null, so candidates
    // are pulled for the whole window of interest and then attributed to this
    // user by heartbeat presence at the fence (lib/attribution).
    let exitWindows = [];
    try {
      const ew = await collectionFor('exitWindows');
      const timeClause = {};
      if (agg && agg.firstSeenAt) timeClause.$gte = new Date(agg.firstSeenAt).getTime();
      if (agg && agg.lastSeenAt) timeClause.$lte = new Date(agg.lastSeenAt).getTime() + 60 * 60 * 1000;
      const candidateFilter = [ew.base];
      if (Object.keys(timeClause).length) {
        candidateFilter.push({ $or: [{ openedAt: timeClause }, { userId }] });
      }
      const docs = await ew.col
        .find(F.and(candidateFilter))
        .sort({ openedAt: -1 })
        .limit(200)
        .maxTimeMS(config.queryTimeoutMs)
        .toArray();
      exitWindows = await windowsForUser(docs.map(normalize.exitWindow), userId);
      // Same site match as the Exit Windows page - this tab renders through the
      // same view, so a window must not read "unmapped" in one place and
      // "Site 60" in the other.
      exitWindows = await Promise.all(exitWindows.map((row) => attachWindowSite(row)));
    } catch (err) {
      if (err.code !== 'COLLECTION_MISSING') throw err;
    }

    res.json({
      current,
      raw: redact(latestDoc),
      stats: agg
        ? {
            snapshots: agg.snapshots,
            firstSeenAt: normalize.iso(agg.firstSeenAt),
            lastSeenAt: normalize.iso(agg.lastSeenAt),
            avgAccuracy: geo.round(agg.avgAccuracy, 1),
            bestAccuracy: geo.round(agg.bestAccuracy, 1),
            worstAccuracy: geo.round(agg.worstAccuracy, 1),
            inside: agg.inside,
            outside: agg.outside,
            offline: agg.offline,
            clockedInSnapshots: agg.clockedInSnapshots,
            minBattery: agg.minBattery,
            maxBattery: agg.maxBattery,
            siteIds: (agg.sites || []).filter((s) => s !== null),
            travelledMetres: geo.round(travelled, 1),
          }
        : null,
      track,
      trackLimit: historyLimit,
      trackCeiling: HISTORY_CEILING,
      // Heartbeats actually read out of the store, before the ones with no
      // coordinates were dropped. track.length + trackNoFix === trackFetched.
      trackFetched: history.length,
      trackNoFix,
      trackTruncated: history.length >= historyLimit,
      trackFrom: track.length ? track[0].at : null,
      trackTo: track.length ? track[track.length - 1].at : null,
      logs,
      exitWindows,
      // Only the sites this user actually touched. Null must never match: the
      // registry holds fences with no site id (from exit windows), and a user
      // with unmapped snapshots would otherwise drag them onto their map.
      sites: sites.filter((s) => {
        if (!s.plottable || s.siteId === null || s.siteId === undefined) return false;
        const visited = ((agg && agg.sites) || []).filter((id) => id !== null);
        return current.jobSiteId === s.siteId || visited.includes(s.siteId);
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** Just the breadcrumb trail, for the map. */
router.get('/users/:userId/track', async (req, res, next) => {
  try {
    const userId = req.params.userId === 'anonymous' ? null : Number(req.params.userId);
    const { col, base } = await collectionFor('snapshots');
    const match = F.and([
      base,
      userId === null ? { [SNAP.userId]: null } : { [SNAP.userId]: userId },
      F.snapshotMatch({ ...req.query, userId: undefined }),
      { [SNAP.lat]: { $ne: null } },
    ]);
    const limit = Math.min(Number(req.query.limit) || 1000, 10000);
    const docs = await col
      .find(match, {
        projection: {
          createdAt: 1,
          'currentUserLocation.latitude': 1,
          'currentUserLocation.longitude': 1,
          'currentUserLocation.accuracy': 1,
          isInsideGeofence: 1,
          clockedIn: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .maxTimeMS(config.queryTimeoutMs)
      .toArray();

    res.json({
      userId,
      points: docs
        .reverse()
        .map((d) => ({
          at: normalize.iso(d.createdAt),
          lat: normalize.num(d.currentUserLocation && d.currentUserLocation.latitude),
          lng: normalize.num(d.currentUserLocation && d.currentUserLocation.longitude),
          accuracy: normalize.num(d.currentUserLocation && d.currentUserLocation.accuracy),
          insideGeofence: d.isInsideGeofence === undefined ? null : d.isInsideGeofence,
          clockedIn: d.clockedIn === true,
        }))
        .filter((p) => p.lat !== null),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
