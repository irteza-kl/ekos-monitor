'use strict';
/**
 * Shift trails: the query, the run index, and the page summary.
 *
 * This lives in lib rather than in the route for the same reason
 * lib/exitWindows.js does - the list is asked for by the page, by the CSV
 * export and (when the user page grows a tab for it) by a second caller, and
 * three implementations of one question give three answers.
 *
 * What a line is: eight fields written by the app - when, which process,
 * which person, which site, which handset, battery, and the live location
 * permission and precision. No coordinates, so nothing here draws a map or
 * judges a fence; that is not a gap in this module, it is the payload.
 */
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('./filters');
const normalize = require('./normalize');
const { SNAP } = require('./filters');

const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

const SORTABLE = ['recordedAt', 'userId', 'siteId', 'batteryPercentage', 'deviceType', 'locationPermission'];

/**
 * `recordedAt` as a Date, whatever the writer sent.
 *
 * The payload shows an ISO string, which may reach Mongo as a string or as a
 * BSON date depending on how the writer builds the document, and the store
 * will hold whichever shapes it has ever written. $dateTrunc, $min and $max
 * all need a real date, so everything that groups or bounds by time converts
 * first. (The payload review asks the writer to settle on one type; this is
 * what keeps the page correct until it does.)
 */
const AT = {
  $convert: { input: '$recordedAt', to: 'date', onError: null, onNull: null },
};

// Same bucketing rule as /api/stats, kept small and local rather than reaching
// into a route module. If a third page needs it, it should move to lib/.
function granularity(q, fallbackHours = 96) {
  if (F.str(q.granularity)) return F.str(q.granularity);
  const from = F.str(q.from) ? new Date(F.str(q.from)) : null;
  const to = F.str(q.to) ? new Date(F.str(q.to)) : new Date();
  const hours = from ? (to - from) / 3600000 : fallbackHours;
  if (hours <= 6) return 'minute15';
  if (hours <= 120) return 'hour';
  return 'day';
}

function truncExpr(unit) {
  if (unit === 'minute15') return { $dateTrunc: { date: AT, unit: 'minute', binSize: 15 } };
  if (unit === 'day') return { $dateTrunc: { date: AT, unit: 'day' } };
  return { $dateTrunc: { date: AT, unit: 'hour' } };
}

/**
 * Who these user ids belong to, and which of them the heartbeats have never
 * seen.
 *
 * The second half is the point. A line names its user outright - unlike an
 * exit window, which carries userId: null and has to be matched by GPS
 * fingerprint - so a person who has only ever produced trail entries is visible here
 * and nowhere else in this console. That is the case the payload exists for,
 * and it can only be identified by asking the heartbeats and coming back
 * empty.
 *
 * `$max` over an object rather than a sort: this is the same unbounded-sort
 * trap attribution.nameDirectMatches was fixed for, and this cluster does not
 * honour allowDiskUse.
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
          { $match: F.and([base, { [SNAP.userId]: { $in: wanted } }]) },
          {
            $group: {
              _id: '$' + SNAP.userId,
              newest: { $max: { at: '$createdAt', name: { $ifNull: ['$' + SNAP.fullName, null] } } },
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
    // No heartbeat collection at all is a legitimate state for a store that
    // only has trail entries. Every user is then simply unnamed, which the page says.
  }
  return { names, seenInHeartbeats };
}

/**
 * Every run in range, ordered per person.
 *
 * A "run" is one (userId, runId) pair: one life of the app process. Two runs
 * for one person inside the range means the process was recreated between
 * them, and the first line of the second run is where that happened - which
 * is the only thing in this store that can point at an app restart.
 *
 * Grouped, never sorted: memory is proportional to the number of runs rather
 * than the number of entries.
 *
 * Two honest limits, both reported to the page rather than papered over:
 *  - A restart is only visible when BOTH runs either side of it are in range,
 *    so the earliest run of each person is never counted as one. A
 *    `runStartedAt` on the payload would remove this limit entirely.
 *  - The payload carries no deviceId, so one person using two handsets at once
 *    is indistinguishable from one handset restarting repeatedly.
 */
async function runIndex(col, match) {
  const runs = await col
    .aggregate(
      [
        { $match: match },
        {
          $group: {
            _id: { userId: '$userId', runId: '$runId' },
            entries: { $sum: 1 },
            // `$min` over an object picks the earliest line AND its id in one
            // pass, which is what marks the row the restart badge belongs on.
            first: { $min: { at: AT, id: '$_id' } },
            lastAt: { $max: AT },
          },
        },
      ],
      opts
    )
    .toArray();

  const byUser = new Map();
  for (const run of runs) {
    const userId = run._id.userId === undefined ? null : run._id.userId;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(run);
  }

  const index = new Map();
  let restarts = 0;
  for (const [userId, list] of byUser) {
    // A run with no readable first timestamp sorts last rather than throwing
    // the whole person's ordering into an arbitrary order.
    list.sort((a, b) => {
      const at = a.first && a.first.at ? new Date(a.first.at).getTime() : Infinity;
      const bt = b.first && b.first.at ? new Date(b.first.at).getTime() : Infinity;
      return at - bt;
    });
    restarts += Math.max(0, list.length - 1);
    list.forEach((run, i) => {
      index.set(key(userId, run._id.runId), {
        ordinal: i + 1,
        of: list.length,
        entries: run.entries,
        firstAt: run.first && run.first.at ? new Date(run.first.at).toISOString() : null,
        lastAt: run.lastAt ? new Date(run.lastAt).toISOString() : null,
        firstId: run.first && run.first.id ? String(run.first.id) : null,
      });
    });
  }

  return { index, runCount: runs.length, restarts, peopleWithRuns: byUser.size };
}

function key(userId, runId) {
  return String(userId === undefined ? null : userId) + '|' + String(runId);
}

/** One page of entries, each carrying its run position and its person's name. */
async function listTrail(q) {
  const { col, base } = await collectionFor('shiftTrails');
  const match = F.and([base, F.shiftTrailMatch(q)]);
  const { limit, page, skip } = F.pagination(q, 100, 2000);
  const sort = F.sortSpec(q, SORTABLE, { recordedAt: -1 });

  // A find() with an indexed sort, not an aggregation: these documents are
  // small and the sort is served by the recordedAt index (npm run indexes), so
  // there is no blocking sort to bound. If this stream ever grows to heartbeat
  // volume WITHOUT that index, it needs the same projection-sort treatment
  // /api/snapshots got - see the README.
  const [docs, total, runs] = await Promise.all([
    col.find(match).sort(sort).skip(skip).limit(limit).maxTimeMS(config.queryTimeoutMs).toArray(),
    col.countDocuments(match, { maxTimeMS: config.queryTimeoutMs }),
    runIndex(col, match),
  ]);

  const rows = docs.map(normalize.shiftTrail);
  const { names, seenInHeartbeats } = await namesFor(rows.map((r) => r.userId));

  for (const row of rows) {
    row.name = names.get(row.userId) || null;
    // The person exists in this stream and nowhere else. Stated per row
    // because it changes what the row means: there is no user page to open,
    // no name to show, and no heartbeat to reconcile it against.
    row.heartbeatKnown = seenInHeartbeats.has(row.userId);

    const run = runs.index.get(key(row.userId, row.runId)) || null;
    row.run = run
      ? {
          ordinal: run.ordinal,
          of: run.of,
          entries: run.entries,
          firstAt: run.firstAt,
          lastAt: run.lastAt,
          isFirstLineOfRun: run.firstId === row.id,
        }
      : null;
    // This row is where a restart is visible: the first line of a run that is
    // not this person's earliest in range.
    row.restart = !!(run && run.ordinal > 1 && run.firstId === row.id);
  }

  return {
    rows,
    total,
    page,
    limit,
    runs: { total: runs.runCount, restarts: runs.restarts, people: runs.peopleWithRuns },
  };
}

/** The tiles and the volume chart: one pass over everything in range. */
async function summary(q) {
  const { col, base } = await collectionFor('shiftTrails');
  const match = F.and([base, F.shiftTrailMatch(q)]);
  const unit = granularity(q);

  const [facet, runs] = await Promise.all([
    col
      .aggregate(
        [
          { $match: match },
          {
            $facet: {
              total: [{ $count: 'value' }],
              users: [{ $group: { _id: '$userId' } }],
              devices: [{ $group: { _id: '$deviceType', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              permissions: [{ $group: { _id: '$locationPermission', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              precisions: [{ $group: { _id: '$locationPrecision', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              sites: [{ $group: { _id: '$siteId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              anonymous: [{ $match: { $or: [{ userId: null }, { userId: { $exists: false } }] } }, { $count: 'value' }],
              battery: [
                {
                  $group: {
                    _id: null,
                    avg: { $avg: '$batteryPercentage' },
                    min: { $min: '$batteryPercentage' },
                    low: { $sum: { $cond: [{ $lte: ['$batteryPercentage', 20] }, 1, 0] } },
                    critical: { $sum: { $cond: [{ $lte: ['$batteryPercentage', 10] }, 1, 0] } },
                    missing: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$batteryPercentage', null] }, null] }, 1, 0] } },
                  },
                },
              ],
              range: [{ $group: { _id: null, min: { $min: AT }, max: { $max: AT } } }],
              timeline: [
                { $group: { _id: truncExpr(unit), n: { $sum: 1 }, users: { $addToSet: '$userId' } } },
                { $project: { n: 1, users: { $size: '$users' } } },
                { $sort: { _id: 1 } },
              ],
            },
          },
        ],
        opts
      )
      .next(),
    runIndex(col, match),
  ]);

  const asList = (arr) => (arr || []).map((x) => ({ key: x._id, count: x.n }));
  const one = (arr) => (arr && arr[0]) || {};
  const userIds = (facet.users || []).map((u) => u._id).filter((u) => u !== null && u !== undefined);
  const { seenInHeartbeats } = await namesFor(userIds);
  const battery = one(facet.battery);
  const rangeRow = one(facet.range);

  return {
    granularity: unit,
    total: one(facet.total).value || 0,
    users: userIds.length,
    // A line with no user id names nobody, so it cannot be attributed at all -
    // there are no GPS samples here to fingerprint the way an exit window is.
    anonymousEntries: one(facet.anonymous).value || 0,
    // The headline number for this payload: people this stream knows about
    // that the heartbeats have never seen.
    usersWithoutHeartbeats: userIds.filter((id) => !seenInHeartbeats.has(id)).length,
    runs: runs.runCount,
    restarts: runs.restarts,
    devices: asList(facet.devices),
    permissions: asList(facet.permissions),
    precisions: asList(facet.precisions),
    sites: asList(facet.sites),
    battery: {
      avg: battery.avg === null || battery.avg === undefined ? null : Math.round(battery.avg * 10) / 10,
      min: battery.min === undefined ? null : battery.min,
      low: battery.low || 0,
      critical: battery.critical || 0,
      missing: battery.missing || 0,
    },
    range: {
      min: rangeRow.min ? new Date(rangeRow.min).toISOString() : null,
      max: rangeRow.max ? new Date(rangeRow.max).toISOString() : null,
    },
    timeline: (facet.timeline || [])
      .filter((t) => t._id)
      .map((t) => ({ at: new Date(t._id).toISOString(), count: t.n, users: t.users })),
  };
}

module.exports = { listTrail, summary, namesFor, runIndex, SORTABLE };
