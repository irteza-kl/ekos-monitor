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

const computedFields = {
  accuracyBand: accuracyBandExpr(),
  ageMinutes: ageMinutesExpr('$createdAt'),
};

/**
 * Newest snapshot per user, with computed fields available to post-filters.
 * Documents with no user id are grouped under the "anonymous" bucket so the
 * dashboard still surfaces devices reporting without a session.
 */
function latestPerUser({ match, postMatch, sort, skip, limit }) {
  return [
    { $match: match || {} },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { $ifNull: ['$' + SNAP.userId, 'anonymous'] },
        doc: { $first: '$$ROOT' },
        snapshotCount: { $sum: 1 },
        firstSeenAt: { $min: '$createdAt' },
        lastSeenAt: { $max: '$createdAt' },
        avgAccuracy: { $avg: '$' + SNAP.accuracy },
        worstAccuracy: { $max: '$' + SNAP.accuracy },
        bestAccuracy: { $min: '$' + SNAP.accuracy },
        insideCount: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', true] }, 1, 0] } },
        outsideCount: { $sum: { $cond: [{ $eq: ['$isInsideGeofence', false] }, 1, 0] } },
        offlineCount: { $sum: { $cond: [{ $eq: ['$isConnected', false] }, 1, 0] } },
        minBattery: { $min: '$batteryPercentage' },
        siteIds: { $addToSet: { $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt] } },
      },
    },
    {
      $replaceRoot: {
        newRoot: {
          $mergeObjects: [
            '$doc',
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
    { $sort: sort || { createdAt: -1 } },
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

module.exports = { accuracyBandExpr, ageMinutesExpr, computedFields, latestPerUser, exitWindowStats };
