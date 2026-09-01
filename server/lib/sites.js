'use strict';
const { collectionFor } = require('../db');
const config = require('../config');
const geo = require('./geo');
const { LOG, SNAP, dateRange } = require('./filters');

/**
 * Builds the geofence site registry.
 *
 * The one rule this file exists to enforce: geometry is only ever presented as
 * a fence when a fence was actually on record. Three sources feed it, and they
 * are NOT interchangeable -
 *
 *   1. validateClockInLogs  the only authoritative geometry. The site's centre,
 *                           radius and address are embedded on every validation
 *                           call, so the newest call carries the current fence
 *                           and older calls carry the fence as it was.
 *   2. ekosClientState      heartbeats. No geometry at all in this database
 *                           (clockedInJobSiteLocation.latitude is null on every
 *                           document), so a site seen only here gets an
 *                           ESTIMATED centre - the centroid of recent fixes
 *                           taken inside the fence - and no radius, ever.
 *   3. exit_window docs     carry fence lat/lng/radius but no site id. They can
 *                           confirm a fence whose radius already agrees; they
 *                           may NOT hand a radius to a site that has none,
 *                           because a 20 m and a 100 m fence sit on the same
 *                           spot here. Those become candidates: listed and
 *                           labelled, never silently adopted.
 *
 * Every geometry field therefore travels with its provenance - centreSource,
 * radiusSource - and hasFence means "the geofence log had a fence", nothing
 * looser.
 */

// The registry is cached per date range, because estimated centres are scoped
// to the requested window (the authoritative ones are not).
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_KEYS = 16;
const cache = new Map();

/**
 * How close two fence centres must be to be treated as the same fence. GPS-era
 * fence definitions jitter by a few metres between writes; 30 m keeps those
 * together without merging genuinely different sites.
 */
const FENCE_MATCH_METRES = 30;

/** Two radii are the same rule within 20%, floor 5 m. */
const RADIUS_TOLERANCE = (r) => Math.max(5, r * 0.2);

/**
 * How far a time bucket's centroid may sit from the running centroid and still
 * be the same place. Beyond this the site was moved (or its id reused), so the
 * older fixes describe a different location and must not be averaged in.
 */
const CENTRE_CLUSTER_METRES = 75;

/** Fewer inside-fixes than this behind an estimated centre and it is guesswork. */
const CENTRE_MIN_FIXES = 5;

async function getSites({ force = false, from = null, to = null } = {}) {
  const key = (from || '') + '|' + (to || '');
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.sites;

  const byId = new Map();

  await authoritativeFences(byId);
  await estimatedCentres(byId, { from, to });
  await exitWindowFences(byId);

  const sites = [...byId.values()].map(finalise).sort(byActivity);

  if (cache.size >= CACHE_MAX_KEYS) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), sites });
  return sites;
}

// ---------------------------------------------------------------------------
// 1. authoritative fences, with their edit history
// ---------------------------------------------------------------------------

/**
 * Grouped by site AND geometry, so a site whose location was edited comes back
 * as several revisions instead of one blurred row. The revision embedded in the
 * newest validation call is the current fence; the rest are history, and the
 * jump between them is what "the site was moved" looks like in this data.
 */
async function authoritativeFences(byId) {
  let rows;
  try {
    const { col } = await collectionFor('clockInLogs');
    rows = await col
      .aggregate(
        [
          { $match: { [LOG.siteId]: { $ne: null } } },
          {
            $group: {
              _id: {
                siteId: '$' + LOG.siteId,
                lat: '$siteAreaData.siteArea.locations.latitude',
                lng: '$siteAreaData.siteArea.locations.longitude',
                radius: '$' + LOG.radius,
                updatedAt: '$siteAreaData.siteArea.locations.updatedAt',
              },
              address: { $first: '$' + LOG.address },
              city: { $first: '$siteAreaData.siteArea.locations.city' },
              state: { $first: '$siteAreaData.siteArea.locations.state' },
              country: { $first: '$siteAreaData.siteArea.locations.country' },
              zipCode: { $first: '$siteAreaData.siteArea.locations.zipCode' },
              validations: { $sum: 1 },
              firstValidationAt: { $min: '$createdAt' },
              lastValidationAt: { $max: '$createdAt' },
              outsideEvents: { $sum: { $cond: [{ $eq: ['$' + LOG.actual, false] }, 1, 0] } },
              graceEvents: {
                $sum: {
                  $cond: [{ $and: [{ $eq: ['$' + LOG.within, true] }, { $eq: ['$' + LOG.actual, false] }] }, 1, 0],
                },
              },
              clockOutEvents: { $sum: { $cond: [{ $eq: ['$' + LOG.clockOut, true] }, 1, 0] } },
              accuracySum: { $sum: '$' + LOG.accuracy },
              accuracyCount: { $sum: { $cond: [{ $gt: ['$' + LOG.accuracy, null] }, 1, 0] } },
              worstAccuracy: { $max: '$' + LOG.accuracy },
              effectiveRadius: { $max: '$' + LOG.effectiveRadius },
              users: { $addToSet: '$userId' },
            },
          },
          { $sort: { lastValidationAt: -1 } },
        ],
        { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs }
      )
      .toArray();
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') return;
    throw err;
  }

  const bySite = new Map();
  for (const r of rows) {
    const list = bySite.get(r._id.siteId) || [];
    list.push(r);
    bySite.set(r._id.siteId, list);
  }

  for (const [siteId, group] of bySite) {
    // Already newest-first from the pipeline sort.
    const current = group[0];
    const totals = group.reduce(
      (a, r) => {
        a.validations += r.validations;
        a.outsideEvents += r.outsideEvents;
        a.graceEvents += r.graceEvents;
        a.clockOutEvents += r.clockOutEvents;
        a.accuracySum += r.accuracySum || 0;
        a.accuracyCount += r.accuracyCount || 0;
        a.worstAccuracy = Math.max(a.worstAccuracy, r.worstAccuracy || 0);
        a.effectiveRadius = Math.max(a.effectiveRadius, r.effectiveRadius || 0);
        for (const u of r.users || []) if (u !== null) a.users.add(u);
        return a;
      },
      {
        validations: 0,
        outsideEvents: 0,
        graceEvents: 0,
        clockOutEvents: 0,
        accuracySum: 0,
        accuracyCount: 0,
        worstAccuracy: 0,
        effectiveRadius: 0,
        users: new Set(),
      }
    );

    const revisions = group.map((r) => ({
      lat: geo.round(r._id.lat, 7),
      lng: geo.round(r._id.lng, 7),
      radius: geo.round(r._id.radius, 2),
      recordUpdatedAt: r._id.updatedAt || null,
      address: r.address || null,
      validations: r.validations,
      firstSeenAt: r.firstValidationAt || null,
      lastSeenAt: r.lastValidationAt || null,
    }));

    // A move is the distance from the fence that stopped being used - not from
    // every past position it ever had.
    const previous = revisions[1] || null;
    const movedMetres = previous ? geo.round(geo.haversine(previous, revisions[0]), 1) : null;

    byId.set(siteId, {
      siteId,
      source: 'geofence-log',
      centreSource: 'geofence-log',
      radiusSource: current._id.radius != null ? 'geofence-log' : null,
      lat: geo.round(current._id.lat, 7),
      lng: geo.round(current._id.lng, 7),
      radius: geo.round(current._id.radius, 2),
      effectiveRadius: totals.effectiveRadius || null,
      address: current.address || null,
      city: current.city || null,
      state: current.state || null,
      country: current.country || null,
      zipCode: current.zipCode || null,
      updatedAt: current._id.updatedAt || null,
      fenceRevisions: revisions.length,
      fenceHistory: revisions.length > 1 ? revisions : null,
      fenceMovedMetres: movedMetres,
      fenceMovedAt: previous ? revisions[0].firstSeenAt : null,
      geometryValidFrom: revisions[0].firstSeenAt || null,
      validations: totals.validations,
      lastValidationAt: current.lastValidationAt || null,
      outsideEvents: totals.outsideEvents,
      graceEvents: totals.graceEvents,
      clockOutEvents: totals.clockOutEvents,
      avgAccuracy: totals.accuracyCount ? geo.round(totals.accuracySum / totals.accuracyCount, 1) : null,
      worstAccuracy: totals.worstAccuracy || null,
      userIds: [...totals.users],
    });
  }
}

// ---------------------------------------------------------------------------
// 2. estimated centres from heartbeats
// ---------------------------------------------------------------------------

/**
 * Activity counts for every site, plus an estimated centre for the ones with no
 * fence on record.
 *
 * The estimate is deliberately not an average of everything ever stored. Fixes
 * are bucketed by time, walked newest-first, and stopped at the first bucket
 * that jumps more than CENTRE_CLUSTER_METRES from the running centroid - so if
 * the site was moved, only the fixes from where it is NOW contribute, and the
 * jump is reported instead of being averaged into a point that was never a
 * place. Everything here is scoped to the caller's date range.
 */
async function estimatedCentres(byId, { from, to }) {
  const range = dateRange({ from, to }, 'createdAt');
  const bucket = bucketExpression(from, to);

  let rows;
  try {
    const { col, base } = await collectionFor('snapshots');
    const siteField = { $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt] };
    rows = await col
      .aggregate(
        [
          { $match: range ? { ...base, ...range } : base },
          { $addFields: { _siteId: siteField } },
          { $match: { _siteId: { $ne: null } } },
          {
            $group: {
              _id: { site: '$_siteId', bucket: bucket.expr },
              snapshots: { $sum: 1 },
              users: { $addToSet: '$' + SNAP.userId },
              tenantIds: { $addToSet: '$' + SNAP.tenantId },
              lastSeenAt: { $max: '$createdAt' },
              insideCount: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', true] }, 1, 0] } },
              outsideCount: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', false] }, 1, 0] } },
              accuracySum: { $sum: '$' + SNAP.accuracy },
              accuracyCount: { $sum: { $cond: [{ $gt: ['$' + SNAP.accuracy, null] }, 1, 0] } },
              // centroid candidates: fixes taken while inside the fence, with
              // any fix at all as the fallback when nothing was flagged inside
              fixLat: { $avg: { $cond: [{ $eq: ['$isInsideGeofence', true] }, '$' + SNAP.lat, null] } },
              fixLng: { $avg: { $cond: [{ $eq: ['$isInsideGeofence', true] }, '$' + SNAP.lng, null] } },
              fixCount: {
                $sum: {
                  $cond: [{ $and: [{ $eq: ['$isInsideGeofence', true] }, { $gt: ['$' + SNAP.lat, null] }] }, 1, 0],
                },
              },
              anyLat: { $avg: '$' + SNAP.lat },
              anyLng: { $avg: '$' + SNAP.lng },
              anyCount: { $sum: { $cond: [{ $gt: ['$' + SNAP.lat, null] }, 1, 0] } },
            },
          },
          { $sort: { '_id.bucket': -1 } },
        ],
        { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs }
      )
      .toArray();
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') return;
    throw err;
  }

  const bySite = new Map();
  for (const r of rows) {
    const list = bySite.get(r._id.site) || [];
    list.push(r);
    bySite.set(r._id.site, list);
  }

  for (const [siteId, buckets] of bySite) {
    const existing = byId.get(siteId) || { siteId, source: 'derived', centreSource: null, radiusSource: null };
    const totals = buckets.reduce(
      (a, b) => {
        a.snapshots += b.snapshots;
        a.inside += b.insideCount;
        a.outside += b.outsideCount;
        a.accuracySum += b.accuracySum || 0;
        a.accuracyCount += b.accuracyCount || 0;
        if (!a.lastSeenAt || (b.lastSeenAt && b.lastSeenAt > a.lastSeenAt)) a.lastSeenAt = b.lastSeenAt;
        for (const u of b.users || []) if (u !== null) a.users.add(u);
        for (const t of b.tenantIds || []) if (t !== null) a.tenants.add(t);
        return a;
      },
      {
        snapshots: 0,
        inside: 0,
        outside: 0,
        accuracySum: 0,
        accuracyCount: 0,
        lastSeenAt: null,
        users: new Set(),
        tenants: new Set(),
      }
    );

    const estimate = clusterCentre(buckets);

    const row = {
      ...existing,
      snapshots: totals.snapshots,
      activeUserIds: [...totals.users],
      tenantIds: [...totals.tenants],
      lastSeenAt: totals.lastSeenAt || existing.lastValidationAt || null,
      insideSnapshots: totals.inside,
      outsideSnapshots: totals.outside,
      snapshotAvgAccuracy: totals.accuracyCount ? geo.round(totals.accuracySum / totals.accuracyCount, 1) : null,
      centreEstimate: estimate
        ? {
            lat: geo.round(estimate.lat, 7),
            lng: geo.round(estimate.lng, 7),
            fixes: estimate.fixes,
            fixesTotal: estimate.fixesTotal,
            fromInsideFixes: estimate.fromInside,
            windowFrom: estimate.windowFrom,
            windowTo: estimate.windowTo,
            bucketsUsed: estimate.bucketsUsed,
            bucketsAvailable: buckets.length,
            granularity: bucket.granularity,
            spreadMetres: estimate.spread,
            // a second location with real weight behind it - the estimate is
            // not a single answer and must not be shown as one
            disputed: estimate.disputed,
            alternates: estimate.alternates,
          }
        : null,
    };

    // Only a site with no recorded centre falls back to the estimate for the
    // point that gets plotted. An authoritative centre is never overwritten.
    if (row.lat == null && estimate) {
      row.lat = geo.round(estimate.lat, 7);
      row.lng = geo.round(estimate.lng, 7);
      row.centreSource = 'estimate';
    }
    if (row.radius === undefined) row.radius = null;

    byId.set(siteId, row);
  }
}

/** Hourly buckets for short ranges, daily for long ones, so a year stays cheap. */
function bucketExpression(from, to) {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  const spanDays =
    start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) ? (end - start) / 86400000 : null;
  const hourly = spanDays !== null && spanDays <= 7;
  return {
    granularity: hourly ? 'hour' : 'day',
    expr: { $dateToString: { date: '$createdAt', format: hourly ? '%Y-%m-%dT%H' : '%Y-%m-%d' } },
  };
}

/**
 * Groups the time buckets by location and returns the biggest group.
 *
 * Deliberately not "newest wins". Devices report the wrong site all the time -
 * a phone clocked into site 60 while standing at site 12 puts six fixes 5 km
 * away - and if the newest bucket seeds the centre, those six become the site.
 * Weight of evidence decides instead, and a second location holding a real
 * share of the fixes is reported as a dispute rather than silently discarded or
 * averaged in. An estimate with two credible answers should say so.
 *
 * Fixes taken while inside the fence are used exclusively when any exist: a fix
 * from outside the fence says where a person was, not where the fence is.
 */
function clusterCentre(buckets) {
  const mapped = buckets
    .map((b) => {
      const inside = b.fixCount > 0 && Number.isFinite(b.fixLat);
      const lat = inside ? b.fixLat : b.anyLat;
      const lng = inside ? b.fixLng : b.anyLng;
      const n = inside ? b.fixCount : b.anyCount;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !n) return null;
      return { lat, lng, n, inside, at: b._id.bucket };
    })
    .filter(Boolean);
  if (!mapped.length) return null;

  const insideOnly = mapped.filter((b) => b.inside);
  const series = insideOnly.length ? insideOnly : mapped;
  const clusters = groupByLocation(series);
  if (!clusters.length) return null;

  const total = clusters.reduce((sum, c) => sum + c.fixes, 0);
  const main = clusters[0];
  const others = clusters.slice(1);
  // A rival location is a dispute when it carries real weight, not one stray fix.
  const rival = others[0] || null;
  const disputed = !!rival && rival.fixes >= Math.max(CENTRE_MIN_FIXES, total * 0.25);

  return {
    lat: main.lat,
    lng: main.lng,
    fixes: main.fixes,
    fixesTotal: total,
    fromInside: insideOnly.length > 0,
    bucketsUsed: main.buckets,
    windowFrom: main.windowFrom,
    windowTo: main.windowTo,
    spread: main.spread,
    disputed,
    alternates: others.map((c) => ({
      lat: geo.round(c.lat, 7),
      lng: geo.round(c.lng, 7),
      fixes: c.fixes,
      metresAway: geo.round(geo.haversine(main, c), 1),
      windowFrom: c.windowFrom,
      windowTo: c.windowTo,
    })),
  };
}

/**
 * Greedy proximity grouping, seeded from the buckets with the most fixes so a
 * cluster never forms around a single noisy reading.
 */
function groupByLocation(series) {
  const clusters = [];
  for (const b of [...series].sort((x, y) => y.n - x.n)) {
    let target = null;
    for (const c of clusters) {
      const distance = geo.haversine({ lat: c.sumLat / c.n, lng: c.sumLng / c.n }, b);
      if (distance !== null && distance <= CENTRE_CLUSTER_METRES) {
        target = c;
        break;
      }
    }
    if (!target) {
      target = { sumLat: 0, sumLng: 0, n: 0, members: [] };
      clusters.push(target);
    }
    target.sumLat += b.lat * b.n;
    target.sumLng += b.lng * b.n;
    target.n += b.n;
    target.members.push(b);
  }

  return clusters
    .map((c) => {
      const centre = { lat: c.sumLat / c.n, lng: c.sumLng / c.n };
      const times = c.members.map((m) => m.at).sort();
      return {
        ...centre,
        fixes: c.n,
        buckets: c.members.length,
        windowFrom: times[0],
        windowTo: times[times.length - 1],
        spread: geo.round(
          c.members.reduce((max, m) => Math.max(max, geo.haversine(centre, m) || 0), 0),
          1
        ),
      };
    })
    .sort((x, y) => y.fixes - x.fixes);
}
// ---------------------------------------------------------------------------
// 3. fences carried by exit-window documents
// ---------------------------------------------------------------------------

/**
 * Exit windows carry a fence but no site id, so the link is made by coordinates.
 * A fence may CONFIRM a site whose recorded radius already agrees; it may not
 * give a radius to a site that has none. Several fences of different sizes sit
 * on the same spot in this data, so adopting one would be picking a rule at
 * random - they get attached as candidates instead.
 */
async function exitWindowFences(byId) {
  let rows;
  try {
    const { col, base } = await collectionFor('exitWindows');
    rows = await col
      .aggregate(
        [
          { $match: { ...base, 'fence.lat': { $ne: null } } },
          {
            // Group by the fence itself: these documents carry coordinates but
            // no site id, and there is more than one fence in play.
            $group: {
              _id: {
                siteId: { $ifNull: ['$jobSiteId', '$fence.siteId'] },
                lat: '$fence.lat',
                lng: '$fence.lng',
                radius: '$fence.radius',
              },
              exitWindows: { $sum: 1 },
              lastExitAt: { $max: '$openedAt' },
              clockOuts: { $sum: { $cond: [{ $eq: ['$resolution', 'closed_clockout'] }, 1, 0] } },
              openWindows: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
              tenantIds: { $addToSet: { $ifNull: ['$companyId', '$tenantId'] } },
            },
          },
          { $sort: { exitWindows: -1 } },
        ],
        { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs }
      )
      .toArray();
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') return;
    throw err;
  }

  const known = [...byId.values()].filter((s) => s.lat != null && s.lng != null);
  const clusters = [];

  for (const r of rows) {
    const fence = { lat: r._id.lat, lng: r._id.lng, radius: r._id.radius };
    const stats = {
      exitWindows: r.exitWindows,
      lastExitAt: r.lastExitAt || null,
      exitClockOuts: r.clockOuts,
      openExitWindows: r.openWindows,
      tenantIds: (r.tenantIds || []).filter((t) => t !== null),
    };

    // An explicit site id is the document's own claim about which site this
    // fence belongs to, and the only case where it may supply geometry.
    if (r._id.siteId != null) {
      addFence(byId, r._id.siteId, fence, stats, { stated: true });
      continue;
    }

    const match = matchSite(fence, known);
    if (match) {
      addFence(byId, match.siteId != null ? match.siteId : keyFor(match), fence, stats, {
        byCoordinates: true,
        confirms: match.radiusAgrees,
        matchDistance: match.matchDistance,
        matchedAgainstEstimate: match.centreSource === 'estimate',
      });
      continue;
    }

    // Leftovers: group fences that are effectively the same one. These belong to
    // no site, so the fence record IS the row and its radius is real.
    const cluster = clusters.find(
      (c) => sameFence(c.fence, fence) && geo.haversine(c.fence, fence) <= FENCE_MATCH_METRES
    );
    if (cluster) {
      cluster.stats.exitWindows += stats.exitWindows;
      cluster.stats.exitClockOuts += stats.exitClockOuts;
      cluster.stats.openExitWindows += stats.openExitWindows;
      cluster.stats.variants += 1;
      cluster.stats.lastExitAt = laterOf(cluster.stats.lastExitAt, stats.lastExitAt);
    } else {
      clusters.push({ fence, stats: { ...stats, variants: 1 } });
    }
  }

  for (const cluster of clusters) {
    const key = keyFor(cluster.fence);
    const existing = byId.get(key) || { siteId: null, source: 'exit-window' };
    byId.set(key, {
      ...existing,
      ...cluster.stats,
      centreSource: 'exit-window',
      radiusSource: 'exit-window',
      lat: geo.round(cluster.fence.lat, 7),
      lng: geo.round(cluster.fence.lng, 7),
      radius: geo.round(cluster.fence.radius, 2),
      exitFence: rounded(cluster.fence),
    });
  }
}

/**
 * Records an exit-window fence against a site: accumulating its counts, since
 * several fences can point at one site, and listing the fence as a candidate
 * unless the site's own radius already agrees with it.
 */
function addFence(byId, key, fence, stats, how) {
  const existing = byId.get(key) || {
    siteId: typeof key === 'number' ? key : null,
    source: 'exit-window',
    centreSource: null,
    radiusSource: null,
  };

  const candidate = {
    ...rounded(fence),
    exitWindows: stats.exitWindows,
    lastExitAt: stats.lastExitAt,
    matchDistance: how.matchDistance != null ? how.matchDistance : null,
    linkedBy: how.stated ? 'document' : 'coordinates',
    agreesWithRecord: !!how.confirms,
    matchedAgainstEstimate: !!how.matchedAgainstEstimate,
  };

  const row = {
    ...existing,
    // accumulate - one site can be the subject of several fence variants
    exitWindows: (existing.exitWindows || 0) + stats.exitWindows,
    exitClockOuts: (existing.exitClockOuts || 0) + stats.exitClockOuts,
    openExitWindows: (existing.openExitWindows || 0) + stats.openExitWindows,
    lastExitAt: laterOf(existing.lastExitAt, stats.lastExitAt),
    tenantIds: [...new Set([...(existing.tenantIds || []), ...(stats.tenantIds || [])])],
    candidateFences: [...(existing.candidateFences || []), candidate],
  };

  // A stated site id may supply geometry the site is missing. A coordinate match
  // may not: it was found BY the very geometry it would be filling in.
  if (how.stated) {
    if (row.lat == null) {
      row.lat = geo.round(fence.lat, 7);
      row.lng = geo.round(fence.lng, 7);
      row.centreSource = 'exit-window';
    }
    if (row.radius == null && Number.isFinite(fence.radius)) {
      row.radius = geo.round(fence.radius, 2);
      row.radiusSource = 'exit-window';
    }
  }

  if (how.confirms) row.fenceConfirmedByExitWindow = true;
  row.exitFence = rounded(fence);
  byId.set(key, row);
}

/**
 * Same fence only if the radius agrees too - a 20 m and a 100 m fence at the
 * same spot are different rules, not the same place. An unknown radius on
 * either side is NOT agreement: it is the absence of the fact, which is why a
 * radius-less site cannot inherit one from whatever fence happens to be nearby.
 */
function sameFence(a, b) {
  const ra = Number.isFinite(a.radius) ? a.radius : null;
  const rb = Number.isFinite(b.radius) ? b.radius : null;
  if (ra === null || rb === null) return false;
  return Math.abs(ra - rb) <= RADIUS_TOLERANCE(Math.min(ra, rb));
}

/**
 * Nearest site to a fence centre. Radius agreement is reported rather than
 * required, so the caller can tell "this is that site's fence" apart from "a
 * fence happens to sit on that site".
 */
function matchSite(fence, candidates) {
  let best = null;
  for (const site of candidates) {
    const distance = geo.haversine({ lat: site.lat, lng: site.lng }, fence);
    if (distance === null || distance > FENCE_MATCH_METRES) continue;
    if (!best || distance < best.distance) best = { site, distance };
  }
  if (!best) return null;
  return {
    ...best.site,
    matchDistance: geo.round(best.distance, 1),
    radiusAgrees: sameFence({ radius: best.site.radius }, fence),
  };
}

const keyFor = (fence) => 'fence:' + geo.round(fence.lat, 5) + ',' + geo.round(fence.lng, 5);

const rounded = (fence) => ({
  lat: geo.round(fence.lat, 7),
  lng: geo.round(fence.lng, 7),
  radius: geo.round(fence.radius, 2),
});

function laterOf(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return b > a ? b : a;
}

// ---------------------------------------------------------------------------
// presentation-ready row
// ---------------------------------------------------------------------------

function finalise(s) {
  const estimate = s.centreEstimate || null;
  const authoritative = s.centreSource === 'geofence-log' && s.radius != null && s.radiusSource === 'geofence-log';
  // Where the recorded fence says the site is, versus where devices actually
  // cluster. A large gap is the cheapest signal that a fence is wrong or stale,
  // so it is computed whenever both are known instead of being left to the eye.
  const divergence =
    authoritative && estimate ? geo.round(geo.haversine({ lat: s.lat, lng: s.lng }, estimate), 1) : null;
  return {
    ...s,
    // hasFence means exactly one thing: the geofence log had a fence for this
    // site. A borrowed radius or an estimated centre does not qualify.
    hasFence: authoritative,
    fenceOnRecord: authoritative,
    plottable: s.lat != null && s.lng != null,
    centreIsEstimate: s.centreSource === 'estimate',
    // Drawing a circle is a claim about a boundary. Only make it when the
    // boundary is on record.
    radiusIsAuthoritative: s.radiusSource === 'geofence-log',
    centreConfidence: centreConfidence(s, estimate),
    centreDivergenceMetres: divergence,
    // Devices clustering outside the fence they are being judged against is a
    // fence problem, not a GPS problem.
    centreDivergenceExceedsFence: divergence != null && s.radius != null ? divergence > s.radius : null,
    users: uniqueCount(s.activeUserIds, s.userIds),
    label: s.address || (s.siteId != null ? 'Site ' + s.siteId : 'Unmapped fence'),
    // Only the geofence log can establish that a fence moved. A second cluster
    // of device fixes is a disputed estimate, which is a weaker claim and gets
    // its own flag rather than being reported as a relocation.
    relocated: s.fenceMovedMetres != null,
    centreDisputed: !!(estimate && estimate.disputed),
  };
}

function centreConfidence(s, estimate) {
  if (s.centreSource === 'geofence-log') return 'recorded';
  if (s.centreSource === 'exit-window') return 'fence-record';
  if (!estimate) return 'unknown';
  if (estimate.disputed) return 'disputed';
  if (estimate.fixes < CENTRE_MIN_FIXES) return 'weak';
  if (estimate.spreadMetres != null && estimate.spreadMetres > CENTRE_CLUSTER_METRES) return 'weak';
  return 'estimated';
}

function byActivity(a, b) {
  return (b.snapshots || 0) + (b.validations || 0) - ((a.snapshots || 0) + (a.validations || 0));
}

function uniqueCount(...lists) {
  const set = new Set();
  for (const l of lists) for (const v of l || []) set.add(v);
  return set.size;
}

// ---------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------

/**
 * siteId -> fence, for filling in a verdict on a document that carried none.
 *
 * Authoritative geometry ONLY. Judging a real clock-in against a centroid of
 * heartbeat fixes, or against a radius scavenged from a nearby exit window,
 * manufactures an inside/outside verdict out of an estimate - and a site that
 * moves would then retroactively change history's verdicts.
 */
async function siteLookup() {
  const sites = await getSites();
  const map = {};
  for (const s of sites) {
    if (s.siteId != null && s.hasFence) {
      map[s.siteId] = { lat: s.lat, lng: s.lng, radius: s.radius, source: 'geofence-log' };
    }
  }
  return map;
}

function invalidate() {
  cache.clear();
}

/** Which known site (if any) a given fence centre belongs to. */
async function siteForFence(fence) {
  if (!fence || !Number.isFinite(fence.lat) || !Number.isFinite(fence.lng)) return null;
  const all = await getSites();
  // A site with real geometry first; an estimated centre only as a fallback,
  // and flagged as one on the way out.
  const recorded = all.filter((s) => s.siteId != null && s.hasFence);
  const plottable = all.filter((s) => s.siteId != null && s.plottable);
  const hit = matchSite(fence, recorded) || matchSite(fence, plottable);
  if (!hit) return null;
  return {
    siteId: hit.siteId,
    label: hit.label,
    address: hit.address,
    radius: hit.radius,
    matchDistance: hit.matchDistance,
    matchedByCoordinates: true,
    matchedAgainstEstimate: hit.centreSource === 'estimate',
    radiusAgrees: !!hit.radiusAgrees,
  };
}

/**
 * Names the site an exit window's fence belongs to. The documents have no site
 * id, so the link is made by matching the fence centre against the registry -
 * and flagged as such on the row, never presented as if the document said so.
 */
async function attachWindowSite(row) {
  if (!row || !row.fence) return row;
  const site = await siteForFence(row.fence).catch(() => null);
  if (site) {
    row.jobSiteId = row.jobSiteId != null ? row.jobSiteId : site.siteId;
    row.site = site;
    row.siteAddress = row.siteAddress || site.address;
  } else {
    row.site = null;
  }
  return row;
}

module.exports = {
  getSites,
  siteLookup,
  siteForFence,
  attachWindowSite,
  invalidate,
  FENCE_MATCH_METRES,
  CENTRE_CLUSTER_METRES,
};
