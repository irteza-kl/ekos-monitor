'use strict';
/**
 * Listing exit windows.
 *
 * This lives in lib rather than in the route because two pages ask the same
 * question: the Exit Windows page, and the Exit windows tab on a user page.
 * The tab used to run its own cut-down query - candidates bounded by the
 * user's heartbeat span and nothing else - so it ignored every filter the
 * page was showing and answered a different question from the table it is
 * rendered by. One implementation means one answer.
 */
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('./filters');
const P = require('./pipelines');
const normalize = require('./normalize');
const { getSites, attachWindowSite, FENCE_MATCH_METRES } = require('./sites');
const { attributeWindows } = require('./attribution');

const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

const SORTABLE = ['openedAt', 'resolvedAt', 'pushedAt', 'userId', 'status', 'stats.sampleCount', 'stats.maxDistanceFromBoundary', 'stats.avgAccuracy', 'stats.durationMinutes'];

async function listWindows(q) {
  const { col, base } = await collectionFor('exitWindows');
  // These documents carry fence coordinates but no site id, so a site filter
  // becomes a bounding box around that site's recorded centre.
  const siteIds = F.nums(q.jobSiteId);
  let siteClause = null;
  if (siteIds.length) {
    const sites = await getSites();
    const boxes = sites
      .filter((s) => siteIds.includes(s.siteId) && s.lat != null && s.lng != null)
      .map((s) => {
        const dLat = FENCE_MATCH_METRES / 111320;
        const dLng = FENCE_MATCH_METRES / (111320 * Math.cos((s.lat * Math.PI) / 180));
        // Same rule as the label matcher: near the centre AND a compatible
        // radius, so a 20 m fence never absorbs a 100 m one at the same spot.
        const tolerance = s.radius == null ? null : Math.max(5, s.radius * 0.2);
        const box = {
          'fence.lat': { $gte: s.lat - dLat, $lte: s.lat + dLat },
          'fence.lng': { $gte: s.lng - dLng, $lte: s.lng + dLng },
        };
        if (tolerance !== null) {
          box.$or = [
            { 'fence.radius': { $gte: s.radius - tolerance, $lte: s.radius + tolerance } },
            { 'fence.radius': { $exists: false } },
            { 'fence.radius': null },
          ];
        }
        return { $or: [{ jobSiteId: s.siteId }, { 'fence.siteId': s.siteId }, box] };
      });
    // A site we know nothing about can match nothing.
    siteClause = boxes.length ? { $or: boxes } : { _id: null };
  }

  // userId is applied after attribution (see below), not in Mongo.
  const match = F.and([base, F.exitWindowMatch({ ...q, jobSiteId: undefined, userId: undefined }), siteClause]);
  const postMatch = F.exitWindowPostMatch(q);
  const { limit, page, skip } = F.pagination(q, 50, 500);
  const sort = F.sortSpec(q, SORTABLE, { openedAt: -1 });

  const result = await col
    .aggregate(
      [
        { $match: match },
        P.exitWindowStats(),
        { $match: postMatch },
        { $sort: sort },
        {
          $facet: {
            rows: [{ $skip: skip }, { $limit: limit }],
            total: [{ $count: 'value' }],
          },
        },
      ],
      opts
    )
    .next();

  let rows = (result.rows || []).map(normalize.exitWindow);
  const verdicts = F.list(q.verdict);
  if (verdicts.length) {
    rows = rows.filter((row) => row.samples.some((s) => verdicts.includes(s.verdict)));
  }
  rows = await Promise.all(rows.map(attachWindowSite));
  // Join to a person: exact when the document names one, inferred from
  // heartbeat presence at the fence otherwise.
  await attributeWindows(rows);

  // Filtering by user has to happen after attribution, since the documents
  // themselves carry userId: null.
  const wantedUsers = F.nums(q.userId);
  if (wantedUsers.length) {
    rows = rows.filter((r) => r.attribution && wantedUsers.includes(r.attribution.userId));
  }
  return { rows, total: (result.total[0] || {}).value || rows.length, page, limit };
}

module.exports = { listWindows, SORTABLE };
