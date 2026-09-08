'use strict';
const express = require('express');
const { ObjectId } = require('mongodb');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const { SNAP, LOG } = F;
const P = require('../lib/pipelines');
const normalize = require('../lib/normalize');
const geo = require('../lib/geo');
const csv = require('../lib/csv');
const { siteLookup, getSites } = require('../lib/sites');
const { redact } = require('../lib/redact');
// The Exit windows tab is the Exit Windows page filtered to one person, so it
// runs that page's query rather than a private one. See lib/exitWindows.js.
const { listWindows } = require('../lib/exitWindows');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

const SORTABLE = [
  'capturedAt',
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
/**
 * Puts the site on a row, from both of the things that know about it.
 *
 * The heartbeat carries the site record the device had at the time
 * (normalize.snapshot reads siteDetails into row.site). The registry carries
 * the current view of that site, with the provenance of its geometry. Both
 * matter and neither replaces the other:
 *
 *  - The NAME and ADDRESS come from the heartbeat when it has them. It is
 *    the answer the app itself gave for that moment, so a site renamed since
 *    does not rewrite what an old row meant.
 *  - The GEOMETRY PROVENANCE comes from the registry, which is the only
 *    thing that knows whether a centre was recorded or estimated.
 *  - A heartbeat from a build that does not send siteDetails yet has only
 *    the id, so it falls back to the registry entirely. Most of this store
 *    is still that, which is why this cannot simply read the row.
 *
 * Where the heartbeat`s fence and the registry`s current fence disagree, the
 * row says so. That is not a bug to smooth over: it means this heartbeat was
 * judged inside-or-outside against a boundary the site no longer has.
 */
function attachSite(row, sites) {
  if (!row) return row;
  const own = row.site || null;
  const site = row.jobSiteId != null ? sites.find((s) => s.siteId === row.jobSiteId) : null;
  if (!own && !site) {
    row.site = null;
    return row;
  }

  const ownFence = own && own.fence ? own.fence : null;
  const nowFence = site && site.lat != null ? { lat: site.lat, lng: site.lng, radius: site.radius } : null;
  // Only claim a move when both are known and both are real records.
  const movedMetres =
    ownFence && nowFence && site && site.hasFence ? geo.round(geo.haversine(ownFence, nowFence), 1) : null;
  const radiusThen = ownFence ? ownFence.radius : null;
  const radiusNow = nowFence ? nowFence.radius : null;

  row.site = {
    siteId: row.jobSiteId,
    // The heartbeat first, the registry second, the id last.
    name: (own && own.name) || (site && site.name) || null,
    label: (own && own.name) || (site && site.label) || 'Site ' + row.jobSiteId,
    address: (own && own.address) || (site && site.address) || null,
    city: (own && own.city) || (site && site.city) || null,
    state: (own && own.state) || (site && site.state) || null,
    country: (own && own.country) || (site && site.country) || null,
    siteAreaId: own && own.siteAreaId != null ? own.siteAreaId : null,
    // The fence this heartbeat was actually judged against, when it said.
    fenceAtHeartbeat: ownFence,
    recordUpdatedAt: (own && own.recordUpdatedAt) || null,
    deletedAt: (own && own.deletedAt) || null,
    // ...and the site as it stands now.
    lat: site ? site.lat : ownFence ? ownFence.lat : null,
    lng: site ? site.lng : ownFence ? ownFence.lng : null,
    radius: site ? site.radius : ownFence ? ownFence.radius : null,
    hasFence: site ? site.hasFence : !!(ownFence && ownFence.radius != null),
    centreSource: site ? site.centreSource : ownFence ? 'site-record' : null,
    radiusSource: site ? site.radiusSource : ownFence && ownFence.radius != null ? 'site-record' : null,
    radiusIsAuthoritative: site ? site.radiusIsAuthoritative : !!(ownFence && ownFence.radius != null),
    centreIsEstimate: site ? site.centreIsEstimate : false,
    centreConfidence: site ? site.centreConfidence : ownFence ? 'recorded' : null,
    // Where the two disagree. Null when there is nothing to compare.
    fenceMovedSinceMetres: movedMetres,
    radiusChanged: radiusThen != null && radiusNow != null && radiusThen !== radiusNow ? { then: radiusThen, now: radiusNow } : null,
    // Which of the two actually answered.
    source: own && site ? 'heartbeat+registry' : own ? 'heartbeat' : 'registry',
  };

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
  const { col, base, name } = await collectionFor('snapshots');
  const match = F.and([base, F.snapshotMatch(q)]);
  const postMatch = F.snapshotPostMatch(q);
  const { limit, page, skip } = F.pagination(q, 50, 500);
  // Same instant the rest of the console is ordered by. latestPerUser already
  // computes it to pick the newest heartbeat per person, so ordering the table
  // by anything else would rank people by when their phone last reached us
  // rather than when they were last actually seen.
  const sort = F.sortSpec(q, SORTABLE, { [P.HEARTBEAT_AT]: -1 });

  const result = await col
    .aggregate(P.latestPerUser({ match, postMatch, sort, skip, limit, collection: name }), opts)
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
      { key: 'site.name', label: 'Site Name', get: (r) => (r.site ? r.site.name || r.site.label : null) },
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
      { key: 'capturedAt', label: 'Last Seen - Fix Time (UTC)' },
      { key: 'receivedAt', label: 'Last Seen - Stored At (UTC)' },
      { key: 'syncLagMinutes', label: 'Sync Lag (min)' },
      { key: 'ageMinutes', label: 'Age (min)' },
      { key: 'permissionsMissing', label: 'Missing Permissions' },
    ]);
    csv.send(res, 'phantom-users.csv', text);
  } catch (err) {
    next(err);
  }
});

/**
 * The fields a sort and the computed columns need, and nothing else.
 *
 * A `$sort` over whole heartbeat documents is a blocking sort of hundreds of
 * megabytes on a wide query, and **this deployment does not honour
 * allowDiskUse** - the same wall `pipelines.latestPerUser` hit, which is what
 * took `/api/stats` down with "Sort exceeded memory limit of 33554432 bytes".
 * Ordering a projection of six small fields instead is the same order for a
 * fraction of the memory, and the page of documents is fetched back by `_id`
 * afterwards.
 */
function sortProjection(sort) {
  const projection = {
    _id: 1,
    // What pipelines.computedFields reads: the accuracy band, and the fix
    // time that ageMinutes is measured from.
    createdAt: 1,
    currentDateTime: 1,
    'currentUserLocation.accuracy': 1,
    'currentUserLocation.capturedAt': 1,
  };
  // Whatever is actually being ordered by. A computed key (ageMinutes,
  // accuracyBand) is absent here and created by the $addFields that follows,
  // which is also the stage order that makes sorting by them work at all -
  // it used to run after the $sort.
  for (const key of Object.keys(sort || {})) projection[key] = 1;
  return projection;
}

/**
 * The documents for one page of ids, in the order the ids came back.
 *
 * `$in` does not preserve order and neither does the storage engine, so the
 * sort would be lost between the two queries if this did not put it back.
 */
/**
 * Down to the id and the keys being ordered by, immediately before the sort.
 *
 * sortProjection has to keep the raw fields the computed sort keys are
 * derived FROM (createdAt and capturedAt for the fix time, accuracy for the
 * band). Once $addFields has produced the keys themselves those sources are
 * dead weight, and they were being carried through the sort - 258 bytes a
 * document instead of about 40.
 *
 * That is what took `/api/snapshots` down once the collection passed ~30,000
 * heartbeats: "Sort exceeded memory limit of 33554432 bytes". Same wall as
 * `/api/stats` hit, and the same reason - this deployment does not honour
 * allowDiskUse, so a blocking sort has a hard ceiling and the only fix is to
 * sort less.
 */
function sortKeysOnly(sort) {
  const projection = { _id: 1 };
  for (const key of Object.keys(sort || {})) projection[key] = 1;
  return projection;
}

async function documentsFor(col, ids) {
  if (!ids.length) return [];
  const docs = await col
    .find({ _id: { $in: ids } })
    .maxTimeMS(config.queryTimeoutMs)
    .toArray();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

/** Paged raw snapshot feed (the activity log view). */
router.get('/snapshots', async (req, res, next) => {
  try {
    const { col, base } = await collectionFor('snapshots');
    const match = F.and([base, F.snapshotMatch(req.query)]);
    const postMatch = F.snapshotPostMatch(req.query);
    const { limit, page, skip } = F.pagination(req.query, 100, 2000);
    // Ordered by when the heartbeat happened, which is the fix time where the
    // device sent one. Not a stored field and not one type across documents, so
    // it is computed into `_heartbeatAt` first - see pipelines.capturedAtExpr for
    // why a plain sort on the raw field would group by BSON type instead of time.
    const sort = F.sortSpec(req.query, SORTABLE, { [P.HEARTBEAT_AT]: -1 });
    // Only when it is actually being sorted on. Sorting by `createdAt` (or by
    // battery, or device) keeps $match+$sort at the front where the index can
    // serve it, which is the difference between a keyed sort and an in-memory
    // one over the whole matched set.
    const byHeartbeatAt = Object.prototype.hasOwnProperty.call(sort, P.HEARTBEAT_AT);

    const result = await col
      .aggregate(
        [
          { $match: match },
          ...(byHeartbeatAt ? [{ $addFields: { [P.HEARTBEAT_AT]: P.heartbeatAtExpr() } }] : []),
          { $project: sortProjection(sort) },
          { $addFields: P.computedFields },
          // Ahead of the sort and the paging, so it narrows the set rather than
          // the page - `total` used to count rows this had not been applied to.
          { $match: postMatch },
          // Nothing but the id and the sort keys from here on.
          { $project: sortKeysOnly(sort) },
          {
            $facet: {
              // The $sort lives INSIDE the branch, next to its $limit. A $facet
              // between the two stops the planner bounding the sort to the page
              // it needs (top-k), so it materialised all 34,000 documents and
              // blew the 32 MB ceiling. Adjacent, the bound is skip+limit, and
              // a skip past the end of the collection costs nothing.
              rows: [{ $sort: sort }, { $skip: skip }, { $limit: limit }, { $project: { _id: 1 } }],
              // No sort here: counting is order-independent, and adding one
              // would reintroduce exactly the unbounded sort this removes.
              total: [{ $count: 'value' }],
            },
          },
        ],
        opts
      )
      .next();

    const docs = await documentsFor(col, (result.rows || []).map((r) => r._id));
    const sites = await getSites();
    res.json({
      rows: docs.map((d) => attachSite(normalize.snapshot(d), sites)),
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
    // Same order as the table this is exported from. Sorting on `createdAt` here
    // while the table sorts on the fix time meant the CSV rows came out in a
    // different order from the rows on screen.
    const ordering = { [P.HEARTBEAT_AT]: -1 };
    const ids = await col
      .aggregate(
        [
          { $match: match },
          { $addFields: { [P.HEARTBEAT_AT]: P.heartbeatAtExpr() } },
          // Same reason as the paged feed: the sort has to run on a projection,
          // not on whole documents, or a wide export exceeds the 32 MB sort
          // budget this cluster will not spill to disk. The sort key is already
          // on the document by here, so nothing else needs to travel with it.
          { $project: sortKeysOnly(ordering) },
          // Adjacent to its $limit, which is what lets the planner bound the
          // sort to `limit` documents instead of the whole matched set.
          { $sort: ordering },
          { $limit: limit },
          { $project: { _id: 1 } },
        ],
        opts
      )
      // The row cap is the $limit stage and the time cap is in `opts`, so neither
      // is repeated on the cursor.
      .toArray();
    const docs = await documentsFor(
      col,
      ids.map((r) => r._id)
    );
    const sites = await getSites();
    const rows = docs.map((d) => attachSite(normalize.snapshot(d), sites));
    const text = csv.toCsv(rows, [
      { key: 'capturedAt', label: 'Captured At - Fix Time (UTC)' },
      { key: 'capturedAtSource', label: 'Time Source' },
      { key: 'receivedAt', label: 'Stored At (UTC)' },
      { key: 'syncLagMinutes', label: 'Sync Lag (min)' },
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
      { key: 'site.name', label: 'Site Name', get: (r) => (r.site ? r.site.name || r.site.label : null) },
      { key: 'site.address', label: 'Site Address', get: (r) => (r.site ? r.site.address : null) },
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

/**
 * One heartbeat, as it is actually stored.
 *
 * The tables and the drawer carry the normalized row, which is a deliberate
 * reading of the document: `capturedAt` is really `createdAt`, a location is
 * lifted out of `currentUserLocation`, a verdict is recomputed rather than
 * taken. When a number looks wrong the next question is always what the
 * normalizer was working from - a field it does not surface, a shape that
 * changed under it - and that can only be answered by the document.
 *
 * Fetched one at a time rather than embedded in /snapshots: these documents
 * carry the whole employee record, so a hundred of them per page would be
 * megabytes of something almost nobody opens.
 */
router.get('/snapshots/:id', async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Not a document id' });
    }
    const { col, base } = await collectionFor('snapshots');
    // `base` keeps the kinds apart: this collection also holds exit windows,
    // and a heartbeat lookup must not hand one back.
    const doc = await col.findOne(F.and([base, { _id: new ObjectId(req.params.id) }]), {
      maxTimeMS: config.queryTimeoutMs,
    });
    if (!doc) return res.status(404).json({ error: 'No heartbeat with that document id' });
    const sites = await getSites();
    res.json({ id: String(doc._id), row: attachSite(normalize.snapshot(doc), sites), raw: redact(doc) });
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
    // Exit windows are attributed to a person AFTER they come out of Mongo, so
    // the user filter cannot be part of the query and this limit is applied to
    // windows from everybody. Asking for the pager's maximum keeps a person's
    // windows from falling off the end of a page they never chose.
    const EXIT_WINDOW_CANDIDATES = 500;
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
            // Read by heartbeatTime() as the middle fallback clock. Not projecting
            // it silently skipped that step, so a heartbeat with no fix time but a
            // good device clock got its ARRIVAL time on the trail while the table
            // beside it showed the device clock. It is not returned, only used.
            currentDateTime: 1,
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
            // First/last seen describe when the person was seen, so they run on
            // the same instant the Users table now orders by.
            { $addFields: { [P.HEARTBEAT_AT]: P.heartbeatAtExpr() } },
            {
              $group: {
                _id: null,
                snapshots: { $sum: 1 },
                firstSeenAt: { $min: '$' + P.HEARTBEAT_AT },
                lastSeenAt: { $max: '$' + P.HEARTBEAT_AT },
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
          // The fix time, not the arrival time (see normalize.heartbeatTime).
          at: normalize.heartbeatTime(d).at,
          lat: normalize.num(loc.latitude),
          lng: normalize.num(loc.longitude),
          accuracy: normalize.num(loc.accuracy),
          insideGeofence: d.isInsideGeofence === undefined ? null : d.isInsideGeofence,
          clockedIn: d.clockedIn === true,
          battery: normalize.num(d.batteryPercentage),
        };
      });
    // Sorted by the fix time, not left in the order Mongo returned.
    //
    // The query sorts on `createdAt` because that is what is indexed, but the
    // trail is now drawn on fix time - and for heartbeats that synced late the
    // two orders differ. Left as-is the trail would zig-zag back and forth
    // through time, and every gap and speed between consecutive points would
    // be computed from the wrong pair.
    const track = trackAll
      .filter((p) => p.lat !== null && p.lng !== null && p.at)
      .sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
    // Counted on its own terms: the filter above also drops the (vanishingly
    // rare) heartbeat with no readable timestamp, and the note under the map
    // attributes this number specifically to missing coordinates.
    const trackNoFix = trackAll.filter((p) => p.lat === null || p.lng === null).length;

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

    // Related exit windows.
    //
    // This tab renders through the Exit Windows page's own table and drawer, so
    // it is that page filtered to one person - and it now runs that page's query
    // to prove it. It used to run a private one that read no filter at all: the
    // only bound was a time range derived from this user's own heartbeat span,
    // widened by an hour. So the date range on the bar did nothing here, neither
    // did status, resolution, site, device, the sample thresholds or the where
    // clause, and the tab answered a different question from the one the rest of
    // the page was answering.
    //
    // The user filter is deliberately not part of the Mongo query: these
    // documents carry userId: null, so a window is joined to a person by
    // matching its GPS samples against heartbeats (lib/attribution). listWindows
    // applies it in the right place, after that join.
    let exitWindows = [];
    let exitWindowsTruncated = false;
    // `anonymous` is not a person, and attribution can only name people. This
    // has always returned nothing; it now returns nothing without paying for a
    // scan and an attribution pass to find that out.
    if (userId !== null) {
      try {
        // The sort is pinned rather than passed through. `sortBy` on this page
        // belongs to the Heartbeats table, and the candidate pool is cut to a
        // fixed size before anyone is attributed to it - so which windows get
        // considered at all depends on this order, and the truncation warning
        // says "the most recent". Newest first is the only honest reading.
        const found = await listWindows({
          ...req.query,
          userId,
          page: 1,
          limit: EXIT_WINDOW_CANDIDATES,
          sortBy: undefined,
          sortDir: undefined,
        });
        exitWindows = found.rows;
        // Windows matching the filters, before attribution narrowed them to this
        // person. More than one page of them means some were never considered.
        exitWindowsTruncated = found.total > EXIT_WINDOW_CANDIDATES;
      } catch (err) {
        if (err.code !== 'COLLECTION_MISSING') throw err;
      }
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
      exitWindowsTruncated,
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
/**
 * The breadcrumb trail, for any filter the bar can express.
 *
 * The user page's map had this to itself as part of /users/:id, which is why
 * the Heartbeats page's map could only draw one page of the table - 100 fat
 * rows, no Fixes control, and no idea what it was short of. The trail panel is
 * shared between the two pages now, so its data source is too.
 *
 * `noFix` is why this deliberately does NOT filter out heartbeats without
 * coordinates in Mongo. A heartbeat that arrived with no fix is still a
 * heartbeat, it is still in every count above the map, and "some of my
 * heartbeats are missing" is answered by naming that number - which is
 * impossible if the query silently dropped them.
 */
const TRACK_CEILING = 100000;
const DEFAULT_TRACK_LIMIT = 5000;

async function buildTrack(query, extraMatch) {
  const { col, base } = await collectionFor('snapshots');
  const match = F.and([base, extraMatch || null, F.snapshotMatch(query)]);
  const limit = Math.max(1, Math.min(Number(query.limit) || DEFAULT_TRACK_LIMIT, TRACK_CEILING));

  // Sorted and limited on `createdAt` because that is the indexed field, and
  // this is "the newest N in range" - a question arrival order answers. The
  // points are then reordered by fix time below, which is a different order for
  // anything that synced late and the only one a path may be drawn in.
  const docs = await col
    .find(match, {
      projection: {
        createdAt: 1,
        // Read by heartbeatTime() as the middle fallback clock. Omitting it
        // silently skips that step and puts an arrival time on the trail.
        currentDateTime: 1,
        currentUserLocation: 1,
        isInsideGeofence: 1,
        clockedIn: 1,
        batteryPercentage: 1,
        'currentUser.data.id': 1,
        'currentUser.data.fullName': 1,
        // Which fences to send back. /api/meta lists sites but without
        // coordinates, so a caller drawing a map cannot get them from there.
        [SNAP.jobSiteId]: 1,
        [SNAP.jobSiteIdAlt]: 1,
      },
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .maxTimeMS(config.queryTimeoutMs)
    .toArray();

  // Names are sent once in a lookup rather than on every point. At the top of
  // this limit that is 100,000 repetitions of the same string saved.
  const names = new Map();
  const siteIds = new Set();
  const all = docs.map((d) => {
    const loc = d.currentUserLocation || {};
    const user = (d.currentUser && d.currentUser.data) || {};
    const userId = normalize.num(user.id);
    if (userId !== null && !names.has(userId)) names.set(userId, user.fullName || null);
    const jobSiteId =
      normalize.num((d.clockedInJobDetail || {}).jobSiteId) !== null
        ? normalize.num((d.clockedInJobDetail || {}).jobSiteId)
        : normalize.num((d.clockedInJobSiteLocation || {}).jobSiteId);
    if (jobSiteId !== null) siteIds.add(jobSiteId);
    return {
      // The fix time, not the arrival time (see normalize.heartbeatTime).
      at: normalize.heartbeatTime(d).at,
      lat: normalize.num(loc.latitude),
      lng: normalize.num(loc.longitude),
      accuracy: normalize.num(loc.accuracy),
      insideGeofence: d.isInsideGeofence === undefined ? null : d.isInsideGeofence,
      clockedIn: d.clockedIn === true,
      battery: normalize.num(d.batteryPercentage),
      userId,
    };
  });

  const points = all
    .filter((p) => p.lat !== null && p.lng !== null && p.at)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  // Counted on its own terms: the filter above also drops the (vanishingly
  // rare) heartbeat with no readable timestamp, and the note under the map
  // attributes this number specifically to missing coordinates.
  const noFix = all.filter((p) => p.lat === null || p.lng === null).length;

  const streams = new Set(points.map((p) => p.userId)).size;
  // Distance travelled is a per-device measure. Summed across a fleet it is the
  // total of several unrelated journeys plus the gaps between them, which is not
  // a number about anything - so it is only offered for a single stream.
  let travelledMetres = null;
  if (streams <= 1) {
    travelledMetres = 0;
    for (let i = 1; i < points.length; i += 1) {
      const d = geo.haversine(points[i - 1], points[i]);
      if (d !== null) travelledMetres += d;
    }
    travelledMetres = geo.round(travelledMetres, 1);
  }

  // Only the fences these heartbeats actually touched. Null must never match:
  // the registry holds fences with no site id (they come from exit windows),
  // and sending those would drag unrelated circles onto the map.
  let sites = [];
  try {
    sites = (await getSites()).filter(
      (site) => site.plottable && site.siteId !== null && site.siteId !== undefined && siteIds.has(site.siteId)
    );
  } catch (err) {
    /* a map without its fences is still a map; the registry is best-effort */
  }

  return {
    points,
    sites,
    users: [...names.entries()].map(([userId, name]) => ({ userId, name })),
    limit,
    ceiling: TRACK_CEILING,
    // Heartbeats read out of the store, before the ones with no coordinates
    // were dropped: points.length + noFix === fetched, minus any with no clock.
    fetched: all.length,
    noFix,
    truncated: all.length >= limit,
    from: points.length ? points[0].at : null,
    to: points.length ? points[points.length - 1].at : null,
    streams,
    travelledMetres,
  };
}

router.get('/track', async (req, res, next) => {
  try {
    res.json(await buildTrack(req.query));
  } catch (err) {
    next(err);
  }
});

/**
 * One person, same builder.
 *
 * This had its own copy, which read `createdAt` as the heartbeat's time. For a
 * device that synced a backlog late that is hours away from when the fix was
 * taken, so the trail it returned zig-zagged back and forth through time and
 * every gap along it was measured between the wrong pair of points. Sharing the
 * builder fixes that here too - the Live Map trails are the caller.
 */
router.get('/users/:userId/track', async (req, res, next) => {
  try {
    const userId = req.params.userId === 'anonymous' ? null : Number(req.params.userId);
    const data = await buildTrack(
      { ...req.query, userId: undefined },
      userId === null ? { [SNAP.userId]: null } : { [SNAP.userId]: userId }
    );
    res.json({ userId, ...data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
