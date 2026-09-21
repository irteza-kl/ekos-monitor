'use strict';
/**
 * Shift trails: the query and the page summary.
 *
 * This lives in lib rather than in the route because the list is asked for by
 * the page, by the CSV export and (when the user page grows a tab for it) by a
 * second caller, and three implementations of one question give three answers.
 *
 * What a trail is: one document per SHIFT, sealed by the app at clock-out. It
 * carries the shift's own facts, a `summary` the app computed itself, and an
 * `entries` array - each entry either a GPS `fix` or a `runtime_start`, the
 * app process having been recreated mid-shift.
 *
 * The rows are per shift because the documents are. Everything per-entry -
 * the path, the accuracy spread, the battery drain, whether the permission
 * changed halfway through - is derived in normalize.shiftTrail and rides on
 * the row, so the table can summarise a shift and the drawer can open it.
 */
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('./filters');
const normalize = require('./normalize');
const geo = require('./geo');
const { SNAP } = require('./filters');
const { getSites } = require('./sites');

const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

/**
 * A stored timestamp as a Date, whatever type it is stored as.
 *
 * Every clock on a shift trail is an ISO **string** - clockIn, clockOut,
 * sealedAt, pushedAt, the summary's own timestamps, and every entry's - while
 * `createdAt` beside them is a BSON date. Arithmetic and `$dateTrunc` need a
 * real date, so anything that subtracts or buckets converts first. Without
 * this the summary aggregation dies outright with "can't $subtract string
 * from string", which is at least a loud failure; the quiet one is `$min`
 * over mixed types, which orders by type before value and returns a boundary
 * that means nothing.
 */
const asDate = (path) => ({ $convert: { input: path, to: 'date', onError: null, onNull: null } });

const SORTABLE = ['clockOut', 'clockIn', 'sealedAt', 'pushedAt', 'createdAt', 'userId', 'siteId', 'summary.entries', 'summary.fixes', 'summary.runtimeStarts', 'summary.positionedMinutes'];

/**
 * Who these user ids belong to, and which of them the heartbeats have never
 * seen.
 *
 * A trail names its user outright, so somebody who has only ever produced
 * trails is visible here and nowhere else in this console - and the name has
 * to come from a heartbeat, because a trail carries none. Both currentUser
 * envelopes are read: the Android client sends it unwrapped on about a quarter
 * of its heartbeats, and a name lookup that knew only the wrapped path would
 * report people as nameless who are not.
 *
 * `$max` over an object rather than a sort: this cluster does not honour
 * allowDiskUse, and ordering every heartbeat a person ever sent to read one
 * name off the newest is the unbounded sort that has bitten this project twice.
 */
async function namesFor(ids) {
  const wanted = [...new Set((ids || []).filter((id) => id !== null && id !== undefined))];
  const names = new Map();
  const seenInHeartbeats = new Set();
  if (!wanted.length) return { names, seenInHeartbeats };

  try {
    const { col, base } = await collectionFor('snapshots');
    const found = await col
      .aggregate(
        [
          {
            $match: F.and([
              base,
              { $or: [{ [SNAP.userId]: { $in: wanted } }, { 'currentUser.id': { $in: wanted } }] },
            ]),
          },
          {
            $group: {
              _id: { $ifNull: ['$' + SNAP.userId, '$currentUser.id'] },
              newest: {
                $max: {
                  at: '$createdAt',
                  name: { $ifNull: ['$' + SNAP.fullName, { $ifNull: ['$currentUser.fullName', null] }] },
                },
              },
            },
          },
          { $project: { name: '$newest.name' } },
        ],
        opts
      )
      .toArray();
    for (const row of found) {
      seenInHeartbeats.add(row._id);
      if (row.name) names.set(row._id, row.name);
    }
  } catch (err) {
    // A store with trails and no heartbeats is a legitimate state. Every user
    // is then simply unnamed, which the page says rather than hides.
  }
  return { names, seenInHeartbeats };
}

/**
 * Where the shift's site is, so the path can be judged against a fence.
 *
 * The trail names a site id but carries no geometry, and the registry has the
 * fence. Without this the map draws a path with nothing to measure it against,
 * which on a geofence console is half an answer.
 */
async function attachSites(rows) {
  const ids = [...new Set(rows.map((r) => r.siteId).filter((id) => id !== null && id !== undefined))];
  if (!ids.length) return;
  let sites = [];
  try {
    sites = await getSites();
  } catch (err) {
    return; // the registry is a nicety here; the path still draws
  }
  const byId = new Map(sites.filter((s) => ids.includes(s.siteId)).map((s) => [s.siteId, s]));
  for (const row of rows) {
    const site = row.siteId === null ? null : byId.get(row.siteId);
    if (!site) continue;
    row.site = {
      siteId: site.siteId,
      name: site.name || null,
      displayName: site.displayName || null,
      label: site.label || null,
      address: site.address || null,
      fence: site.lat == null || site.lng == null ? null : { lat: site.lat, lng: site.lng, radius: site.radius },
    };
    if (!row.site.fence) continue;

    // How much of this shift was actually spent inside the fence, by the same
    // geometry the rest of the console uses - and counted with the accuracy
    // allowance, so a fix whose error circle straddles the boundary is
    // "uncertain" rather than being forced to one side.
    let inside = 0;
    let outside = 0;
    let uncertain = 0;
    let furthest = null;
    for (const entry of row.entries) {
      if (!entry.location) continue;
      const judged = geo.verdictWithAccuracy(entry.location, row.site.fence, entry.accuracy);
      entry.fenceVerdict = judged ? judged.verdict : 'unknown';
      const distance = judged && judged.relation ? judged.relation.distanceFromBoundary : null;
      entry.distanceFromBoundary = geo.round(distance, 1);
      if (entry.fenceVerdict === 'in') inside += 1;
      else if (entry.fenceVerdict === 'out') outside += 1;
      else uncertain += 1;
      if (distance !== null && (furthest === null || distance > furthest)) furthest = distance;
    }
    row.fence = {
      inside,
      outside,
      uncertain,
      furthestOutside: geo.round(furthest, 1),
      // The share of positioned time that was on site, which is the number a
      // supervisor actually asks for.
      insideShare: inside + outside + uncertain ? geo.round((100 * inside) / (inside + outside + uncertain), 1) : null,
    };
  }
}

/** Filters that can only run once the row's derived numbers exist. */
function postFilter(rows, q) {
  const minCoverage = F.num(q.minCoverage);
  const maxCoverage = F.num(q.maxCoverage);
  const minTravelled = F.num(q.minTravelled);
  const minDuration = F.num(q.minDurationMinutes);
  const coarse = F.bool(q.coarseOnly);
  const changed = F.bool(q.permissionChanged);
  const disagree = F.bool(q.runtimeStartsDisagree);

  return rows.filter((row) => {
    const s = row.stats;
    if (minCoverage !== null && (s.coverage === null || s.coverage < minCoverage)) return false;
    if (maxCoverage !== null && (s.coverage === null || s.coverage > maxCoverage)) return false;
    if (minTravelled !== null && (s.travelledMetres === null || s.travelledMetres < minTravelled)) return false;
    if (minDuration !== null && (row.durationMinutes === null || row.durationMinutes < minDuration)) return false;
    if (coarse === true && !s.coarseFixes) return false;
    if (changed === true && !s.permissionChanged) return false;
    if (disagree === true && !s.runtimeStartsDisagree) return false;
    return true;
  });
}

/** One page of shifts, each carrying its path, its stats and its person. */
async function listTrail(q) {
  const { col, base } = await collectionFor('shiftTrails');
  const match = F.and([base, F.shiftTrailMatch(q)]);
  const { limit, page, skip } = F.pagination(q, 50, 500);
  const sort = F.sortSpec(q, SORTABLE, { clockOut: -1 });

  // These documents are per shift, not per fix: a device sending every minute
  // produces one of these a day, not 600. So there is no unbounded-sort risk
  // here of the kind /api/snapshots had, and a plain find() with an indexed
  // sort is the right shape. If shifts ever reach heartbeat volume this needs
  // the same projection-sort treatment - see the README.
  const [docs, total] = await Promise.all([
    col.find(match).sort(sort).skip(skip).limit(limit).maxTimeMS(config.queryTimeoutMs).toArray(),
    col.countDocuments(match, { maxTimeMS: config.queryTimeoutMs }),
  ]);

  let rows = docs.map(normalize.shiftTrail);
  await attachSites(rows);

  const { names, seenInHeartbeats } = await namesFor(rows.map((r) => r.userId));
  for (const row of rows) {
    row.name = names.get(row.userId) || null;
    // The person exists in this stream and nowhere else: no user page to open,
    // no heartbeat to reconcile the trail against, and no name.
    row.heartbeatKnown = seenInHeartbeats.has(row.userId);
  }

  const before = rows.length;
  rows = postFilter(rows, q);

  return {
    rows,
    total,
    page,
    limit,
    // The derived filters run after the query, so the page has to be able to
    // say that its total counts shifts before they were applied rather than
    // quietly printing a number that disagrees with the rows below it.
    postFiltered: before !== rows.length,
    matchedOnPage: rows.length,
  };
}

/** The tiles: one pass over every shift in range. */
async function summary(q) {
  const { col, base } = await collectionFor('shiftTrails');
  const match = F.and([base, F.shiftTrailMatch(q)]);

  const facet = await col
    .aggregate(
      [
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'value' }],
            users: [{ $group: { _id: '$userId' } }],
            sites: [{ $group: { _id: '$siteId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
            devices: [{ $group: { _id: '$deviceType', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
            versions: [{ $group: { _id: '$applicationVersion', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
            tenants: [{ $group: { _id: '$tenantId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
            rollup: [
              {
                $group: {
                  _id: null,
                  entries: { $sum: { $ifNull: ['$summary.entries', 0] } },
                  fixes: { $sum: { $ifNull: ['$summary.fixes', 0] } },
                  gaps: { $sum: { $ifNull: ['$summary.gaps', 0] } },
                  runtimeStarts: { $sum: { $ifNull: ['$summary.runtimeStarts', 0] } },
                  positionedMinutes: { $sum: { $ifNull: ['$summary.positionedMinutes', 0] } },
                  shiftsWithRestarts: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$summary.runtimeStarts', 0] }, 0] }, 1, 0] } },
                  shiftsWithAbsences: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$summary.absences', []] } }, 0] }, 1, 0] } },
                  absences: { $sum: { $size: { $ifNull: ['$summary.absences', []] } } },
                  shiftsWithNoFix: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$summary.fixes', 0] }, 0] }, 1, 0] } },
                  // Shift minutes, from the clock times rather than the app's
                  // own count, so coverage can be checked against it.
                  shiftMinutes: {
                    $sum: {
                      $let: {
                        vars: { a: asDate('$clockIn'), b: asDate('$clockOut') },
                        in: {
                          $cond: [
                            { $and: [{ $ne: ['$$a', null] }, { $ne: ['$$b', null] }] },
                            { $divide: [{ $subtract: ['$$b', '$$a'] }, 60000] },
                            0,
                          ],
                        },
                      },
                    },
                  },
                },
              },
            ],
            entryKinds: [{ $unwind: '$entries' }, { $group: { _id: '$entries.kind', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
            permissions: [
              { $unwind: '$entries' },
              { $group: { _id: '$entries.locationPermission', n: { $sum: 1 } } },
              { $sort: { n: -1 } },
            ],
            precisions: [
              { $unwind: '$entries' },
              { $group: { _id: '$entries.locationPrecision', n: { $sum: 1 } } },
              { $sort: { n: -1 } },
            ],
            range: [{ $group: { _id: null, min: { $min: asDate('$clockIn') }, max: { $max: asDate('$clockOut') } } }],
            timeline: [
              { $addFields: { _sealedOn: asDate('$clockOut') } },
              { $match: { _sealedOn: { $ne: null } } },
              {
                $group: {
                  _id: { $dateTrunc: { date: '$_sealedOn', unit: 'day' } },
                  shifts: { $sum: 1 },
                  restarts: { $sum: { $ifNull: ['$summary.runtimeStarts', 0] } },
                  fixes: { $sum: { $ifNull: ['$summary.fixes', 0] } },
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ],
      opts
    )
    .next();

  const one = (arr) => (arr && arr[0]) || {};
  const asList = (arr) => (arr || []).map((x) => ({ key: x._id, count: x.n }));
  const roll = one(facet.rollup);
  const userIds = (facet.users || []).map((u) => u._id).filter((u) => u !== null && u !== undefined);
  const { seenInHeartbeats } = await namesFor(userIds);
  const rangeRow = one(facet.range);

  const shiftMinutes = roll.shiftMinutes || 0;
  const positioned = roll.positionedMinutes || 0;

  return {
    total: one(facet.total).value || 0,
    users: userIds.length,
    // The reason this payload exists: people the trails know about that the
    // heartbeats have never seen.
    usersWithoutHeartbeats: userIds.filter((id) => !seenInHeartbeats.has(id)).length,

    entries: roll.entries || 0,
    fixes: roll.fixes || 0,
    gaps: roll.gaps || 0,
    runtimeStarts: roll.runtimeStarts || 0,
    shiftsWithRestarts: roll.shiftsWithRestarts || 0,
    absences: roll.absences || 0,
    shiftsWithAbsences: roll.shiftsWithAbsences || 0,
    shiftsWithNoFix: roll.shiftsWithNoFix || 0,

    shiftMinutes: geo.round(shiftMinutes, 1),
    positionedMinutes: geo.round(positioned, 1),
    coverage: shiftMinutes > 0 ? geo.round(Math.min(100, (positioned / shiftMinutes) * 100), 1) : null,

    sites: asList(facet.sites),
    devices: asList(facet.devices),
    versions: asList(facet.versions),
    tenants: asList(facet.tenants),
    entryKinds: asList(facet.entryKinds),
    permissions: asList(facet.permissions),
    precisions: asList(facet.precisions),

    range: {
      min: rangeRow.min ? new Date(rangeRow.min).toISOString() : null,
      max: rangeRow.max ? new Date(rangeRow.max).toISOString() : null,
    },
    granularity: 'day',
    timeline: (facet.timeline || [])
      .filter((t) => t._id)
      .map((t) => ({ at: new Date(t._id).toISOString(), count: t.shifts, restarts: t.restarts, fixes: t.fixes })),
  };
}

module.exports = { listTrail, summary, namesFor, attachSites, SORTABLE };
