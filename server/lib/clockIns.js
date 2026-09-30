'use strict';
/**
 * Clock-ins: one row per time entry - who clocked in, when, where, and how the
 * shift ended.
 *
 * There is no clock-in collection. `validateClockInLogs` holds a single
 * document in stage, so the record has to be assembled from the two places
 * that do carry it:
 *
 *  - **The time entry on every heartbeat.** While somebody is on the clock,
 *    each heartbeat carries `currentUser.data.timeEntry[0]` - the backend's own
 *    record of the shift: its id, clock-in time, network status at clock-in,
 *    site, scheduled shift, facial-verification counts. Grouping heartbeats by
 *    that id gives one row per clock-in, and the heartbeats themselves say what
 *    the device looked like just after it: where it was, whether that was
 *    inside the fence, how good the fix was.
 *
 *  - **The shift trail**, sealed at clock-out. It is the only place a clock-out
 *    time exists: the time entry's `clockOut` is null on every heartbeat in
 *    this store, because once somebody clocks out their heartbeats stop
 *    carrying the entry at all. `shiftKey` is the clock-in in epoch seconds,
 *    so the two join on user + clock-in to the second - 98 of 106 entries in
 *    stage do.
 *
 * Where neither source closed a shift, the row says which of two different
 * things happened rather than guessing a time: the person's newest heartbeat
 * still carries this entry (still on the clock - possibly silent), or they
 * reported later without it (it ended, and nothing recorded when).
 *
 * A trail with no matching time entry is still a clock-in - from a build
 * whose heartbeats did not carry the entry, or a person who never sent a
 * heartbeat - so it gets a row of its own, built from what the trail knows.
 */
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('./filters');
const normalize = require('./normalize');
const geo = require('./geo');
const memo = require('./cache');
const { namesFor, attachSites } = require('./shiftTrails');
const { siteLookup } = require('./sites');

const { SNAP } = F;
const { iso, num: n } = normalize;
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

/** Clocking in more than this after the scheduled start counts as late. */
const LATE_GRACE_MINUTES = 5;
/** An open shift with no heartbeat for this long is "on the clock but silent". */
const SILENT_MINUTES = 60;
/**
 * A first fix later than this after the clock-in says where somebody went,
 * not where they clocked in. It happens: one entry's first heartbeat arrived
 * 4.7 days after its clock-in. Such a fix is still shown, but it is not
 * counted as inside or outside the fence at clock-in.
 */
const FIRST_FIX_STALE_MINUTES = 15;
/** Trails read per request; the same cap the shift-trail export uses. */
const TRAIL_LIMIT = 500;

/**
 * Heartbeats arrive under two envelopes - the user nested in
 * `currentUser.data`, or flat on `currentUser` (16 of the ones carrying a time
 * entry) - and `timeEntry` is an array on one writer and could be an object on
 * another. Everything below reads it through these.
 */
const TE_DATA = 'currentUser.data.timeEntry';
const TE_FLAT = 'currentUser.timeEntry';
const firstOf = (path) => ({ $cond: [{ $isArray: path }, { $arrayElemAt: [path, 0] }, path] });
const TE_EXPR = { $ifNull: [firstOf('$' + TE_DATA), firstOf('$' + TE_FLAT)] };
const USER_EXPR = { $ifNull: ['$' + SNAP.userId, '$currentUser.id'] };
const HAS_TIME_ENTRY = { $or: [{ [TE_DATA + '.id']: { $exists: true } }, { [TE_FLAT + '.id']: { $exists: true } }] };
const ON_THE_CLOCK = { $and: [{ $eq: ['$clockedIn', true] }, { $ne: ['$clockedOut', true] }] };

/**
 * The filters that describe a clock-in rather than a single heartbeat.
 *
 * Accuracy band and the inside-fence flag are properties of one ping: applied
 * to the heartbeats they would keep only the matching pings, and the "first
 * heartbeat after clocking in" would silently become the first matching one.
 * They are left out and the response names them, so the page can say so.
 */
const ENTRY_KEYS = ['from', 'to', 'tenantId', 'userId', 'deviceType', 'appVersion', 'timezone', 'jobSiteId', 'search'];
const TRAIL_KEYS = ['from', 'to', 'tenantId', 'userId', 'deviceType', 'appVersion', 'timezone', 'jobSiteId'];
const NOT_APPLIED = ['accuracyBand', 'insideGeofence', 'where'];

const pick = (q, keys) => Object.fromEntries(keys.filter((k) => q[k] !== undefined).map((k) => [k, q[k]]));
const ms = (v) => (v ? new Date(v).getTime() : null);
const minutesBetween = (a, b) => (a === null || b === null ? null : geo.round((b - a) / 60000, 1));
/** Clock-ins are keyed to the second: the trail's shiftKey drops the milliseconds. */
const joinKey = (userId, clockIn) => (userId == null || !clockIn ? null : userId + ':' + Math.floor(ms(clockIn) / 1000));

/**
 * The scheduled shift, placed on the day of this clock-in.
 *
 * `meta.shiftSchedule` stores its start and end as full instants on an
 * arbitrary February date with a null timezone, so only the time of day
 * means anything. It is read as UTC: "Evening" is 10:00-19:00Z, which is
 * 15:00-00:00 in Karachi where every one of these clock-ins happened, and the
 * clock-ins against it fall between 09:52Z and 18:07Z. Read as the worker's
 * wall clock it would put nearly every Evening clock-in after its shift had
 * ended.
 *
 * Which day's shift a clock-in belongs to is decided by the window, not by
 * whichever start is nearest: nearest turned a Morning clock-in made in the
 * evening, after that day's shift had ended, into "ten hours early" for the
 * next one. A clock-in up to EARLY_WINDOW before a start, or during the
 * shift, belongs to it; anything else belongs to the shift that most
 * recently started, and says it came after that shift ended.
 */
const EARLY_WINDOW_MINUTES = 4 * 60;

function scheduleFor(te, clockIn) {
  const s = te && te.meta && te.meta.shiftSchedule;
  if (!s) return null;
  const start = ms(s.shiftStartTime);
  const end = ms(s.shiftEndMinutes);
  const inMs = ms(clockIn);
  const out = {
    id: n(s.id), name: s.name || null, timeZone: s.timeZone || null,
    start: null, end: null, lateMinutes: null, afterEnd: false,
  };
  if (start === null || Number.isNaN(start) || inMs === null) return out;

  const DAY = 86400000;
  const startOfDay = (t) => t - (((t % DAY) + DAY) % DAY);
  const startTod = start - startOfDay(start);
  // Nine hours for "Evening" 10:00 to 19:00; a whole day when the end is missing.
  const length =
    end !== null && !Number.isNaN(end) ? (((end - startOfDay(end) - startTod) % DAY) + DAY) % DAY || DAY : DAY;
  const base = startOfDay(inMs) + startTod;
  const starts = [base - DAY, base, base + DAY];
  const scheduled =
    starts.find((t) => inMs >= t - EARLY_WINDOW_MINUTES * 60000 && inMs <= t + length) ??
    starts.filter((t) => t <= inMs).pop();

  out.start = new Date(scheduled).toISOString();
  out.end = end !== null && !Number.isNaN(end) ? new Date(scheduled + length).toISOString() : null;
  out.lateMinutes = minutesBetween(scheduled, inMs);
  out.afterEnd = inMs > scheduled + length;
  return out;
}

/** Where the device was, judged against the fence it was clocked into. */
function judge(point, accuracy, fence) {
  if (!point) return { verdict: 'unknown', reason: 'no fix on that heartbeat', relation: null };
  if (!fence) return { verdict: 'unknown', reason: 'no geofence on record for this site', relation: null };
  return geo.verdictWithAccuracy(point, fence, accuracy);
}

/**
 * The site as the heartbeat had it, else as the registry has it. The
 * heartbeat's copy wins because it is contemporaneous: a fence moved since
 * does not rewrite whether this clock-in was inside it.
 */
function resolveSite(siteId, fromBeat, registry) {
  const known = siteId != null ? registry[siteId] : null;
  const beatFence =
    fromBeat && n(fromBeat.lat) !== null && n(fromBeat.lng) !== null
      ? { lat: n(fromBeat.lat), lng: n(fromBeat.lng), radius: n(fromBeat.radius) }
      : null;
  const registryFence = known && known.hasFence ? { lat: known.lat, lng: known.lng, radius: known.radius } : null;
  if (siteId == null && !fromBeat) return null;
  return {
    siteId,
    name: (fromBeat && fromBeat.name) || (known && known.name) || null,
    displayName: (known && known.displayName) || null,
    address: (fromBeat && fromBeat.address) || (known && known.address) || null,
    fence: beatFence || registryFence,
    fenceSource: beatFence ? 'heartbeat' : registryFence ? 'registry' : null,
  };
}

/** The trail's facts that matter beside a clock-in, without its entries. */
function trailBrief(t) {
  return {
    id: t.id,
    shiftKey: t.shiftKey,
    durationMinutes: t.durationMinutes,
    coverage: t.stats.coverage,
    positionedMinutes: t.stats.positionedMinutes,
    runtimeStarts: t.stats.runtimeStartCount,
    absences: t.absenceCount,
    absentMinutes: t.absentMinutes,
    insideShare: t.fence ? t.fence.insideShare : null,
    sealedAt: t.sealedAt,
  };
}

/** A clock-in the heartbeats recorded, closed by its trail where there is one. */
function fromTimeEntry(g, trail, userNewestAt, registry, now) {
  const te = (g.newest && g.newest.te) || {};
  const first = g.first || {};
  const last = g.last || {};
  const beat = g.newest || {};

  const clockIn = iso(te.clockIn) || iso(te.shiftStart) || (trail && trail.clockIn) || iso(first.at);
  const inMs = ms(clockIn);
  const lastAt = iso(last.at);
  const lastOnMs = ms(g.lastOnAt);

  /**
   * A heartbeat that still carried the entry but said it was off the clock is
   * the device's own report of the clock-out. Measured in stage: 29 of 106
   * entries have one, nearly always a run of on-the-clock heartbeats and then
   * a single off one ~30 s later. So the clock-out is the first off heartbeat
   * after the LAST on one - not after the first, because one entry flips on
   * and off four times and "first off" put its clock-out mid-shift - and the
   * gap between those two heartbeats is how precise it is.
   *
   * An entry that was never seen on the clock (two in stage, their only
   * heartbeats arriving days later already off) has no clock-out to read:
   * the first off heartbeat dates the phone reconnecting, not the shift
   * ending, and it is reported as not recorded instead.
   */
  const offAt =
    lastOnMs === null
      ? undefined
      : (g.offTimes || [])
          .filter(Boolean)
          .map((t) => new Date(t).getTime())
          .filter((t) => t > lastOnMs)
          .sort((a, b) => a - b)[0];

  let clockOut = null;
  let clockOutSource = null;
  let clockOutWithinMinutes = null;
  let state;
  if (trail && trail.clockOut) {
    clockOut = trail.clockOut;
    clockOutSource = 'trail';
    state = 'closed';
  } else if (iso(te.clockOut)) {
    clockOut = iso(te.clockOut);
    clockOutSource = 'timeEntry';
    state = 'closed';
  } else if (offAt !== undefined) {
    clockOut = new Date(offAt).toISOString();
    clockOutSource = 'heartbeat';
    clockOutWithinMinutes = minutesBetween(lastOnMs, offAt);
    state = 'closed';
  } else if (lastOnMs === null || (userNewestAt && lastAt && ms(userNewestAt) > ms(lastAt) + 1000)) {
    // They reported again without this entry, or it was only ever seen off
    // the clock: it ended, and nothing said when.
    state = 'unclosed';
  } else {
    state = 'open';
  }

  // An unclosed shift runs at least to its last on-the-clock heartbeat; one
  // never seen on the clock has no length to report at all.
  const endMs = state === 'closed' ? ms(clockOut) : state === 'open' ? now : lastOnMs;

  const siteId = n(te.siteAreaId) ?? n(beat.site && beat.site.id) ?? n(beat.job) ?? (trail ? trail.siteId : null);
  // The heartbeat's copy of the site only when it is the same site: an empty
  // siteDetails would otherwise turn "no site" into a nameless one.
  const beatSite = siteId !== null && beat.site && n(beat.site.id) === siteId ? beat.site : null;
  const site = resolveSite(siteId, beatSite, registry);

  const point = n(first.lat) !== null && n(first.lng) !== null ? { lat: n(first.lat), lng: n(first.lng) } : null;
  const accuracy = n(first.acc);
  const judged = judge(point, accuracy, site && site.fence);
  const timezone = first.tz || beat.tz || (trail && trail.timezone) || null;

  return {
    id: 'te:' + g._id,
    timeEntryId: n(g._id),
    shiftKey: trail ? trail.shiftKey : null,
    sources: trail ? ['heartbeats', 'trail'] : ['heartbeats'],

    userId: n(g.u),
    name: beat.name || null,
    employeeRef: beat.ref || null,
    tenantId: n(te.tenantId) ?? (trail ? trail.tenantId : null),
    tenantName: beat.tenantName || null,
    timezone,

    siteId,
    site,

    clockIn,
    date: te.date || null,
    clockInNetwork: te.clockInNetworkStatus || null,
    offlineClockIn: te.clockInNetworkStatus === 'OFFLINE',
    // Set on 71 of 106 entries, always a few minutes before the clock-in: the
    // backend's record of the fence being reached.
    fenceArrivalAt: iso(te.geoFenceClockIn),
    fenceArrivalLeadMinutes: iso(te.geoFenceClockIn) ? minutesBetween(ms(te.geoFenceClockIn), inMs) : null,

    state,
    clockOut,
    clockOutSource,
    clockOutNetwork: te.clockOutNetworkStatus || null,
    clockOutMethod: te.clockOutMethod || null,
    // Only for a clock-out read off a heartbeat: it happened at most this
    // long before the time shown.
    clockOutWithinMinutes,
    durationMinutes: inMs !== null && endMs !== null ? minutesBetween(inMs, endMs) : null,
    // For an unclosed shift the duration runs to the last heartbeat that
    // carried it, so it is a floor, not a length.
    durationIsFloor: state === 'unclosed',
    lastOnClockAt: lastOnMs === null ? null : new Date(lastOnMs).toISOString(),
    silentMinutes: state === 'open' && lastAt ? minutesBetween(ms(lastAt), now) : null,

    schedule: scheduleFor(te, clockIn),

    atClockIn: {
      at: iso(first.at),
      delayMinutes: inMs !== null && first.at ? minutesBetween(inMs, ms(first.at)) : null,
      stale: inMs !== null && first.at ? ms(first.at) - inMs > FIRST_FIX_STALE_MINUTES * 60000 : false,
      source: 'heartbeat',
      location: point ? { ...point, accuracy } : null,
      accuracy,
      accuracyBand: geo.accuracyBand(accuracy),
      deviceInside: first.inside === true ? true : first.inside === false ? false : null,
      verdict: judged.verdict,
      verdictReason: judged.reason,
      distanceFromBoundary: judged.relation ? judged.relation.distanceFromBoundary : null,
      compass: judged.relation ? judged.relation.compass : null,
      battery: n(first.battery),
      offline: first.offline === true,
    },

    heartbeats: { count: g.beats, offline: g.offlineBeats },
    device: { type: first.device || null, appVersion: first.app || null, build: first.build || null },
    facial: {
      required: n(te.requiredFacialVerification),
      completed: n(te.completedFacialVerification),
      intervalSeconds: n(te.facialVerificationInterval),
    },
    status: te.status || null,
    reviewStatus: te.reviewStatus || null,
    trail: trail ? trailBrief(trail) : null,
  };
}

/** A clock-in only its trail knows about. */
function fromTrail(t, name, registry) {
  const site = t.site
    ? { ...t.site, fenceSource: t.site.fence ? 'registry' : null }
    : resolveSite(t.siteId, null, registry);
  const fix = t.firstFix;
  const point = fix ? { lat: fix.lat, lng: fix.lng } : null;
  const judged = judge(point, fix ? fix.accuracy : null, site && site.fence);
  const inMs = ms(t.clockIn);

  return {
    id: 'trail:' + t.id,
    timeEntryId: null,
    shiftKey: t.shiftKey,
    sources: ['trail'],

    userId: t.userId,
    name: name || null,
    employeeRef: null,
    tenantId: t.tenantId,
    tenantName: null,
    timezone: t.timezone,

    siteId: t.siteId,
    site,

    clockIn: t.clockIn,
    date: null,
    clockInNetwork: null,
    offlineClockIn: false,
    fenceArrivalAt: null,
    fenceArrivalLeadMinutes: null,

    state: t.clockOut ? 'closed' : 'unclosed',
    clockOut: t.clockOut,
    clockOutSource: t.clockOut ? 'trail' : null,
    clockOutNetwork: null,
    clockOutMethod: null,
    clockOutWithinMinutes: null,
    durationMinutes: t.durationMinutes,
    durationIsFloor: false,
    lastOnClockAt: null,
    silentMinutes: null,

    schedule: null,

    atClockIn: {
      at: fix ? fix.at : null,
      delayMinutes: fix && inMs !== null ? minutesBetween(inMs, ms(fix.at)) : null,
      stale: fix && inMs !== null ? ms(fix.at) - inMs > FIRST_FIX_STALE_MINUTES * 60000 : false,
      source: 'trail',
      location: point ? { ...point, accuracy: fix.accuracy } : null,
      accuracy: fix ? fix.accuracy : null,
      accuracyBand: geo.accuracyBand(fix ? fix.accuracy : null),
      deviceInside: null,
      verdict: judged.verdict,
      verdictReason: judged.reason,
      distanceFromBoundary: judged.relation ? judged.relation.distanceFromBoundary : null,
      compass: judged.relation ? judged.relation.compass : null,
      battery: t.stats.batteryStart,
      offline: false,
    },

    heartbeats: { count: 0, offline: 0 },
    device: { type: t.deviceType, appVersion: t.appVersion, build: t.buildVersion },
    facial: { required: null, completed: null, intervalSeconds: null },
    status: null,
    reviewStatus: null,
    trail: trailBrief(t),
  };
}

/** Clock-ins the heartbeats show as active inside the window. */
async function activeEntries(col, base, q) {
  return col
    .aggregate(
      [
        { $match: F.and([base, F.snapshotMatch(pick(q, ENTRY_KEYS)), HAS_TIME_ENTRY]) },
        { $project: { _id: 0, te: TE_EXPR, u: USER_EXPR } },
        { $group: { _id: '$te.id', u: { $first: '$u' }, clockIn: { $first: '$te.clockIn' } } },
        { $match: { _id: { $ne: null } } },
      ],
      opts
    )
    .toArray();
}

/**
 * Every heartbeat of those people that carried a time entry, from the
 * earliest clock-in on. Not the window's heartbeats: a clock-in that began
 * before the window would otherwise report its first heartbeat IN the
 * window as the one after clocking in.
 *
 * `$min`/`$max` over objects led by the timestamp, not a sort: this cluster
 * does not honour allowDiskUse, and ordering every heartbeat to read the
 * first and last is the unbounded sort this project has been bitten by twice.
 */
async function entryHistory(col, base, users, since) {
  const who = { $or: [{ [SNAP.userId]: { $in: users } }, { 'currentUser.id': { $in: users } }] };
  return col
    .aggregate(
      [
        { $match: F.and([base, who, since ? { createdAt: { $gte: since } } : null, HAS_TIME_ENTRY]) },
        {
          $project: {
            _id: 0,
            at: '$createdAt',
            te: TE_EXPR,
            u: USER_EXPR,
            name: { $ifNull: ['$' + SNAP.fullName, '$currentUser.fullName'] },
            ref: firstOf({ $ifNull: ['$' + SNAP.employeeRef, '$currentUser.tenantAccount.employeeReferenceId'] }),
            tenantName: firstOf({ $ifNull: ['$' + SNAP.tenantName, '$currentUser.tenantAccount.tenant.name'] }),
            tz: '$timezone',
            device: '$deviceType',
            app: '$' + SNAP.appVersion,
            build: '$' + SNAP.build,
            lat: '$' + SNAP.lat,
            lng: '$' + SNAP.lng,
            acc: '$' + SNAP.accuracy,
            battery: '$batteryPercentage',
            inside: '$isInsideGeofence',
            clockedIn: '$clockedIn',
            clockedOut: '$clockedOut',
            offline: { $or: [{ $eq: ['$isConnected', false] }, { $eq: ['$isReachable', false] }] },
            job: { $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt] },
            site: {
              id: '$siteDetails.id',
              name: '$siteDetails.name',
              address: { $ifNull: ['$siteDetails.address', '$siteDetails.formattedAddress'] },
              lat: '$siteDetails.latitude',
              lng: '$siteDetails.longitude',
              radius: '$siteDetails.radiusMeters',
            },
          },
        },
        { $match: { 'te.id': { $ne: null } } },
        {
          $group: {
            _id: '$te.id',
            u: { $first: '$u' },
            first: {
              $min: {
                at: '$at', lat: '$lat', lng: '$lng', acc: '$acc', inside: '$inside', battery: '$battery',
                offline: '$offline', device: '$device', app: '$app', build: '$build', tz: '$tz',
              },
            },
            last: { $max: { at: '$at' } },
            // The newest copy of the entry: facial-verification counts and the
            // like move during the shift.
            newest: {
              $max: {
                at: '$at', te: '$te', name: '$name', ref: '$ref', tenantName: '$tenantName',
                tz: '$tz', site: '$site', job: '$job',
              },
            },
            beats: { $sum: 1 },
            offlineBeats: { $sum: { $cond: ['$offline', 1, 0] } },
            // On the clock means clockedIn and not clockedOut; anything else
            // carrying the entry is off it. $max ignores the nulls.
            lastOnAt: { $max: { $cond: [ON_THE_CLOCK, '$at', null] } },
            // A set, so the nulls from every on-the-clock heartbeat collapse to one.
            offTimes: { $addToSet: { $cond: [ON_THE_CLOCK, null, '$at'] } },
          },
        },
      ],
      opts
    )
    .toArray();
}

/** Each person's newest heartbeat, to tell a shift still open from one that ended unrecorded. */
async function newestPerUser(col, base, users, since) {
  const who = { $or: [{ [SNAP.userId]: { $in: users } }, { 'currentUser.id': { $in: users } }] };
  const rows = await col
    .aggregate(
      [
        { $match: F.and([base, who, since ? { createdAt: { $gte: since } } : null]) },
        { $group: { _id: USER_EXPR, at: { $max: '$createdAt' } } },
      ],
      opts
    )
    .toArray();
  return new Map(rows.map((r) => [r._id, iso(r.at)]));
}

/**
 * Trails, as rows. Either the ones overlapping the window (capped, newest
 * first) or the ones sealing particular clock-ins, found by shiftKey.
 */
async function loadTrails(filter, limit) {
  try {
    const { col, base } = await collectionFor('shiftTrails');
    let cursor = col.find(F.and([base, filter])).sort({ clockOut: -1 }).maxTimeMS(config.queryTimeoutMs);
    if (limit) cursor = cursor.limit(limit);
    const rows = (await cursor.toArray()).map(normalize.shiftTrail);
    await attachSites(rows);
    return rows;
  } catch (err) {
    // No trails yet is a normal state: the clock-ins still come from heartbeats.
    if (err.code === 'COLLECTION_MISSING') return [];
    throw err;
  }
}

/**
 * The trail that sealed each of these clock-ins, whether or not it made the
 * window's capped list. Without this the cap decided which shifts had a
 * clock-out: over a long range, an entry whose trail fell past the 500th
 * would have read "not recorded" with its trail sitting in the store.
 * `shiftKey` is indexed, and is the clock-in in epoch seconds.
 */
async function trailsFor(entries, have) {
  const keys = [...new Set(
    entries
      .map((a) => (a.clockIn ? String(Math.floor(ms(a.clockIn) / 1000)) : null))
      .filter((k) => k && !Number.isNaN(Number(k)) && !have.has(k))
  )];
  const users = [...new Set(entries.map((a) => a.u).filter((u) => u != null))];
  const found = [];
  for (let i = 0; i < keys.length; i += 1000) {
    found.push(...(await loadTrails({ shiftKey: { $in: keys.slice(i, i + 1000) }, userId: { $in: users } })));
  }
  return found;
}

/**
 * Filters that need the finished row.
 *
 * `searched` is the set of entries the heartbeat search matched in Mongo,
 * over fields a row does not carry (email, phone). Every other row - a trail
 * with no entry, or an entry pulled in only because its trail overlaps the
 * window - never went through that search, so it is matched here on what it
 * does carry. Skipping those let a search for nobody return 98 clock-ins.
 */
function postFilter(rows, q, searched) {
  const sites = F.list(q.jobSiteId);
  const siteIds = sites.map(Number).filter(Number.isFinite);
  const wantsNoSite = sites.some((s) => s === 'null' || s === 'none');
  const clockedIn = F.bool(q.clockedIn);
  const search = F.str(q.search);
  const rx = search ? new RegExp(F.escapeRegex(search), 'i') : null;

  return rows.filter((r) => {
    if (sites.length && !(siteIds.includes(r.siteId) || (wantsNoSite && r.siteId == null))) return false;
    if (clockedIn === true && r.state !== 'open') return false;
    if (clockedIn === false && r.state === 'open') return false;
    if (rx && !(r.timeEntryId !== null && searched.has(r.timeEntryId))) {
      // Text as a substring, ids exactly - the way the heartbeat search reads
      // a number. As a substring, "151" also matched every shift key with
      // those digits in it.
      const text = [r.name, r.employeeRef, r.tenantName, r.timezone].filter(Boolean).join(' ');
      const asId = Number(search);
      const idHit =
        r.shiftKey === search ||
        (Number.isFinite(asId) && [r.userId, r.siteId, r.tenantId, r.timeEntryId].includes(asId));
      if (!rx.test(text) && !idHit) return false;
    }
    return true;
  });
}

function totalsOf(rows) {
  const count = (fn) => rows.filter(fn).length;
  const scheduled = rows.filter((r) => r.schedule && r.schedule.lateMinutes !== null);
  // Judged means there was a fix close enough to the clock-in to speak for
  // it, and a fence to hold it against.
  const judged = rows.filter((r) => r.atClockIn.location && !r.atClockIn.stale && r.site && r.site.fence);
  const facial = rows.filter((r) => r.facial.required > 0);
  return {
    total: rows.length,
    users: new Set(rows.map((r) => r.userId)).size,
    sites: new Set(rows.map((r) => r.siteId).filter((s) => s != null)).size,
    open: count((r) => r.state === 'open'),
    openSilent: count((r) => r.state === 'open' && r.silentMinutes !== null && r.silentMinutes >= SILENT_MINUTES),
    closed: count((r) => r.state === 'closed'),
    closedByTrail: count((r) => r.clockOutSource === 'trail'),
    closedByHeartbeat: count((r) => r.clockOutSource === 'heartbeat'),
    unclosed: count((r) => r.state === 'unclosed'),
    offlineClockIns: count((r) => r.offlineClockIn),
    outsideAtClockIn: judged.filter((r) => r.atClockIn.verdict === 'out').length,
    insideAtClockIn: judged.filter((r) => r.atClockIn.verdict === 'in').length,
    staleFirstFix: count((r) => r.atClockIn.stale),
    uncertainAtClockIn: judged.filter((r) => r.atClockIn.verdict === 'unknown').length,
    judgedAtClockIn: judged.length,
    noSite: count((r) => r.siteId == null),
    scheduled: scheduled.length,
    late: scheduled.filter((r) => r.schedule.lateMinutes > LATE_GRACE_MINUTES).length,
    afterShiftEnded: scheduled.filter((r) => r.schedule.afterEnd).length,
    facialRequired: facial.length,
    facialBehind: facial.filter((r) => (r.facial.completed || 0) < r.facial.required).length,
    trailOnly: count((r) => r.timeEntryId === null),
    withoutTrail: count((r) => r.timeEntryId !== null && !r.trail),
  };
}

/** The response for a store with no heartbeats to read clock-ins from. */
function emptyResult(reason) {
  return {
    generatedAt: new Date().toISOString(),
    totals: totalsOf([]),
    rows: [],
    trailsCapped: false,
    notApplied: [],
    thresholds: {
      lateGraceMinutes: LATE_GRACE_MINUTES,
      silentMinutes: SILENT_MINUTES,
      firstFixStaleMinutes: FIRST_FIX_STALE_MINUTES,
    },
    unavailable: reason,
  };
}

async function clockIns(q = {}) {
  const now = Date.now();
  let snapshots;
  try {
    snapshots = await collectionFor('snapshots');
  } catch (err) {
    if (err.code === 'COLLECTION_MISSING') return emptyResult(err.message);
    throw err;
  }
  const { col, base } = snapshots;
  const [active, windowTrails, registry] = await Promise.all([
    activeEntries(col, base, q),
    loadTrails(F.shiftTrailMatch(pick(q, TRAIL_KEYS)), TRAIL_LIMIT),
    siteLookup().catch(() => ({})),
  ]);
  const sealing = await trailsFor(active, new Set(windowTrails.map((t) => t.shiftKey)));
  const trails = windowTrails.concat(sealing.filter((t) => !windowTrails.some((w) => w.id === t.id)));

  const activeIds = new Set(active.map((a) => a._id));
  const trailByKey = new Map();
  for (const t of trails) {
    const key = joinKey(t.userId, t.clockIn);
    if (key && !trailByKey.has(key)) trailByKey.set(key, t);
  }

  const users = [...new Set([...active.map((a) => a.u), ...trails.map((t) => t.userId)].filter((u) => u != null))];
  const starts = [...active.map((a) => ms(a.clockIn)), ...trails.map((t) => ms(t.clockIn))].filter((t) => t !== null && !Number.isNaN(t));
  // A heartbeat carrying an entry is never older than its clock-in; the minute
  // of slack covers a device clock running behind the server's.
  const since = starts.length ? new Date(Math.min(...starts) - 60000) : null;

  const [groups, newest] = users.length
    ? await Promise.all([entryHistory(col, base, users, since), newestPerUser(col, base, users, since)])
    : [[], new Map()];

  const used = new Set();
  const rows = [];
  for (const g of groups) {
    const te = (g.newest && g.newest.te) || {};
    const key = joinKey(g.u, iso(te.clockIn));
    const trail = key ? trailByKey.get(key) : null;
    // History reaches back past the window, so keep only the clock-ins that
    // were active in it or whose shift overlaps it.
    if (!activeIds.has(g._id) && !trail) continue;
    if (trail) used.add(trail.id);
    rows.push(fromTimeEntry(g, trail, newest.get(g.u), registry, now));
  }

  // Only a trail in the window stands as a clock-in of its own; one fetched to
  // seal an entry and not matched to it is outside the window.
  const orphans = windowTrails.filter((t) => !used.has(t.id));
  if (orphans.length) {
    const { names } = await namesFor(orphans.map((t) => t.userId));
    for (const t of orphans) rows.push(fromTrail(t, names.get(t.userId), registry));
  }

  // A person the trail names is often named by a heartbeat row too.
  const nameOf = new Map(rows.filter((r) => r.name).map((r) => [r.userId, r.name]));
  for (const r of rows) if (!r.name && nameOf.has(r.userId)) r.name = nameOf.get(r.userId);

  // Latest clock-in first. A shift left open days ago sorts by its clock-in
  // like any other; the "Still on the clock" tile counts it wherever it lands.
  const searched = new Set([...activeIds].map((id) => n(id)));
  const filtered = postFilter(rows, q, searched).sort((a, b) => (ms(b.clockIn) || 0) - (ms(a.clockIn) || 0));

  return {
    generatedAt: new Date(now).toISOString(),
    totals: totalsOf(filtered),
    rows: filtered,
    // Only trail-only clock-ins can be missing when this is set: every entry's
    // own trail is fetched by key regardless.
    trailsCapped: windowTrails.length >= TRAIL_LIMIT,
    notApplied: NOT_APPLIED.filter((k) => F.str([].concat(q[k] || '')[0]) !== null),
    thresholds: {
      lateGraceMinutes: LATE_GRACE_MINUTES,
      silentMinutes: SILENT_MINUTES,
      firstFixStaleMinutes: FIRST_FIX_STALE_MINUTES,
    },
  };
}

/**
 * Cached per filter set. Paging is not part of the key: every page of one
 * filter set, and its CSV, is a slice of the same answer, and keying on
 * `offset` would re-run the whole aggregation for each page turned.
 */
const PAGING_KEYS = new Set(['limit', 'offset', 'page']);
const store = memo.create({ ttlMs: 60 * 1000, maxKeys: 8 });
function clockInsCached(q = {}) {
  const filters = Object.fromEntries(Object.entries(q).filter(([k]) => !PAGING_KEYS.has(k)));
  return store.through(filters, () => clockIns(filters));
}

module.exports = { clockIns, clockInsCached, scheduleFor, joinKey, LATE_GRACE_MINUTES, SILENT_MINUTES };
