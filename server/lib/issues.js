'use strict';
const { collectionFor } = require('../db');
const config = require('../config');
const F = require('./filters');
const { SNAP, LOG } = F;
const P = require('./pipelines');
const normalize = require('./normalize');
const geo = require('./geo');
const { getSites } = require('./sites');
const { fenceTimeCached } = require('./fence');

/**
 * Problem detection: a ranked list of named faults rather than counts to be
 * interpreted, grouped by who has to act - PEOPLE in the field, or the APP.
 *
 * A detector only fires on evidence in the data, and nothing is rolled into a
 * health score, because one number that falls for unrelated reasons tells nobody
 * what to do. A supported flow is not a fault however odd it looks - clocking in
 * with no site geofence is normal here - so when in doubt, ask rather than guess.
 */

const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

// The thresholds the rest of the dashboard uses, so the feed and the pages it
// links to never disagree.
const LOW_BATTERY = 20;
const CRITICAL_BATTERY = 10;
const STALE_MINUTES = 15;
const POOR_ACCURACY = 50;
const UNUSABLE_ACCURACY = 100;
/** Ten minutes of silence is a fault and thirty is an outage, whatever the
 *  device's habits. Same numbers the Heartbeats page draws. */
const GAP_WARN_MS = 10 * 60 * 1000;
const GAP_CRITICAL_MS = 30 * 60 * 1000;
/**
 * Flat thresholds alone mis-read this fleet. Cadence spans a factor of seventy:
 * one device lands a heartbeat every second, another every five minutes. Nine
 * minutes of silence from the first is a dead app that no flat ten-minute rule
 * catches, while ten minutes from the second is barely two missed beats.
 *
 * So each device is also compared against its own median gap. The multiple is
 * deliberately large, and a floor applies underneath it, because a multiple of
 * a one-second cadence is still only seconds and nobody needs telling about it.
 */
const CADENCE_MULTIPLE = 20;
const CADENCE_FLOOR_MS = 3 * 60 * 1000;
/** Kept per device, so a gap discarded as off-clock can fall back to the next. */
const GAPS_PER_USER = 8;
/** A fence entry with no exit, standing this long, is a state worth questioning. */
const NEVER_EXITED_STALE_MS = 6 * 60 * 60 * 1000;
/** This long on the clock with no fence verdict at all is worth naming. */
const NO_VERDICT_MS = 2 * 60 * 60 * 1000;
/** Crossings flapping faster than this are the fence arguing with itself. */
const JITTER_VISITS_MIN = 4;
/** Device clock this far from server time makes its own timestamps unusable. */
const CLOCK_DRIFT_SECONDS = 120;
/** A fence this far from the device it is judging is not that device's fence. */
const FENCE_SANITY_METRES = 1000;

const SEVERITY_RANK = { critical: 0, serious: 1, warning: 2, info: 3 };
const WHO_LIMIT = 6;

/**
 * @returns {{generatedAt, issues: Array, byUser: Array, counts: Object}}
 */
async function detect(query = {}) {
  const q = query;
  const issues = [];
  const unavailable = [];

  // Names seen while detecting, keyed by user id. fromLatestSnapshots reads the
  // newest heartbeat for every user in range, so it can name the whole fleet -
  // not only the people it happens to raise an issue about.
  const nameHints = new Map();

  const results = await Promise.all([
    fromLatestSnapshots(q, nameHints).catch(collectionMissing(unavailable, 'heartbeats')),
    fromHeartbeatGaps(q).catch(collectionMissing(unavailable, 'heartbeat gaps')),
    fromClockInChecks(q).catch(collectionMissing(unavailable, 'geofence checks')),
    fromExitWindows(q).catch(collectionMissing(unavailable, 'exit windows')),
    fromSiteRegistry(q).catch(collectionMissing(unavailable, 'site registry')),
    fromFenceTime(q, nameHints).catch(collectionMissing(unavailable, 'time on site')),
    fromNetwork(q, nameHints).catch(collectionMissing(unavailable, 'network state')),
  ]);

  for (const found of results) issues.push(...(found || []));

  // Detectors read different collections and only some of them see a name:
  // validateClockInLogs and exit_window documents carry a userId alone, while
  // heartbeats carry fullName. Left alone the same person appears as "Willy
  // Wonka" in one row and "user 98" in the next, and the per-person roll-up
  // splits them or picks whichever it saw first.
  const names = new Map(nameHints);
  for (const i of issues) {
    for (const w of (i && i.who) || []) {
      if (w.userId === null || w.userId === undefined) continue;
      if (isPlaceholderName(w.name)) continue;
      if (!names.has(w.userId)) names.set(w.userId, w.name);
    }
  }

  // Anyone still nameless was raised by a detector that never sees a name AND
  // has no heartbeat in this range - a clock-in check from earlier in the day,
  // say. A name is not time-scoped, so it is worth one targeted lookup rather
  // than showing an id to a human.
  const nameless = new Set();
  for (const i of issues) {
    for (const w of (i && i.who) || []) {
      if (w.userId === null || w.userId === undefined) continue;
      if (!names.has(w.userId)) nameless.add(w.userId);
    }
  }
  if (nameless.size) {
    for (const [id, name] of await lookUpNames([...nameless])) names.set(id, name);
  }

  for (const i of issues) {
    for (const w of (i && i.who) || []) {
      const better = names.get(w.userId);
      if (better) w.name = better;
    }
  }

  const ranked = issues
    .filter((i) => i && i.count > 0)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);

  return {
    generatedAt: new Date().toISOString(),
    issues: ranked,
    byUser: rollUpByUser(ranked),
    counts: {
      critical: ranked.filter((i) => i.severity === 'critical').length,
      serious: ranked.filter((i) => i.severity === 'serious').length,
      warning: ranked.filter((i) => i.severity === 'warning').length,
      info: ranked.filter((i) => i.severity === 'info').length,
      people: ranked.filter((i) => i.group === 'people').length,
      app: ranked.filter((i) => i.group === 'app').length,
    },
    unavailable,
  };
}

/** A missing collection is a gap in coverage, not an error - say so and go on. */
const collectionMissing = (sink, label) => (err) => {
  if (err && err.code === 'COLLECTION_MISSING') {
    sink.push(label);
    return [];
  }
  throw err;
};

// ---------------------------------------------------------------------------
// issue construction
// ---------------------------------------------------------------------------

/** `who` is truncated for display but counted in full via whoTotal. */
function issue({ id, group, severity, title, count, unit, detail, who, lastAt, href, evidence, extra }) {
  // Collapse identical entries. Fifty windows that all say "no user on the
  // document" is one fact repeated, and reads as noise beside a named person.
  const seen = new Set();
  const people = (who || []).filter((w) => {
    if (!w) return false;
    const key = w.name + '|' + (w.note || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    id,
    group,
    severity,
    title,
    count,
    unit: unit || 'device',
    detail,
    who: people.slice(0, WHO_LIMIT),
    whoTotal: people.length,
    lastAt: lastAt || null,
    href: href || null,
    evidence,
    ...(extra || {}),
  };
}

/** Rows -> a `who` entry, with whatever number makes the row worth reading. */
const whoOf = (row, note) => ({ userId: row.userId, name: row.name || (row.userId ? 'user ' + row.userId : 'no session'), note: note || null });

/**
 * userId -> fullName, for ids no heartbeat in range could name. Deliberately
 * unfiltered by date: who someone is does not depend on the window being viewed.
 */
async function lookUpNames(ids) {
  const found = new Map();
  try {
    const { col } = await collectionFor('snapshots');
    const rows = await col
      .aggregate(
        [
          { $match: { [SNAP.userId]: { $in: ids } } },
          { $group: { _id: '$' + SNAP.userId, name: { $first: '$' + SNAP.fullName } } },
        ],
        opts
      )
      .toArray();
    for (const r of rows) if (r.name) found.set(r._id, r.name);
  } catch (err) {
    if (err.code !== 'COLLECTION_MISSING') throw err;
  }
  return found;
}

/** "user 98" and "no session" are stand-ins, not names. */
const isPlaceholderName = (name) => !name || /^user \d+$/.test(name) || name === 'no session';

const newest = (rows, field) =>
  rows.reduce((max, r) => (r[field] && (!max || r[field] > max) ? r[field] : max), null);

// ---------------------------------------------------------------------------
// 1. the current state of every device
// ---------------------------------------------------------------------------

/** The "right now" half: one row per user, newest heartbeat only. */
async function fromLatestSnapshots(q, nameHints) {
  const { col, base } = await collectionFor('snapshots');
  const match = F.and([base, F.snapshotMatch(q)]);
  const latest = await col
    .aggregate(P.latestPerUser({ match, postMatch: F.snapshotPostMatch(q), sort: { createdAt: -1 }, skip: 0, limit: 500 }), opts)
    .next();
  const rows = (latest.rows || []).map((doc) => normalize.snapshot(doc));
  if (!rows.length) return [];

  // Every user who reported in range, named. Detectors that read the other
  // collections only ever see a userId.
  if (nameHints) {
    for (const r of rows) if (r.userId !== null && r.name) nameHints.set(r.userId, r.name);
  }

  const sites = await getSites({ from: F.str(q.from), to: F.str(q.to) }).catch(() => []);
  const siteById = new Map(sites.filter((s) => s.siteId != null).map((s) => [s.siteId, s]));

  const found = [];
  const add = (spec) => found.push(issue(spec));

  // ---- people: someone is having a problem in the field --------------------

  const outsideClockedIn = rows.filter((r) => r.clockedIn && r.isInsideGeofence === false);
  if (outsideClockedIn.length) {
    add({
      id: 'clocked-in-outside-fence',
      group: 'people',
      severity: 'critical',
      title: 'On the clock, outside the fence',
      count: outsideClockedIn.length,
      detail: 'The last heartbeat put these people outside the site they are clocked into. Either they left, or the fence is wrong.',
      who: outsideClockedIn.map((r) => whoOf(r, r.jobSiteId != null ? 'site ' + r.jobSiteId : 'no site')),
      lastAt: newest(outsideClockedIn, 'capturedAt'),
      href: '/users.html?clockedIn=true&insideGeofence=false',
      evidence: 'ekosClientState: clockedIn && isInsideGeofence === false',
    });
  }

  const staleClockedIn = rows.filter((r) => r.clockedIn && r.ageMinutes !== null && r.ageMinutes > STALE_MINUTES);
  if (staleClockedIn.length) {
    add({
      id: 'stale-while-clocked-in',
      group: 'people',
      severity: 'critical',
      title: 'Clocked in but no longer reporting',
      count: staleClockedIn.length,
      detail:
        'On the clock, and silent for over ' +
        STALE_MINUTES +
        ' minutes. Nothing is known about where these people are now.',
      who: staleClockedIn.map((r) => whoOf(r, 'quiet ' + Math.round(r.ageMinutes) + ' min')),
      lastAt: newest(staleClockedIn, 'capturedAt'),
      href: '/heartbeats.html?clockedIn=true',
      evidence: 'ekosClientState: newest createdAt per user',
    });
  }

  const noBackground = rows.filter((r) => !r.permissionsEnabled.includes('LOCATION_BACKGROUND'));
  if (noBackground.length) {
    add({
      id: 'background-location-denied',
      group: 'people',
      severity: 'critical',
      title: 'Background location not granted',
      count: noBackground.length,
      detail:
        'Tracking stops when the app is not in the foreground, so these devices will simply go quiet rather than report a problem.',
      who: noBackground.map((r) => whoOf(r, r.clockedIn ? 'on the clock' : 'off the clock')),
      lastAt: newest(noBackground, 'capturedAt'),
      href: '/users.html?permissionMissing=LOCATION_BACKGROUND',
      evidence: 'ekosClientState: permissionsEnabled excludes LOCATION_BACKGROUND',
    });
  }

  const notAlways = rows.filter((r) => r.permissionsEnabled.includes('LOCATION_BACKGROUND') && !r.locationAlways);
  if (notAlways.length) {
    add({
      id: 'location-not-always',
      group: 'people',
      severity: 'serious',
      title: 'Location not set to "allow all the time"',
      count: notAlways.length,
      detail: 'Background permission is granted but the OS is still free to withhold fixes, which shows up later as unexplained silence.',
      who: notAlways.map((r) => whoOf(r, r.clockedIn ? 'on the clock' : null)),
      lastAt: newest(notAlways, 'capturedAt'),
      href: '/heartbeats.html',
      evidence: 'ekosClientState: allowEveryTimeOnLocationCheck !== true',
    });
  }

  const otherPermissions = rows.filter(
    (r) => r.permissionsMissing.length && r.permissionsEnabled.includes('LOCATION_BACKGROUND')
  );
  if (otherPermissions.length) {
    const names = [...new Set(otherPermissions.flatMap((r) => r.permissionsMissing))];
    add({
      id: 'permission-gaps',
      group: 'people',
      severity: 'warning',
      title: 'Other permissions missing',
      count: otherPermissions.length,
      detail: 'Missing: ' + names.join(', ') + '.',
      who: otherPermissions.map((r) => whoOf(r, r.permissionsMissing.join(', '))),
      lastAt: newest(otherPermissions, 'capturedAt'),
      href: '/users.html',
      evidence: 'ekosClientState: permissionsEnabled vs the known permission list',
    });
  }

  const noFix = rows.filter((r) => !r.location);
  if (noFix.length) {
    add({
      id: 'no-coordinates',
      group: 'people',
      severity: 'serious',
      title: 'Reporting without any location',
      count: noFix.length,
      detail: 'The heartbeat arrived but carried no coordinates, so nothing about these devices can be placed on a map.',
      who: noFix.map((r) => whoOf(r, r.clockedIn ? 'on the clock' : null)),
      lastAt: newest(noFix, 'capturedAt'),
      href: '/heartbeats.html?hasLocation=false',
      evidence: 'ekosClientState: currentUserLocation.latitude is null',
    });
  }

  const unusable = rows.filter((r) => r.accuracy !== null && r.accuracy > UNUSABLE_ACCURACY);
  if (unusable.length) {
    add({
      id: 'unusable-accuracy',
      group: 'people',
      severity: 'serious',
      title: 'GPS accuracy unusable',
      count: unusable.length,
      detail: 'Over ±' + UNUSABLE_ACCURACY + ' m of uncertainty - too coarse to decide whether someone is on site at all.',
      who: unusable.map((r) => whoOf(r, '±' + Math.round(r.accuracy) + ' m')),
      lastAt: newest(unusable, 'capturedAt'),
      href: '/heartbeats.html?accuracyMin=' + UNUSABLE_ACCURACY,
      evidence: 'ekosClientState: currentUserLocation.accuracy',
    });
  }

  const poor = rows.filter((r) => r.accuracy !== null && r.accuracy > POOR_ACCURACY && r.accuracy <= UNUSABLE_ACCURACY);
  if (poor.length) {
    add({
      id: 'poor-accuracy',
      group: 'people',
      severity: 'warning',
      title: 'GPS accuracy poor',
      count: poor.length,
      detail: 'Between ±' + POOR_ACCURACY + ' m and ±' + UNUSABLE_ACCURACY + ' m. Fence verdicts on these fixes are uncertain by definition.',
      who: poor.map((r) => whoOf(r, '±' + Math.round(r.accuracy) + ' m')),
      lastAt: newest(poor, 'capturedAt'),
      href: '/heartbeats.html?accuracyMin=' + POOR_ACCURACY,
      evidence: 'ekosClientState: currentUserLocation.accuracy',
    });
  }

  const criticalBattery = rows.filter((r) => r.battery !== null && r.battery <= CRITICAL_BATTERY);
  if (criticalBattery.length) {
    add({
      id: 'battery-critical',
      group: 'people',
      severity: 'serious',
      title: 'Battery about to die',
      count: criticalBattery.length,
      detail: 'At or under ' + CRITICAL_BATTERY + '%. Tracking ends when the phone does, and the OS throttles location long before that.',
      who: criticalBattery.map((r) => whoOf(r, r.battery + '%')),
      lastAt: newest(criticalBattery, 'capturedAt'),
      href: '/users.html?batteryMax=' + CRITICAL_BATTERY,
      evidence: 'ekosClientState: batteryPercentage',
    });
  }

  const lowBattery = rows.filter((r) => r.battery !== null && r.battery > CRITICAL_BATTERY && r.battery <= LOW_BATTERY);
  if (lowBattery.length) {
    add({
      id: 'battery-low',
      group: 'people',
      severity: 'warning',
      title: 'Battery low',
      count: lowBattery.length,
      detail: 'At or under ' + LOW_BATTERY + '%.',
      who: lowBattery.map((r) => whoOf(r, r.battery + '%')),
      lastAt: newest(lowBattery, 'capturedAt'),
      href: '/users.html?batteryMax=' + LOW_BATTERY,
      evidence: 'ekosClientState: batteryPercentage',
    });
  }

  const offline = rows.filter((r) => r.offline);
  if (offline.length) {
    add({
      id: 'offline',
      group: 'people',
      severity: 'warning',
      title: 'No connectivity on the last heartbeat',
      count: offline.length,
      detail: 'The document reached the server but the device reported itself offline or unreachable when it was written.',
      who: offline.map((r) => whoOf(r, r.isConnected ? 'unreachable' : 'disconnected')),
      lastAt: newest(offline, 'capturedAt'),
      href: '/heartbeats.html?connected=false',
      evidence: 'ekosClientState: isConnected === false || isReachable === false',
    });
  }

  const facial = rows.filter((r) => r.facialVerification && r.facialVerification.pending);
  if (facial.length) {
    add({
      id: 'facial-pending',
      group: 'people',
      severity: 'warning',
      title: 'Face check required but not done',
      count: facial.length,
      detail: 'The shift requires a facial verification that has not been completed.',
      who: facial.map((r) => whoOf(r, r.clockedIn ? 'on the clock' : null)),
      lastAt: newest(facial, 'capturedAt'),
      href: '/users.html',
      evidence: 'ekosClientState: facial verification required and not completed',
    });
  }

  // ---- app: the software or its data is misbehaving ------------------------

  // The device says one thing, the geometry says another. Only worth reporting
  // where a fence is actually on record - otherwise there is nothing to compare.
  const disagree = rows.filter((r) => {
    const site = r.jobSiteId != null ? siteById.get(r.jobSiteId) : null;
    if (!site || !site.hasFence || !r.location || r.isInsideGeofence === null) return false;
    const judged = geo.verdictWithAccuracy(r.location, { lat: site.lat, lng: site.lng, radius: site.radius }, r.accuracy);
    if (judged.verdict === 'unknown') return false;
    r._computed = judged.verdict;
    r._boundary = judged.relation ? judged.relation.distanceFromBoundary : null;
    return r.isInsideGeofence !== (judged.verdict === 'in');
  });
  if (disagree.length) {
    add({
      id: 'verdict-disagrees',
      group: 'app',
      severity: 'critical',
      title: 'App and geometry disagree on the fence',
      count: disagree.length,
      detail:
        'The app reported one geofence state while the recorded fence and the stored coordinates say the other. One of the two is wrong.',
      who: disagree.map((r) =>
        whoOf(r, 'app: ' + (r.isInsideGeofence ? 'inside' : 'outside') + ', geometry: ' + r._computed)
      ),
      lastAt: newest(disagree, 'capturedAt'),
      href: '/users.html',
      evidence: 'ekosClientState isInsideGeofence vs the fence in validateClockInLogs',
    });
  }

  const drift = rows.filter((r) => r.clockDriftSeconds !== null && Math.abs(r.clockDriftSeconds) > CLOCK_DRIFT_SECONDS);
  if (drift.length) {
    add({
      id: 'clock-drift',
      group: 'app',
      severity: 'warning',
      title: 'Device clock out of step with the server',
      count: drift.length,
      detail:
        'Over ' +
        CLOCK_DRIFT_SECONDS +
        ' seconds apart, so any decision made from the device\'s own timestamps - shift boundaries, exit windows - is suspect.',
      who: drift.map((r) => whoOf(r, (r.clockDriftSeconds > 0 ? 'behind ' : 'ahead ') + Math.abs(Math.round(r.clockDriftSeconds)) + ' s')),
      lastAt: newest(drift, 'capturedAt'),
      href: '/heartbeats.html',
      evidence: 'ekosClientState: createdAt minus currentDateTime',
    });
  }

  const noSession = rows.filter((r) => r.userId === null);
  if (noSession.length) {
    add({
      id: 'no-session',
      group: 'app',
      severity: 'warning',
      title: 'Devices reporting with no session',
      count: noSession.length,
      detail: 'These heartbeats carry no user, so nothing in them can be attributed to a person.',
      who: noSession.map((r) => whoOf(r, r.deviceType || 'unknown device')),
      lastAt: newest(noSession, 'capturedAt'),
      href: '/heartbeats.html?userId=anonymous',
      evidence: 'ekosClientState: currentUser.data.id is null',
    });
  }

  const versions = [...new Set(rows.map((r) => r.appVersion + ' (' + r.buildVersion + ')').filter((v) => !v.startsWith('null')))];
  if (versions.length > 1) {
    const counts = new Map();
    for (const r of rows) {
      const key = r.appVersion + ' (' + r.buildVersion + ')';
      if (key.startsWith('null')) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const spread = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    add({
      id: 'version-spread',
      group: 'app',
      severity: 'info',
      title: 'More than one app build in the field',
      count: versions.length,
      unit: 'build',
      detail: spread.map(([v, n]) => v + ' × ' + n).join(' · ') + '. Behaviour differences between builds will read as inconsistent data.',
      who: [],
      href: '/heartbeats.html',
      evidence: 'ekosClientState: buildVersion.applicationVersion / buildVersion',
    });
  }

  return found;
}

// ---------------------------------------------------------------------------
// 2. silence between heartbeats
// ---------------------------------------------------------------------------

/**
 * Silence between one device's consecutive heartbeats - the one fault no count
 * can express, since the evidence is documents that do not exist.
 *
 * Only silence ON the clock is reported: the overnight gap between shifts is the
 * largest in this data and means nothing. The heartbeat before each gap is read
 * back so the silence can be attributed rather than merely counted.
 *
 * Two queries, not one: $setWindowFields sorts each partition in memory,
 * allowDiskUse is not honoured on this deployment, and sorting whole documents
 * blows the 32 MB sort budget.
 */
async function fromHeartbeatGaps(q) {
  const { col, base } = await collectionFor('snapshots');
  const match = F.and([base, F.snapshotMatch(q)]);

  // One pass yields both halves of the question: what this device normally
  // does, and the worst silences it actually had. Grouping per device rather
  // than taking a global top-N also stops one chatty phone from crowding
  // everybody else out of the list.
  const perDevice = await col
    .aggregate(
      [
        { $match: match },
        // Two fields only. Anything wider and the partition sort blows the budget.
        { $project: { createdAt: 1, _user: '$' + SNAP.userId } },
        { $match: { _user: { $ne: null } } },
        {
          $setWindowFields: {
            partitionBy: '$_user',
            sortBy: { createdAt: 1 },
            output: { _prevAt: { $shift: { output: '$createdAt', by: -1 } } },
          },
        },
        { $addFields: { _gapMs: { $subtract: ['$createdAt', '$_prevAt'] } } },
        { $match: { _gapMs: { $ne: null } } },
        {
          $group: {
            _id: '$_user',
            intervals: { $sum: 1 },
            // Approximate keeps this to bounded memory, and a median gap does
            // not need to be exact to say what normal looks like.
            cadence: { $percentile: { input: '$_gapMs', p: [0.5], method: 'approximate' } },
            worst: {
              $topN: {
                n: GAPS_PER_USER,
                sortBy: { _gapMs: -1 },
                output: { gapMs: '$_gapMs', endedAt: '$createdAt', startedAt: '$_prevAt' },
              },
            },
          },
        },
      ],
      opts
    )
    .toArray();
  if (!perDevice.length) return [];

  const cadenceOf = new Map();
  const gaps = [];
  for (const d of perDevice) {
    const median = Array.isArray(d.cadence) ? d.cadence[0] : null;
    cadenceOf.set(d._id, Number.isFinite(median) && median > 0 ? median : null);
    for (const g of d.worst || []) gaps.push({ user: d._id, ...g });
  }
  if (!gaps.length) return [];

  // The heartbeat that opened each silence, for the cause and the shift state.
  const causes = await col
    .find({ $or: gaps.map((g) => ({ [SNAP.userId]: g.user, createdAt: g.startedAt })) })
    .project({
      createdAt: 1,
      [SNAP.userId]: 1,
      [SNAP.fullName]: 1,
      clockedIn: 1,
      sessionLoggedIn: 1,
      isConnected: 1,
      batteryPercentage: 1,
      permissionsEnabled: 1,
    })
    .toArray();

  const byKey = new Map();
  for (const doc of causes) {
    const row = normalize.snapshot(doc);
    byKey.set(row.userId + '@' + new Date(doc.createdAt).getTime(), row);
  }

  const onClock = [];
  for (const g of gaps) {
    const before = byKey.get(g.user + '@' + new Date(g.startedAt).getTime());
    // No pre-gap document means no basis to call it a fault.
    if (!before) continue;
    // Off the clock, silence is the expected state, not an incident.
    if (!before.clockedIn) continue;

    const cadenceMs = cadenceOf.get(g.user);
    const multiple = cadenceMs ? g.gapMs / cadenceMs : null;
    // Either long enough to matter to anybody, or so far outside what this
    // device normally does that the app had clearly stopped. The floor keeps
    // the second rule from firing on multiples of a one-second cadence.
    const flatFault = g.gapMs >= GAP_WARN_MS;
    const outOfCharacter = multiple !== null && g.gapMs >= CADENCE_FLOOR_MS && multiple >= CADENCE_MULTIPLE;
    if (!flatFault && !outOfCharacter) continue;

    onClock.push({
      userId: g.user,
      name: before.name || 'user ' + g.user,
      minutes: Math.round(g.gapMs / 60000),
      gapMs: g.gapMs,
      cadenceMs,
      multiple,
      flatFault,
      startedAt: new Date(g.startedAt).toISOString(),
      endedAt: new Date(g.endedAt).toISOString(),
      cause: explainGap(before),
    });
  }
  if (!onClock.length) return [];

  // Worst gap per person, so one bad day is one row.
  const worstPerUser = new Map();
  for (const g of onClock) {
    const held = worstPerUser.get(g.userId);
    if (!held || g.minutes > held.minutes) worstPerUser.set(g.userId, g);
  }
  const people = [...worstPerUser.values()].sort((a, b) => b.minutes - a.minutes);

  const found = [];
  const outages = people.filter((g) => g.minutes >= GAP_CRITICAL_MS / 60000);
  if (outages.length) {
    found.push(
      issue({
        id: 'heartbeat-outage-on-clock',
        group: 'people',
        severity: 'critical',
        title: 'Stopped reporting while on the clock, over 30 min',
        count: outages.length,
        detail:
          'A heartbeat normally lands every 25-60 s, so this is the app not running rather than a quiet shift. Nothing is known about these people for the length of the gap.',
        who: outages.map((g) => whoOf(g, silenceNote(g) + ' · ' + g.cause)),
        lastAt: newest(outages, 'endedAt'),
        href: '/heartbeats.html?clockedIn=true',
        evidence: 'ekosClientState: time between one device\'s consecutive createdAt values, clocked in',
      })
    );
  }

  const shorter = people.filter((g) => g.flatFault && g.minutes < GAP_CRITICAL_MS / 60000);
  if (shorter.length) {
    found.push(
      issue({
        id: 'heartbeat-gaps-on-clock',
        group: 'people',
        severity: 'serious',
        title: 'Reporting gaps while on the clock, 10-30 min',
        count: shorter.length,
        detail: 'Long enough to lose track of where someone was, not long enough to be an outage.',
        who: shorter.map((g) => whoOf(g, silenceNote(g) + ' · ' + g.cause)),
        lastAt: newest(shorter, 'endedAt'),
        href: '/heartbeats.html?clockedIn=true',
        evidence: 'ekosClientState: time between one device\'s consecutive createdAt values, clocked in',
      })
    );
  }

  // Silence no flat threshold can see: short in absolute terms, but these
  // devices report every few seconds, so they had already stopped.
  const outOfCharacter = people.filter((g) => !g.flatFault);
  if (outOfCharacter.length) {
    found.push(
      issue({
        id: 'heartbeat-gaps-out-of-character',
        group: 'people',
        severity: 'serious',
        title: 'Silence far beyond what the device normally does',
        count: outOfCharacter.length,
        detail:
          'Under ten minutes, so no flat threshold catches these, but the devices involved report every few seconds - a pause this many times their own cadence means the app was not running. Cadence spans a factor of seventy across this fleet, so one threshold cannot fit all of it.',
        who: outOfCharacter.map((g) => whoOf(g, silenceNote(g))),
        lastAt: newest(outOfCharacter, 'endedAt'),
        href: '/heartbeats.html?clockedIn=true',
        evidence: 'ekosClientState: each gap against the median gap for that same device, clocked in',
      })
    );
  }

  // The interesting kind: the others have a reason in the data, this one does not.
  const unexplained = people.filter((g) => g.cause === 'unexplained');
  if (unexplained.length) {
    found.push(
      issue({
        id: 'heartbeat-gaps-unexplained',
        group: 'app',
        severity: 'serious',
        title: 'Silence with nothing to explain it',
        count: unexplained.length,
        detail:
          'These devices were logged in, on the clock, online, charged and fully permissioned when they stopped reporting. Nothing in the last heartbeat accounts for the gap.',
        who: unexplained.map((g) => whoOf(g, silenceNote(g))),
        lastAt: newest(unexplained, 'endedAt'),
        href: '/heartbeats.html?clockedIn=true',
        evidence: 'ekosClientState: state on the heartbeat immediately before each gap',
      })
    );
  }

  return found;
}

/**
 * How long the silence was, and how far out of character it is.
 *
 * The multiple is what makes a four-minute gap legible: on a device that
 * reports every second it means the app stopped, and on one that reports every
 * five minutes it means nothing at all.
 */
function silenceNote(g) {
  const spell =
    g.gapMs < 90 * 1000
      ? Math.round(g.gapMs / 1000) + 's silent'
      : g.minutes + ' min silent';
  if (!g.cadenceMs || !g.multiple || g.multiple < 3) return spell;
  return spell + ' · ' + Math.round(g.multiple) + '× its usual ' + shortDuration(g.cadenceMs);
}

/** Compact duration for a note: "800ms", "45s", "5 min". */
function shortDuration(msValue) {
  if (msValue < 1000) return Math.round(msValue) + 'ms';
  if (msValue < 90 * 1000) return Math.round(msValue / 1000) + 's';
  return Math.round(msValue / 60000) + ' min';
}

/** A span in words, for an issue note: "3h 20m", "45 min". */
function spanOf(msValue) {
  if (msValue === null || msValue === undefined) return "unknown";
  const minutes = msValue / 60000;
  if (minutes < 90) return Math.round(minutes) + ' min';
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + 'h ' + Math.round(minutes % 60) + 'm';
  return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
}

/** Reads the cause of a silence off the last heartbeat before it. */
function explainGap(before) {
  if (!before) return 'unexplained';
  if (before.sessionLoggedIn === false) return 'logged out';
  if (before.offline) return 'device offline';
  if (before.battery !== null && before.battery <= 15) return 'battery ' + before.battery + '%';
  if (!before.permissionsEnabled.includes('LOCATION_BACKGROUND')) return 'background location denied';
  if (!before.locationAlways) return 'location not always-on';
  return 'unexplained';
}
// ---------------------------------------------------------------------------
// 3. what the clock-in checks decided
// ---------------------------------------------------------------------------

async function fromClockInChecks(q) {
  const { col } = await collectionFor('clockInLogs');
  const match = F.logMatch(q);

  const facet = await col
    .aggregate(
      [
        { $match: match },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  failedGeometry: { $sum: { $cond: [{ $eq: ['$' + LOG.actual, false] }, 1, 0] } },
                  grace: {
                    $sum: {
                      $cond: [{ $and: [{ $eq: ['$' + LOG.within, true] }, { $eq: ['$' + LOG.actual, false] }] }, 1, 0],
                    },
                  },
                  clockOuts: { $sum: { $cond: [{ $eq: ['$' + LOG.clockOut, true] }, 1, 0] } },
                  lastAt: { $max: '$createdAt' },
                },
              },
            ],
            // who, for each kind of problem
            failedBy: [
              { $match: { [LOG.actual]: false } },
              { $group: { _id: '$userId', n: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
              { $sort: { n: -1 } },
              { $limit: 20 },
            ],
            graceBy: [
              { $match: { [LOG.within]: true, [LOG.actual]: false } },
              { $group: { _id: '$userId', n: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
              { $sort: { n: -1 } },
              { $limit: 20 },
            ],
            clockOutBy: [
              { $match: { [LOG.clockOut]: true } },
              { $group: { _id: '$userId', n: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
              { $sort: { n: -1 } },
              { $limit: 20 },
            ],
          },
        },
      ],
      opts
    )
    .next();

  const s = (facet.summary || [])[0];
  if (!s || !s.total) return [];
  const found = [];
  const asWho = (list, suffix) =>
    (list || []).map((r) => ({ userId: r._id, name: r._id != null ? 'user ' + r._id : 'no session', note: r.n + ' ' + suffix }));

  if (s.clockOuts) {
    found.push(
      issue({
        id: 'auto-clock-outs',
        group: 'people',
        severity: 'serious',
        title: 'Automatic clock-outs triggered',
        count: s.clockOuts,
        unit: 'clock-out',
        detail: 'The backend ended these shifts because the device left the fence. Each one is someone whose time was cut for them.',
        who: asWho(facet.clockOutBy, 'auto clock-out(s)'),
        lastAt: s.lastAt,
        href: '/checks.html?triggeredClockOut=true',
        evidence: 'validateClockInLogs: response.clockOut === true',
      })
    );
  }

  if (s.failedGeometry) {
    found.push(
      issue({
        id: 'checks-failed-geometry',
        group: 'people',
        severity: 'serious',
        title: 'Clock-in checks that failed the raw geometry',
        count: s.failedGeometry,
        unit: 'check',
        detail:
          'Of ' +
          s.total +
          ' checks, these put the device outside the fence before any accuracy allowance was applied.',
        who: asWho(facet.failedBy, 'failed check(s)'),
        lastAt: s.lastAt,
        href: '/checks.html?actualWithinRadius=false',
        evidence: 'validateClockInLogs: response.actualIsWithinRadius === false',
      })
    );
  }

  if (s.grace) {
    found.push(
      issue({
        id: 'checks-passed-on-grace',
        group: 'app',
        severity: 'warning',
        title: 'Checks that passed only on the accuracy allowance',
        count: s.grace,
        unit: 'check',
        detail:
          'The raw geometry said outside; radius + GPS accuracy pulled it back in. These clock-ins succeeded on padding, not on position.',
        who: asWho(facet.graceBy, 'on padding'),
        lastAt: s.lastAt,
        href: '/checks.html?mismatch=true',
        evidence: 'validateClockInLogs: isWithinRadius true while actualIsWithinRadius false',
      })
    );
  }

  return found;
}

// ---------------------------------------------------------------------------
// 4. exit windows
// ---------------------------------------------------------------------------

async function fromExitWindows(q) {
  const { col, base } = await collectionFor('exitWindows');
  const match = F.and([base, F.exitWindowMatch(q)]);

  const rows = await col
    .aggregate(
      [
        { $match: match },
        {
          $project: {
            userId: 1,
            status: 1,
            resolution: 1,
            openedAt: 1,
            expiresAt: 1,
            openedBy: 1,
            fence: 1,
            samples: 1,
            summary: 1,
          },
        },
        { $sort: { openedAt: -1 } },
        { $limit: 1000 },
      ],
      opts
    )
    .toArray();
  if (!rows.length) return [];

  const found = [];
  const label = (r) => ({
    userId: r.userId == null ? null : r.userId,
    name: r.userId == null ? 'no user on the document' : 'user ' + r.userId,
    note: null,
  });
  const lastOf = (list) => {
    const max = list.reduce((a, r) => Math.max(a, r.openedAt || 0), 0);
    return max ? new Date(max).toISOString() : null;
  };

  const open = rows.filter((r) => r.status === 'open');
  const now = Date.now();
  // An open window inside its own expiry is a live event: someone is outside a
  // fence right now. One that outlived its expiry is a different thing entirely -
  // the app opened it and never closed it, so it is a resolution bug, not a
  // person to go and find. Reporting them as one number hides both.
  const live = open.filter((r) => !r.expiresAt || r.expiresAt >= now);
  const stuck = open.filter((r) => r.expiresAt && r.expiresAt < now);

  if (live.length) {
    found.push(
      issue({
        id: 'exit-windows-open',
        group: 'people',
        severity: 'serious',
        title: 'Someone is outside a fence right now',
        count: live.length,
        unit: 'window',
        detail: 'An exit window is open and has not yet expired - the person has not returned and has not clocked out.',
        who: live.map((r) => ({ ...label(r), note: r.openedBy || null })),
        lastAt: lastOf(live),
        href: '/exit-windows.html?status=open',
        evidence: 'exit_window: status "open", expiresAt in the future',
      })
    );
  }

  if (stuck.length) {
    const oldest = Math.round(Math.max(...stuck.map((r) => now - r.expiresAt)) / 60000);
    found.push(
      issue({
        id: 'exit-windows-stuck',
        group: 'app',
        severity: 'serious',
        title: 'Exit windows never resolved after expiring',
        count: stuck.length,
        unit: 'window',
        detail:
          'These outlived their own expiresAt and are still marked open - the oldest by ' +
          oldest +
          ' minutes. Whatever closes a window is not running, so the open count can never be trusted as a live figure.',
        who: stuck.map((r) => ({ ...label(r), note: r.openedBy || null })),
        lastAt: lastOf(stuck),
        href: '/exit-windows.html?status=open',
        evidence: 'exit_window: status "open" while expiresAt is in the past',
      })
    );
  }

  const review = rows.filter((r) => r.resolution === 'needs_review');
  if (review.length) {
    found.push(
      issue({
        id: 'exit-windows-needs-review',
        group: 'people',
        severity: 'serious',
        title: 'Exit windows flagged for review',
        count: review.length,
        unit: 'window',
        detail: 'The app could not decide what happened and handed these to a human.',
        who: review.map(label),
        lastAt: lastOf(review),
        href: '/exit-windows.html?resolution=needs_review',
        evidence: 'exit_window: resolution === "needs_review"',
      })
    );
  }

  // The device being judged is nowhere near the fence judging it. A boundary
  // distance of kilometres is not someone stepping off a site.
  const wrongFence = rows
    .map((r) => {
      const worst = (r.samples || []).reduce(
        (max, s) => Math.max(max, Number(s.distanceFromBoundary) || 0),
        0
      );
      return { row: r, worst };
    })
    .filter((x) => x.worst > FENCE_SANITY_METRES);
  if (wrongFence.length) {
    found.push(
      issue({
        id: 'exit-window-fence-mismatch',
        group: 'app',
        severity: 'critical',
        title: 'Exit window judged against a fence kilometres away',
        count: wrongFence.length,
        unit: 'window',
        detail:
          'The samples sit more than ' +
          FENCE_SANITY_METRES / 1000 +
          ' km outside the fence on the document. That is not an exit - the window is carrying the wrong fence, or the shift is attached to the wrong site.',
        who: wrongFence.map((x) => ({ ...label(x.row), note: (x.worst / 1000).toFixed(1) + ' km outside' })),
        lastAt: lastOf(wrongFence.map((x) => x.row)),
        href: '/exit-windows.html',
        evidence: 'exit_window: samples[].distanceFromBoundary against fence.lat/lng',
      })
    );
  }

  const noUser = rows.filter((r) => r.userId == null);
  if (noUser.length) {
    found.push(
      issue({
        id: 'exit-windows-no-user',
        group: 'app',
        severity: 'warning',
        title: 'Exit windows written without a user',
        count: noUser.length,
        unit: 'window',
        detail:
          'userId is null on these documents, so the exit cannot be attributed to a person and the site has to be guessed from coordinates.',
        who: [],
        lastAt: lastOf(noUser),
        href: '/exit-windows.html',
        evidence: 'exit_window: userId is null',
      })
    );
  }

  return found;
}

// ---------------------------------------------------------------------------
// 5. the fence records themselves
// ---------------------------------------------------------------------------

async function fromSiteRegistry(q) {
  const sites = await getSites({ from: F.str(q.from), to: F.str(q.to) });
  if (!sites.length) return [];
  const found = [];
  const named = (s) => ({ userId: null, name: s.siteId != null ? 'site ' + s.siteId : 'unmapped fence', note: null });

  const offFence = sites.filter((s) => s.centreDivergenceExceedsFence);
  if (offFence.length) {
    found.push(
      issue({
        id: 'devices-off-fence',
        group: 'app',
        severity: 'serious',
        title: 'Devices cluster outside the fence they are judged by',
        count: offFence.length,
        unit: 'site',
        detail: 'On-site fixes average further from the recorded centre than the radius allows, which usually means the fence is stale.',
        who: offFence.map((s) => ({ ...named(s), note: geo.round(s.centreDivergenceMetres, 0) + ' m out, radius ' + s.radius + ' m' })),
        href: '/sites.html',
        evidence: 'recorded fence centre vs the centroid of on-site heartbeat fixes',
      })
    );
  }

  const disputed = sites.filter((s) => s.centreDisputed);
  if (disputed.length) {
    found.push(
      issue({
        id: 'sites-disputed-centre',
        group: 'app',
        severity: 'warning',
        title: 'Sites where devices report two different locations',
        count: disputed.length,
        unit: 'site',
        detail: 'On-site fixes fall into two separate clusters, so the estimated centre has two credible answers.',
        who: disputed.map((s) => named(s)),
        href: '/sites.html',
        evidence: 'two proximity clusters in the on-site heartbeat fixes',
      })
    );
  }

  const moved = sites.filter((s) => s.relocated);
  if (moved.length) {
    found.push(
      issue({
        id: 'sites-moved',
        group: 'app',
        severity: 'info',
        title: 'Fences edited in this range',
        count: moved.length,
        unit: 'site',
        detail: 'The recorded geometry changed. Verdicts before and after the edit were made against different fences.',
        who: moved.map((s) => ({ ...named(s), note: 'moved ' + geo.round(s.fenceMovedMetres, 0) + ' m' })),
        href: '/sites.html',
        evidence: 'validateClockInLogs: more than one geometry revision for the site',
      })
    );
  }

  return found;
}

// ---------------------------------------------------------------------------
// 6. what measuring time on site turns up
// ---------------------------------------------------------------------------

/**
 * Faults that only appear once fence time is measured rather than sampled.
 *
 * Counting heartbeats cannot see either of these. A fence entry with no exit
 * looks like an ordinary run of "inside" heartbeats, and a fence being crossed
 * every few seconds looks like a healthy device reporting often.
 */
async function fromFenceTime(q, nameHints) {
  const fence = await fenceTimeCached(q);
  const found = [];

  for (const u of fence.perUser) {
    if (u.userId !== null && u.userId !== undefined && u.name && !isPlaceholderName(u.name)) {
      nameHints.set(u.userId, u.name);
    }
  }

  // Entered, still inside, and no exit ever recorded. Either the app missed
  // the crossing or the person is still on site long after their shift - both
  // mean the fence state on record cannot be trusted for them.
  const stuck = fence.perUser.filter(
    (u) => u.neverExited && u.neverExitedForMs !== null && u.neverExitedForMs >= NEVER_EXITED_STALE_MS
  );
  if (stuck.length) {
    found.push(
      issue({
        id: 'fence-entered-never-left',
        group: 'app',
        severity: 'serious',
        title: 'Entered a fence and never recorded leaving it',
        count: stuck.length,
        unit: 'device',
        detail:
          'The newest heartbeat still reports being inside, an entry was recorded, and no exit ever was. Anything that reads fence state for these people - exit windows included - is working from a crossing that was never closed.',
        who: stuck.map((u) =>
          whoOf(u, spanOf(u.neverExitedForMs) + ' since entry' + (u.latestOnClock ? ', on the clock' : ''))
        ),
        lastAt: newest(stuck, 'latestAt'),
        href: '/heartbeats.html?insideGeofence=true',
        evidence: 'ekosClientState: geofenceIn with no geofenceOut anywhere in range, newest heartbeat still inside',
      })
    );
  }

  // A fence crossed and re-crossed within a minute is the fence arguing with
  // itself: GPS scatter against a boundary, not somebody walking in and out.
  // Each flap can open an exit window, so this is a source of false alarms.
  const flapping = fence.perUser.filter((u) => u.jitterVisits >= JITTER_VISITS_MIN);
  if (flapping.length) {
    found.push(
      issue({
        id: 'fence-crossings-flapping',
        group: 'app',
        severity: 'warning',
        title: 'Fence crossings flapping in under a minute',
        count: flapping.length,
        unit: 'device',
        detail:
          'These devices crossed a boundary and crossed back within a minute, repeatedly. That is GPS scatter against the fence edge rather than anybody moving, and each flap can open an exit window - so it manufactures alerts as well as burning battery. A wider fence or a hysteresis margin fixes it.',
        who: flapping.map((u) =>
          whoOf(u, u.jitterVisits + ' crossings under a minute of ' + u.visits)
        ),
        lastAt: newest(fence.perUser, 'latestAt'),
        href: '/sites.html',
        evidence: 'ekosClientState: geofenceIn and geofenceOut pairs less than a minute apart',
      })
    );
  }

  // Reported neither inside nor outside for a long stretch while on the clock:
  // the app was running and sending, but had no fence verdict to send.
  const noVerdict = fence.perUser.filter(
    (u) => u.onClock && u.unknownMs >= NO_VERDICT_MS && u.measuredMs > 0
  );
  if (noVerdict.length) {
    found.push(
      issue({
        id: 'fence-no-verdict',
        group: 'app',
        severity: 'warning',
        title: 'On the clock with no inside-or-outside verdict',
        count: noVerdict.length,
        unit: 'device',
        detail:
          'These devices kept reporting but left isInsideGeofence empty for hours at a stretch. The heartbeats are there, so nothing looks missing, yet for that time there is no answer to the only question the fence exists to answer.',
        who: noVerdict.map((u) =>
          whoOf(u, spanOf(u.unknownMs) + ' with no verdict of ' + spanOf(u.measuredMs) + ' measured')
        ),
        lastAt: newest(fence.perUser, 'latestAt'),
        href: '/heartbeats.html?clockedIn=true',
        evidence: 'ekosClientState: time credited to a null isInsideGeofence while clocked in',
      })
    );
  }

  return found;
}

// ---------------------------------------------------------------------------
// 7. network state
// ---------------------------------------------------------------------------

/**
 * Faults in how the device talked to the server, rather than where it was.
 *
 * `isConnected` and `isReachable` are separate facts and only the first was
 * ever read. A device with a network that cannot reach the server is a
 * different problem from one with no signal, and it points at the server or the
 * route rather than at the person holding the phone.
 *
 * Deliberately NOT here: batteryOptimizationPermission. It is null on all
 * 61,812 iOS heartbeats and a boolean on every Android one, so it is platform
 * specific rather than missing - and every Android device in this store reports
 * true, which could mean the exemption is granted or that optimisation is on.
 * Nothing in the data settles which, and a detector built on a guess about
 * polarity would invent faults or hide them.
 */
async function fromNetwork(q, nameHints) {
  const { col, base } = await collectionFor('snapshots');
  const match = F.and([base, F.snapshotMatch(q)]);

  const facet = await col
    .aggregate(
      [
        { $match: match },
        {
          $facet: {
            // One row per clock-in, not per heartbeat: the same offline clock-in
            // is repeated on every heartbeat for the rest of that shift.
            offlineClockIns: [
              { $match: { 'clockedInJobDetail.clockInNetworkStatus': 'OFFLINE' } },
              {
                $group: {
                  _id: { user: '$' + SNAP.userId, at: '$clockedInJobDetail.clockIn' },
                  name: { $max: '$' + SNAP.fullName },
                  lastAt: { $max: '$createdAt' },
                  siteId: { $max: '$clockedInJobDetail.jobSiteId' },
                },
              },
              { $sort: { lastAt: -1 } },
              { $limit: 200 },
            ],
            unreachable: [
              { $match: { isConnected: true, isReachable: false } },
              {
                $group: {
                  _id: '$' + SNAP.userId,
                  name: { $max: '$' + SNAP.fullName },
                  beats: { $sum: 1 },
                  lastAt: { $max: '$createdAt' },
                },
              },
              { $sort: { beats: -1 } },
            ],
          },
        },
      ],
      opts
    )
    .next();

  const found = [];
  const offline = (facet && facet.offlineClockIns) || [];
  const unreachable = (facet && facet.unreachable) || [];

  for (const row of offline.concat(unreachable)) {
    const id = row._id && row._id.user !== undefined ? row._id.user : row._id;
    if (id === null || id === undefined) continue;
    if (row.name && !isPlaceholderName(row.name)) nameHints.set(id, row.name);
  }

  if (offline.length) {
    const who = offline.map((r) =>
      whoOf(
        { userId: r._id.user, name: r.name },
        'clocked in offline' + (r._id.at ? ' at ' + String(r._id.at).slice(11, 16) + ' UTC' : '')
      )
    );
    found.push(
      issue({
        id: 'clock-in-offline',
        group: 'app',
        severity: 'warning',
        title: 'Clock-ins recorded with no network',
        count: offline.length,
        unit: 'clock-in',
        detail:
          'The device had no connectivity when these clock-ins were taken, so they were held and sent later. Their timestamp and location are whatever the phone believed at the time and were never checked against the server - which makes them the least reliable records in the store, and the ones to look at first when a shift or a fence verdict is disputed.',
        who,
        lastAt: newest(offline, 'lastAt'),
        href: '/heartbeats.html?clockedIn=true',
        evidence: 'ekosClientState: clockedInJobDetail.clockInNetworkStatus = OFFLINE, one row per clock-in',
      })
    );
  }

  if (unreachable.length) {
    found.push(
      issue({
        id: 'connected-but-unreachable',
        group: 'app',
        severity: 'warning',
        title: 'On a network but unable to reach the server',
        count: unreachable.length,
        unit: 'device',
        detail:
          'These devices reported a working connection and still could not reach the server. That is not a person walking into a dead spot - it points at the server, DNS or the route in between, and it is invisible to any check that only looks at whether the device is online.',
        who: unreachable.map((r) =>
          whoOf({ userId: r._id, name: r.name }, r.beats + ' heartbeat' + (r.beats === 1 ? '' : 's') + ' unreachable')
        ),
        lastAt: newest(unreachable, 'lastAt'),
        href: '/heartbeats.html?reachable=false',
        evidence: 'ekosClientState: isConnected true with isReachable false',
      })
    );
  }

  return found;
}

// ---------------------------------------------------------------------------
// per-person roll-up
// ---------------------------------------------------------------------------

/**
 * The same list keyed by person. Only people-facing issues count: a stale fence
 * record is not that person's problem.
 */
function rollUpByUser(issues) {
  const byUser = new Map();
  for (const i of issues) {
    if (i.group !== 'people') continue;
    for (const w of i.who) {
      if (w.userId === null || w.userId === undefined) continue;
      const entry = byUser.get(w.userId) || { userId: w.userId, name: w.name, issues: [], worst: 'info' };
      entry.issues.push({ id: i.id, title: i.title, severity: i.severity, note: w.note });
      if (SEVERITY_RANK[i.severity] < SEVERITY_RANK[entry.worst]) entry.worst = i.severity;
      byUser.set(w.userId, entry);
    }
  }
  return [...byUser.values()]
    .map((e) => ({ ...e, count: e.issues.length }))
    .sort((a, b) => SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] || b.count - a.count);
}

module.exports = { detect };
