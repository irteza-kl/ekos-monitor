'use strict';
const { collectionFor } = require('../db');
const config = require('../config');
const geo = require('./geo');
const { LOG, SNAP } = require('./filters');

let cache = { at: 0, sites: [] };
const TTL_MS = 5 * 60 * 1000;

/**
 * Builds the geofence site registry.
 *
 * Authoritative fences come from validateClockInLogs, which embeds the site's
 * centre, radius and address on every validation call. Sites that only ever
 * appear on heartbeat documents get a derived centre (centroid of the fixes
 * taken while inside the fence) so they can still be plotted, flagged with
 * source: 'derived'.
 */
async function getSites({ force = false } = {}) {
  if (!force && Date.now() - cache.at < TTL_MS) return cache.sites;

  const byId = new Map();

  // 1. authoritative fences
  try {
    const { col } = await collectionFor('clockInLogs');
    const rows = await col
      .aggregate(
        [
          { $match: { [LOG.siteId]: { $ne: null } } },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: '$' + LOG.siteId,
              lat: { $first: '$siteAreaData.siteArea.locations.latitude' },
              lng: { $first: '$siteAreaData.siteArea.locations.longitude' },
              radius: { $first: '$' + LOG.radius },
              address: { $first: '$' + LOG.address },
              city: { $first: '$siteAreaData.siteArea.locations.city' },
              state: { $first: '$siteAreaData.siteArea.locations.state' },
              country: { $first: '$siteAreaData.siteArea.locations.country' },
              zipCode: { $first: '$siteAreaData.siteArea.locations.zipCode' },
              updatedAt: { $first: '$siteAreaData.siteArea.locations.updatedAt' },
              validations: { $sum: 1 },
              lastValidationAt: { $max: '$createdAt' },
              outsideEvents: { $sum: { $cond: [{ $eq: ['$' + LOG.actual, false] }, 1, 0] } },
              graceEvents: {
                $sum: { $cond: [{ $and: [{ $eq: ['$' + LOG.within, true] }, { $eq: ['$' + LOG.actual, false] }] }, 1, 0] },
              },
              clockOutEvents: { $sum: { $cond: [{ $eq: ['$' + LOG.clockOut, true] }, 1, 0] } },
              avgAccuracy: { $avg: '$' + LOG.accuracy },
              worstAccuracy: { $max: '$' + LOG.accuracy },
              effectiveRadius: { $max: '$' + LOG.effectiveRadius },
              users: { $addToSet: '$userId' },
            },
          },
        ],
        { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs }
      )
      .toArray();

    for (const r of rows) {
      byId.set(r._id, {
        siteId: r._id,
        source: 'geofence-log',
        lat: geo.round(r.lat, 7),
        lng: geo.round(r.lng, 7),
        radius: geo.round(r.radius, 2),
        effectiveRadius: geo.round(r.effectiveRadius, 2),
        address: r.address || null,
        city: r.city || null,
        state: r.state || null,
        country: r.country || null,
        zipCode: r.zipCode || null,
        updatedAt: r.updatedAt || null,
        validations: r.validations,
        lastValidationAt: r.lastValidationAt || null,
        outsideEvents: r.outsideEvents,
        graceEvents: r.graceEvents,
        clockOutEvents: r.clockOutEvents,
        avgAccuracy: geo.round(r.avgAccuracy, 1),
        worstAccuracy: geo.round(r.worstAccuracy, 1),
        userIds: (r.users || []).filter((u) => u !== null),
      });
    }
  } catch (err) {
    if (err.code !== 'COLLECTION_MISSING') throw err;
  }

  // 2. activity + derived centres from heartbeat snapshots
  try {
    const { col, base } = await collectionFor('snapshots');
    const siteField = {
      $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt],
    };
    const rows = await col
      .aggregate(
        [
          { $match: base },
          { $addFields: { _siteId: siteField } },
          { $match: { _siteId: { $ne: null } } },
          {
            $group: {
              _id: '$_siteId',
              snapshots: { $sum: 1 },
              users: { $addToSet: SNAP.userId ? '$' + SNAP.userId : '$currentUser.data.id' },
              tenantIds: { $addToSet: '$' + SNAP.tenantId },
              lastSeenAt: { $max: '$createdAt' },
              insideCount: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', true] }, 1, 0] } },
              outsideCount: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', false] }, 1, 0] } },
              avgAccuracy: { $avg: '$' + SNAP.accuracy },
              insideLat: { $avg: { $cond: [{ $eq: ['$isInsideGeofence', true] }, '$' + SNAP.lat, null] } },
              insideLng: { $avg: { $cond: [{ $eq: ['$isInsideGeofence', true] }, '$' + SNAP.lng, null] } },
              anyLat: { $avg: '$' + SNAP.lat },
              anyLng: { $avg: '$' + SNAP.lng },
              siteLat: { $max: '$clockedInJobSiteLocation.latitude' },
              siteLng: { $max: '$clockedInJobSiteLocation.longitude' },
            },
          },
        ],
        { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs }
      )
      .toArray();

    for (const r of rows) {
      const existing = byId.get(r._id) || { siteId: r._id, source: 'derived' };
      const derivedLat = pick(r.siteLat, r.insideLat, r.anyLat);
      const derivedLng = pick(r.siteLng, r.insideLng, r.anyLng);
      byId.set(r._id, {
        ...existing,
        lat: existing.lat != null ? existing.lat : geo.round(derivedLat, 7),
        lng: existing.lng != null ? existing.lng : geo.round(derivedLng, 7),
        radius: existing.radius != null ? existing.radius : null,
        snapshots: r.snapshots,
        activeUserIds: (r.users || []).filter((u) => u !== null),
        tenantIds: (r.tenantIds || []).filter((t) => t !== null),
        lastSeenAt: r.lastSeenAt || existing.lastValidationAt || null,
        insideSnapshots: r.insideCount,
        outsideSnapshots: r.outsideCount,
        snapshotAvgAccuracy: geo.round(r.avgAccuracy, 1),
      });
    }
  } catch (err) {
    if (err.code !== 'COLLECTION_MISSING') throw err;
  }

  // 3. fences carried by exit-window documents
  try {
    const { col, base } = await collectionFor('exitWindows');
    const rows = await col
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

      // An explicit site id always wins.
      if (r._id.siteId != null) {
        merge(byId, r._id.siteId, fence, stats, 'exit-window');
        continue;
      }

      // Otherwise match a site whose recorded centre is this fence.
      const match = matchSite(fence, known);
      if (match) {
        merge(byId, match.siteId != null ? match.siteId : keyFor(match), fence, stats, match.source, true);
        continue;
      }

      // Leftovers: group fences that are effectively the same one.
      const cluster = clusters.find(
        (c) => sameFence(c.fence, fence) && geo.haversine(c.fence, fence) <= FENCE_MATCH_METRES
      );
      if (cluster) {
        cluster.stats.exitWindows += stats.exitWindows;
        cluster.stats.exitClockOuts += stats.exitClockOuts;
        cluster.stats.openExitWindows += stats.openExitWindows;
        cluster.stats.variants += 1;
        if (!cluster.stats.lastExitAt || (stats.lastExitAt || 0) > cluster.stats.lastExitAt) {
          cluster.stats.lastExitAt = stats.lastExitAt;
        }
      } else {
        clusters.push({ fence, stats: { ...stats, variants: 1 } });
      }
    }

    for (const cluster of clusters) {
      merge(byId, keyFor(cluster.fence), cluster.fence, cluster.stats, 'exit-window');
    }
  } catch (err) {
    if (err.code !== 'COLLECTION_MISSING') throw err;
  }

  const sites = [...byId.values()]
    .map((s) => ({
      ...s,
      hasFence: s.lat != null && s.lng != null && s.radius != null,
      plottable: s.lat != null && s.lng != null,
      users: uniqueCount(s.activeUserIds, s.userIds),
      label: s.address || (s.siteId != null ? 'Site ' + s.siteId : 'Unmapped fence'),
    }))
    .sort((a, b) => (b.snapshots || 0) + (b.validations || 0) - ((a.snapshots || 0) + (a.validations || 0)));

  cache = { at: Date.now(), sites };
  return sites;
}

/**
 * How close two fence centres must be to be treated as the same fence. GPS-era
 * fence definitions jitter by a few metres between writes; 30 m keeps those
 * together without merging genuinely different sites.
 */
const FENCE_MATCH_METRES = 30;

/** Same fence only if the radius agrees too - a 20 m and a 100 m fence at the
 *  same spot are different rules, not the same place. */
function sameFence(a, b) {
  const ra = Number.isFinite(a.radius) ? a.radius : null;
  const rb = Number.isFinite(b.radius) ? b.radius : null;
  if (ra === null || rb === null) return true;
  return Math.abs(ra - rb) <= Math.max(5, Math.min(ra, rb) * 0.2);
}

function matchSite(fence, candidates) {
  let best = null;
  for (const site of candidates) {
    const distance = geo.haversine({ lat: site.lat, lng: site.lng }, fence);
    if (distance === null || distance > FENCE_MATCH_METRES) continue;
    if (!sameFence({ radius: site.radius }, fence)) continue;
    if (!best || distance < best.distance) best = { site, distance };
  }
  return best ? { ...best.site, matchDistance: geo.round(best.distance, 1) } : null;
}

const keyFor = (fence) => 'fence:' + geo.round(fence.lat, 5) + ',' + geo.round(fence.lng, 5);

/** Adds exit-window facts to a registry entry, creating it when new. */
function merge(byId, key, fence, stats, source, matchedByCoordinates) {
  const existing = byId.get(key) || { siteId: typeof key === 'number' ? key : null, source: source || 'exit-window' };
  byId.set(key, {
    ...existing,
    ...stats,
    lat: existing.lat != null ? existing.lat : geo.round(fence.lat, 7),
    lng: existing.lng != null ? existing.lng : geo.round(fence.lng, 7),
    radius: existing.radius != null ? existing.radius : geo.round(fence.radius, 2),
    exitFence: { lat: geo.round(fence.lat, 7), lng: geo.round(fence.lng, 7), radius: geo.round(fence.radius, 2) },
    exitFenceMatchedByCoordinates: !!matchedByCoordinates,
  });
}

function pick(...vals) {
  for (const v of vals) if (Number.isFinite(v) && v !== 0) return v;
  return null;
}

function uniqueCount(...lists) {
  const set = new Set();
  for (const l of lists) for (const v of l || []) set.add(v);
  return set.size;
}

/** siteId -> fence, for recomputing verdicts on documents lacking one. */
async function siteLookup() {
  const sites = await getSites();
  const map = {};
  for (const s of sites) {
    if (s.siteId != null && s.lat != null && s.lng != null) {
      map[s.siteId] = { lat: s.lat, lng: s.lng, radius: s.radius };
    }
  }
  return map;
}

function invalidate() {
  cache = { at: 0, sites: [] };
}

/** Which known site (if any) a given fence centre belongs to. */
async function siteForFence(fence) {
  if (!fence || !Number.isFinite(fence.lat) || !Number.isFinite(fence.lng)) return null;
  const all = await getSites();
  const candidates = all.filter((s) => s.lat != null && s.lng != null && s.siteId != null);
  const hit = matchSite(fence, candidates);
  if (!hit) return null;
  return {
    siteId: hit.siteId,
    label: hit.label,
    address: hit.address,
    radius: hit.radius,
    matchDistance: hit.matchDistance,
    matchedByCoordinates: true,
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

module.exports = { getSites, siteLookup, siteForFence, attachWindowSite, invalidate, FENCE_MATCH_METRES };
