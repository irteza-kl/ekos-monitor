'use strict';
const { SNAP } = require('./filters');
const { ACCURACY_BANDS } = require('./geo');

/** $switch that mirrors geo.accuracyBand, so bands can be filtered in Mongo. */
function accuracyBandExpr(path = '$' + SNAP.accuracy) {
  return {
    $switch: {
      branches: [
        { case: { $eq: [{ $ifNull: [path, null] }, null] }, then: 'unknown' },
        ...ACCURACY_BANDS.filter((b) => Number.isFinite(b.max)).map((b) => ({
          case: { $lt: [path, b.max] },
          then: b.key,
        })),
      ],
      default: 'unusable',
    },
  };
}

/** Minutes between a date field and now. */
function ageMinutesExpr(path = '$createdAt') {
  return {
    $cond: [
      { $eq: [{ $ifNull: [path, null] }, null] },
      null,
      { $round: [{ $divide: [{ $subtract: ['$$NOW', path] }, 60000] }, 1] },
    ],
  };
}

/**
 * `currentUserLocation.capturedAt` as a Date, in the aggregation.
 *
 * This is `normalize.flexibleIso()` expressed in MQL, and the two have to stay
 * in step: one decides what the row *says*, this one decides where the row
 * *sorts*, and a table sorted by a different reading of the same field than it
 * displays is worse than one that cannot sort at all.
 *
 * Why it cannot just be `sort({'currentUserLocation.capturedAt': -1})`: Mongo
 * orders mixed types by BSON type first and value second. While the field is
 * epoch on old documents and a Date on new ones, that sort would group all the
 * numbers together and all the dates together - two blocks, each internally
 * ordered, and the boundary between them meaningless. So the value is converted
 * to one type before anything is sorted.
 *
 * Same seconds-versus-milliseconds rule as the JS side (1e11: ms below it is
 * 1973, seconds above it is the year 5138), and the same 2000-2100 sanity
 * window - anything outside it is not a timestamp we can believe, so it yields
 * null and the caller falls back.
 */
const EPOCH_MS_FLOOR = 1e11;
const SANE_FROM = new Date(Date.UTC(2000, 0, 1));
const SANE_TO = new Date(Date.UTC(2100, 0, 1));

function capturedAtExpr(path = '$' + SNAP.capturedAt) {
  const asDate = {
    $switch: {
      branches: [
        // Already a Date: the shape this field is expected to move to.
        { case: { $eq: [{ $type: path }, 'date'] }, then: path },
        // Epoch, in seconds or milliseconds.
        {
          case: { $in: [{ $type: path }, ['double', 'int', 'long', 'decimal']] },
          then: {
            $convert: {
              input: {
                $cond: [{ $lt: [path, EPOCH_MS_FLOOR] }, { $multiply: [path, 1000] }, path],
              },
              to: 'date',
              onError: null,
              onNull: null,
            },
          },
        },
        // A string, which is either an ISO date or an epoch that arrived quoted.
        //
        // Mongo's string->date conversion only accepts ISO-8601, so a quoted
        // epoch ("1788006000000") errors and would fall through to the next
        // clock - while normalize.flexibleIso reads it as a number and shows the
        // fix time. That disagreement is the worst kind: the table would sort by
        // a different reading of the field than the one it prints. So a numeric
        // string takes the epoch path, exactly as the JS side does.
        {
          case: { $eq: [{ $type: path }, 'string'] },
          then: {
            $let: {
              vars: { num: { $convert: { input: path, to: 'double', onError: null, onNull: null } } },
              in: {
                $cond: [
                  { $ne: ['$$num', null] },
                  {
                    $convert: {
                      input: {
                        $cond: [{ $lt: ['$$num', EPOCH_MS_FLOOR] }, { $multiply: ['$$num', 1000] }, '$$num'],
                      },
                      to: 'date',
                      onError: null,
                      onNull: null,
                    },
                  },
                  { $convert: { input: path, to: 'date', onError: null, onNull: null } },
                ],
              },
            },
          },
        },
      ],
      default: null,
    },
  };
  // A value outside the sane window is a broken clock or a misread unit. Null
  // it here so it falls back, rather than sorting a whole device into 1970.
  return {
    $let: {
      vars: { d: asDate },
      in: {
        $cond: [
          { $and: [{ $ne: ['$$d', null] }, { $gte: ['$$d', SANE_FROM] }, { $lt: ['$$d', SANE_TO] }] },
          '$$d',
          null,
        ],
      },
    },
  };
}

/**
 * The instant a heartbeat is ordered and reported by: the fix time when the
 * device sent a usable one, otherwise the clocks that are always there.
 * Mirrors normalize.heartbeatTime()'s precedence exactly.
 */
function heartbeatAtExpr() {
  return {
    $ifNull: [
      capturedAtExpr(),
      {
        $convert: { input: '$currentDateTime', to: 'date', onError: null, onNull: null },
      },
      '$createdAt',
    ],
  };
}

/** The field name the computed instant lands on. Underscored: it is machinery. */
const HEARTBEAT_AT = '_heartbeatAt';
const computedFields = {
  accuracyBand: accuracyBandExpr(),
  // The same instant the row reports its age from. It was `$createdAt`, so the
  // Age column displayed minutes-since-the-fix and sorted on
  // minutes-since-arrival - for a late-synced device those differ by hours and
  // the column ordered itself by numbers it was not showing.
  //
  // Self-contained rather than reading `_heartbeatAt`: that field is only added
  // when it is being sorted on, and this has to work in the other case too.
  ageMinutes: ageMinutesExpr(heartbeatAtExpr()),
};

/**
 * Newest snapshot per user, with computed fields available to post-filters.
 * Documents with no user id are grouped under the "anonymous" bucket so the
 * dashboard still surfaces devices reporting without a session.
 */
function latestPerUser({ match, postMatch, sort, skip, limit, collection }) {
  if (!collection) throw new Error('latestPerUser needs the collection name: it looks the winning document back up by _id');
  return [
    { $match: match || {} },
    // The instant each heartbeat happened, before anything is ordered by it.
    // "Newest per user" has to mean newest fix, not newest arrival: a device
    // syncing yesterday's backlog would otherwise present a stale fix as the
    // one describing where that person is right now.
    { $addFields: { [HEARTBEAT_AT]: heartbeatAtExpr() } },
    // Down to the eight fields the grouping needs, and then no sort at all.
    //
    // This used to be `$sort: { _heartbeatAt: -1 }` over whole documents,
    // followed by `$first: $$ROOT` to take each person's newest. That is a
    // blocking sort over every heartbeat in range - hundreds of megabytes of
    // full documents on an all-time query - and **this deployment does not
    // honour allowDiskUse** (Atlas shared tiers ignore it; lib/fence.js
    // records the same finding). So `/api/stats` with no filters died with
    // "Sort exceeded memory limit of 33554432 bytes, but did not opt in to
    // external sorting" while passing allowDiskUse: true.
    //
    // `$max` over an object compares field by field in declaration order, so
    // `{ at, id }` maxed is the id of the newest heartbeat - the same answer
    // the sort gave, computed in one streaming pass with memory proportional
    // to the number of PEOPLE rather than the number of heartbeats. `at`
    // decides; `id` only breaks a tie, and a heartbeat with no readable time
    // loses to any that has one because null sorts below every date.
    {
      $project: {
        _id: 1,
        [HEARTBEAT_AT]: 1,
        _u: { $ifNull: ['$' + SNAP.userId, 'anonymous'] },
        _acc: '$' + SNAP.accuracy,
        _in: '$isInsideGeofence',
        _conn: '$isConnected',
        _bat: '$batteryPercentage',
        _site: { $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt] },
      },
    },
    {
      $group: {
        _id: '$_u',
        _newest: { $max: { at: '$' + HEARTBEAT_AT, id: '$_id' } },
        snapshotCount: { $sum: 1 },
        // First and last are about when the person was seen, so they run on the
        // same instant everything else is ordered by, not on arrival time.
        firstSeenAt: { $min: '$' + HEARTBEAT_AT },
        lastSeenAt: { $max: '$' + HEARTBEAT_AT },
        avgAccuracy: { $avg: '$_acc' },
        worstAccuracy: { $max: '$_acc' },
        bestAccuracy: { $min: '$_acc' },
        insideCount: { $sum: { $cond: [{ $eq: ['$_in', true] }, 1, 0] } },
        outsideCount: { $sum: { $cond: [{ $eq: ['$_in', false] }, 1, 0] } },
        offlineCount: { $sum: { $cond: [{ $eq: ['$_conn', false] }, 1, 0] } },
        minBattery: { $min: '$_bat' },
        siteIds: { $addToSet: '$_site' },
      },
    },
    // The winning document itself, by _id: one indexed point lookup per person
    // in place of ordering the whole collection to find it.
    {
      $lookup: {
        from: collection,
        localField: '_newest.id',
        foreignField: '_id',
        as: '_doc',
      },
    },
    { $unwind: '$_doc' },
    {
      $replaceRoot: {
        newRoot: {
          $mergeObjects: [
            '$_doc',
            // Put back on the merged root: the sort below defaults to it, and
            // it lives on the projection rather than on the stored document.
            { [HEARTBEAT_AT]: '$_newest.at' },
            {
              _agg: {
                snapshotCount: '$snapshotCount',
                firstSeenAt: '$firstSeenAt',
                lastSeenAt: '$lastSeenAt',
                avgAccuracy: { $round: [{ $ifNull: ['$avgAccuracy', 0] }, 1] },
                worstAccuracy: '$worstAccuracy',
                bestAccuracy: '$bestAccuracy',
                insideCount: '$insideCount',
                outsideCount: '$outsideCount',
                offlineCount: '$offlineCount',
                minBattery: '$minBattery',
                siteIds: {
                  $filter: { input: '$siteIds', as: 's', cond: { $ne: ['$$s', null] } },
                },
              },
            },
          ],
        },
      },
    },
    { $addFields: computedFields },
    { $match: postMatch || {} },
    { $sort: sort || { [HEARTBEAT_AT]: -1 } },
    {
      $facet: {
        rows: [{ $skip: skip || 0 }, { $limit: limit || 50 }],
        total: [{ $count: 'value' }],
      },
    },
  ];
}

/** Adds sample statistics to exit-window documents so they can be filtered. */
function exitWindowStats() {
  return {
    $addFields: {
      stats: {
        sampleCount: { $size: { $ifNull: ['$samples', []] } },
        avgAccuracy: { $avg: '$samples.accuracy' },
        maxAccuracy: { $max: '$samples.accuracy' },
        maxDistanceFromBoundary: { $max: '$samples.distanceFromBoundary' },
        durationMinutes: {
          $cond: [
            { $and: [{ $ifNull: ['$openedAt', false] }, { $ifNull: [{ $ifNull: ['$resolvedAt', '$expiresAt'] }, false] }] },
            {
              $round: [
                {
                  $divide: [
                    { $subtract: [{ $ifNull: ['$resolvedAt', '$expiresAt'] }, '$openedAt'] },
                    60000,
                  ],
                },
                1,
              ],
            },
            null,
          ],
        },
        verdicts: {
          in: { $size: { $filter: { input: { $ifNull: ['$samples', []] }, as: 's', cond: { $eq: ['$$s.verdict', 'in'] } } } },
          out: { $size: { $filter: { input: { $ifNull: ['$samples', []] }, as: 's', cond: { $eq: ['$$s.verdict', 'out'] } } } },
          unknown: {
            $size: { $filter: { input: { $ifNull: ['$samples', []] }, as: 's', cond: { $eq: ['$$s.verdict', 'unknown'] } } },
          },
        },
      },
    },
  };
}

/**
 * A filter-dropdown facet that also remembers which tenant each value came from.
 *
 * When a tenant is picked, every other dropdown should offer only that
 * tenant's users, sites, devices and so on, with that tenant's counts. Doing
 * it in the browser needs the split, so this groups twice: once per
 * (value, tenant), then per value with the tenant counts kept as `byTenant`.
 * One pass over the data, in the facet that was already running - picking a
 * tenant then re-scopes the bar instantly, rather than re-running a
 * six-second /api/meta per tenant.
 *
 * `first` adds accumulators to the inner group and `second` to the outer one;
 * anything the caller needs across tenants (a name, a newest timestamp) has to
 * be carried through both.
 */
function groupWithTenants(keyExpr, tenantExpr, first = {}, second = {}) {
  return [
    { $group: { _id: { k: keyExpr, t: tenantExpr }, n: { $sum: 1 }, ...first } },
    { $group: { _id: '$_id.k', n: { $sum: '$n' }, byTenant: { $push: { t: '$_id.t', n: '$n' } }, ...second } },
  ];
}

/**
 * `[{ t, n }]` -> `{ [tenantId]: n }`.
 *
 * Documents with no tenant are kept under `'null'`, the value the Tenant
 * dropdown sends for "No tenant" - so picking it narrows the other dropdowns
 * to the tenantless documents, as the filter itself now does.
 */
function tenantCounts(list) {
  const out = {};
  for (const x of list || []) {
    const key = x.t === null || x.t === undefined ? 'null' : x.t;
    out[key] = (out[key] || 0) + x.n;
  }
  return out;
}

module.exports = {
  capturedAtExpr,
  heartbeatAtExpr,
  HEARTBEAT_AT,
  accuracyBandExpr,
  ageMinutesExpr,
  computedFields,
  latestPerUser,
  exitWindowStats,
  groupWithTenants,
  tenantCounts,
};
