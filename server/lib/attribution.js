'use strict';
/**
 * Attributing exit windows to people.
 *
 * Exit-window documents carry a `userId` key, so when it holds a value the join
 * is direct and exact. On this database it is null on every window (checked
 * 2026-09-01: 35 of 35) and `deviceId` is null too - the app writes them without
 * a session. So the id is joined when present, and otherwise the window is
 * matched to a person from evidence the documents do carry.
 *
 * Two matchers, strongest first:
 *
 *  1. Sample fingerprint. A window carries its own GPS samples: timestamp plus
 *     coordinates, from the same device and the same GPS source as that user's
 *     heartbeats. A heartbeat within 150 m and 180 s of a window sample is
 *     almost certainly the same handset - this is close to an identity match.
 *     On the live data this attributes all 35 windows, and the winner is stable
 *     as the threshold loosens (see the constant below).
 *  2. Fence presence. If a window has no usable samples, fall back to who was
 *     standing at that fence while the window was open (with a small time pad,
 *     because a device often stops pinging exactly when it walks away).
 *
 * Everything is reported as an inference: method, evidence, confidence, and the
 * candidate list when two people cannot be separated.
 */
const { collectionFor } = require('../db');
const config = require('../config');
const geo = require('./geo');
const { SNAP } = require('./filters');

/**
 * A heartbeat this close in space and time to a window sample is the same
 * device. Tuned against the live data: at 150 m / 180 s every one of the 35
 * windows matches, and the winning user stops changing as the threshold
 * loosens - identical result at 300 m and 1000 m - so these are not threshold
 * artefacts. Heartbeats and samples are both ~30-60 s apart, hence 180 s.
 */
const SAMPLE_MATCH_METRES = 150;
const SAMPLE_MATCH_MS = 180 * 1000;
/** Fence-presence fallback: how far outside the fence still counts as "there". */
const FENCE_SLACK_METRES = 150;
/** Devices often go quiet right as they leave, so pad the window a little. */
const SPAN_PAD_MS = 2 * 60 * 1000;

const BUCKET_MS = 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const MAX_SPAN_MS = 36 * 60 * 60 * 1000;
const MAX_POINTS = 40000;

const cache = new Map();

/**
 * Raw heartbeat positions over a span, bucketed by minute so a lookup near a
 * given timestamp only scans a few buckets.
 * Returns { buckets: Map<minuteIndex, point[]>, users: Map<userId, {name, tenantId, devices}>, truncated }
 */
async function positionStream(fromMs, toMs, tenantIds) {
  const key = [Math.floor(fromMs / BUCKET_MS), Math.ceil(toMs / BUCKET_MS), tenantIds.slice().sort().join('.')].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const { col, base } = await collectionFor('snapshots');
  const match = {
    ...base,
    createdAt: { $gte: new Date(fromMs), $lte: new Date(toMs) },
    [SNAP.lat]: { $ne: null },
  };
  if (tenantIds.length) match[SNAP.tenantId] = { $in: tenantIds };

  const docs = await col
    .find(match, {
      projection: {
        createdAt: 1,
        deviceType: 1,
        [SNAP.userId]: 1,
        [SNAP.fullName]: 1,
        [SNAP.tenantId]: 1,
        [SNAP.lat]: 1,
        [SNAP.lng]: 1,
      },
    })
    .sort({ createdAt: 1 })
    .limit(MAX_POINTS + 1)
    .maxTimeMS(config.queryTimeoutMs)
    .toArray();

  const truncated = docs.length > MAX_POINTS;
  const buckets = new Map();
  const users = new Map();

  for (const doc of docs.slice(0, MAX_POINTS)) {
    const user = (doc.currentUser && doc.currentUser.data) || {};
    const userId = user.id === undefined ? null : user.id;
    if (userId === null) continue; // a session-less heartbeat identifies nobody
    const loc = doc.currentUserLocation || {};
    if (typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') continue;

    if (!users.has(userId)) {
      users.set(userId, { userId, name: user.fullName || null, tenantId: user.tenantId ?? null, devices: new Set() });
    }
    if (doc.deviceType) users.get(userId).devices.add(doc.deviceType);

    const t = new Date(doc.createdAt).getTime();
    const index = Math.floor(t / BUCKET_MS);
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index).push({ userId, t, lat: loc.latitude, lng: loc.longitude });
  }

  const value = { buckets, users, truncated };
  cache.set(key, { at: Date.now(), value });
  return value;
}

function pointsNear(stream, t, spreadMs) {
  const span = Math.ceil((spreadMs || SAMPLE_MATCH_MS) / BUCKET_MS);
  const centre = Math.floor(t / BUCKET_MS);
  const out = [];
  for (let i = centre - span; i <= centre + span; i += 1) {
    const bucket = stream.buckets.get(i);
    if (bucket) out.push(...bucket);
  }
  return out;
}

/** Time span a window covers, epoch millis, padded. */
function windowSpan(row) {
  const start = row.openedAt ? new Date(row.openedAt).getTime() : null;
  const endRaw = row.resolvedAt || row.expiresAt || row.pushedAt || row.capturedAt;
  const end = endRaw ? new Date(endRaw).getTime() : null;
  if (start === null) return null;
  return { start, end: end !== null && end > start ? end : start + 30 * 60000 };
}

/** Matcher 1: window samples against heartbeat positions. */
function matchBySamples(row, stream) {
  const samples = (row.samples || []).filter((s) => s.lat !== null && s.lng !== null && s.at);
  if (!samples.length) return null;

  const perUser = new Map();
  for (const sample of samples) {
    const t = new Date(sample.at).getTime();
    if (!Number.isFinite(t)) continue;
    const nearby = pointsNear(stream, t);
    // Best (closest) heartbeat per user for this sample.
    const bestPerUser = new Map();
    for (const point of nearby) {
      if (Math.abs(point.t - t) > SAMPLE_MATCH_MS) continue;
      const distance = geo.haversine(point, sample);
      if (distance === null || distance > SAMPLE_MATCH_METRES) continue;
      const current = bestPerUser.get(point.userId);
      if (!current || distance < current.distance) {
        bestPerUser.set(point.userId, { distance, dt: Math.abs(point.t - t) });
      }
    }
    for (const [userId, best] of bestPerUser) {
      if (!perUser.has(userId)) perUser.set(userId, { matched: 0, distances: [], dts: [] });
      const entry = perUser.get(userId);
      entry.matched += 1;
      entry.distances.push(best.distance);
      entry.dts.push(best.dt);
    }
  }
  if (!perUser.size) return null;

  const candidates = [...perUser.entries()].map(([userId, entry]) => {
    const info = stream.users.get(userId) || {};
    return {
      userId,
      name: info.name || null,
      matchedSamples: entry.matched,
      totalSamples: samples.length,
      medianDistanceMetres: geo.round(median(entry.distances), 1),
      medianSecondsApart: geo.round(median(entry.dts) / 1000, 1),
      sameDevice: !row.deviceType || (info.devices && info.devices.has(row.deviceType)),
    };
  });
  candidates.sort(
    (a, b) =>
      b.matchedSamples - a.matchedSamples ||
      Number(b.sameDevice) - Number(a.sameDevice) ||
      a.medianDistanceMetres - b.medianDistanceMetres
  );
  return { kind: 'samples', candidates, sampleCount: samples.length };
}

/** Matcher 2: who was at the fence while the window was open. */
function matchByFence(row, stream) {
  const span = windowSpan(row);
  if (!span || !row.fence) return null;
  const limit = (Number.isFinite(row.fence.radius) ? row.fence.radius : 100) + FENCE_SLACK_METRES;

  const perUser = new Map();
  const from = span.start - SPAN_PAD_MS;
  const to = span.end + SPAN_PAD_MS;
  for (let index = Math.floor(from / BUCKET_MS); index <= Math.ceil(to / BUCKET_MS); index += 1) {
    const bucket = stream.buckets.get(index);
    if (!bucket) continue;
    for (const point of bucket) {
      if (point.t < from || point.t > to) continue;
      const distance = geo.haversine(point, row.fence);
      if (distance === null || distance > limit) continue;
      if (!perUser.has(point.userId)) perUser.set(point.userId, { hits: 0, minutes: new Set(), min: distance });
      const entry = perUser.get(point.userId);
      entry.hits += 1;
      entry.minutes.add(Math.floor(point.t / BUCKET_MS));
      if (distance < entry.min) entry.min = distance;
    }
  }
  if (!perUser.size) return null;

  const candidates = [...perUser.entries()].map(([userId, entry]) => {
    const info = stream.users.get(userId) || {};
    return {
      userId,
      name: info.name || null,
      matchedMinutes: entry.minutes.size,
      matchedHeartbeats: entry.hits,
      minDistanceMetres: geo.round(entry.min, 1),
      sameDevice: !row.deviceType || (info.devices && info.devices.has(row.deviceType)),
    };
  });
  candidates.sort(
    (a, b) =>
      b.matchedMinutes - a.matchedMinutes ||
      Number(b.sameDevice) - Number(a.sameDevice) ||
      a.minDistanceMetres - b.minDistanceMetres
  );
  return { kind: 'fence', candidates };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function decide(row, result) {
  const candidates = result.candidates;
  const best = candidates[0];
  const runnerUp = candidates[1];

  if (result.kind === 'samples') {
    const ratio = best.matchedSamples / (best.totalSamples || 1);
    let confidence = 'likely';
    if (
      best.matchedSamples >= 2 &&
      ratio >= 0.5 &&
      best.medianDistanceMetres <= 60 &&
      best.medianSecondsApart <= 90 &&
      (!runnerUp || best.matchedSamples > runnerUp.matchedSamples)
    ) {
      confidence = 'high';
    }
    if (runnerUp && best.matchedSamples === runnerUp.matchedSamples && best.medianDistanceMetres >= runnerUp.medianDistanceMetres) {
      confidence = 'ambiguous';
    }
    return {
      method: 'sample-match',
      confidence,
      userId: confidence === 'ambiguous' ? null : best.userId,
      name: confidence === 'ambiguous' ? null : best.name,
      matchedSamples: best.matchedSamples,
      totalSamples: best.totalSamples,
      medianDistanceMetres: best.medianDistanceMetres,
      medianSecondsApart: best.medianSecondsApart,
      candidates: candidates.slice(0, 4),
      note:
        confidence === 'ambiguous'
          ? candidates.length + ' users matched the same number of samples'
          : best.matchedSamples +
            ' of ' +
            best.totalSamples +
            ' window samples matched this user’s heartbeats (median ' +
            best.medianDistanceMetres +
            ' m apart, ' +
            best.medianSecondsApart +
            ' s apart)',
    };
  }

  let confidence = 'likely';
  if (best.matchedMinutes >= 3 && (!runnerUp || best.matchedMinutes >= runnerUp.matchedMinutes * 2)) confidence = 'high';
  if (runnerUp && best.matchedMinutes === runnerUp.matchedMinutes) confidence = 'ambiguous';
  return {
    method: 'fence-presence',
    confidence,
    userId: confidence === 'ambiguous' ? null : best.userId,
    name: confidence === 'ambiguous' ? null : best.name,
    matchedMinutes: best.matchedMinutes,
    matchedHeartbeats: best.matchedHeartbeats,
    minDistanceMetres: best.minDistanceMetres,
    candidates: candidates.slice(0, 4),
    note:
      confidence === 'ambiguous'
        ? candidates.length + ' users were at this fence for the same number of minutes'
        : 'at this fence for ' +
          best.matchedMinutes +
          ' minute(s) while the window was open (closest ' +
          best.minDistanceMetres +
          ' m). Weaker evidence: an exit window means a device left, so this can be a colleague who stayed.',
  };
}

/** Attaches `attribution` to each normalized exit-window row. */
async function attributeWindows(rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return list;

  const direct = list.filter((r) => r.userId !== null && r.userId !== undefined);
  const needsInference = list.filter((r) => r.userId === null || r.userId === undefined);

  for (const row of direct) {
    row.attribution = {
      method: 'userId',
      confidence: 'certain',
      userId: row.userId,
      name: null,
      note: 'the document names this user',
    };
  }

  if (needsInference.length) {
    const spans = needsInference.map(windowSpan).filter(Boolean);
    const sampleTimes = needsInference.flatMap((r) =>
      (r.samples || []).map((s) => (s.at ? new Date(s.at).getTime() : null)).filter((t) => Number.isFinite(t))
    );
    const lows = spans.map((s) => s.start).concat(sampleTimes);
    const highs = spans.map((s) => s.end).concat(sampleTimes);

    if (!lows.length) {
      for (const row of needsInference) row.attribution = { method: 'none', confidence: 'none', userId: null };
    } else {
      const from = Math.min(...lows) - SPAN_PAD_MS - SAMPLE_MATCH_MS;
      const to = Math.max(...highs) + SPAN_PAD_MS + SAMPLE_MATCH_MS;
      const tenantIds = [...new Set(list.map((r) => r.tenantId).filter((t) => t !== null && t !== undefined))];

      if (to - from > MAX_SPAN_MS) {
        for (const row of needsInference) {
          row.attribution = { method: 'none', confidence: 'none', userId: null, note: 'time span too wide to attribute' };
        }
      } else {
        let stream = null;
        try {
          stream = await positionStream(from, to, tenantIds);
        } catch (err) {
          for (const row of needsInference) {
            row.attribution = { method: 'none', confidence: 'none', userId: null, note: 'attribution query failed' };
          }
        }
        if (stream) {
          for (const row of needsInference) {
            const result = matchBySamples(row, stream) || matchByFence(row, stream);
            row.attribution = result
              ? decide(row, result)
              : {
                  method: 'none',
                  confidence: 'none',
                  userId: null,
                  note: 'no heartbeat matched this window’s samples or fence',
                };
            if (stream.truncated && row.attribution.method === 'none') {
              row.attribution.note += ' (heartbeat sample capped at ' + MAX_POINTS + ' points)';
            }
          }
        }
      }
    }
  }

  await nameDirectMatches(direct);
  return list;
}

/** Direct matches only carry an id; look up the name from the heartbeats. */
async function nameDirectMatches(rows) {
  const ids = [...new Set(rows.map((r) => r.userId).filter((id) => id !== null && id !== undefined))];
  if (!ids.length) return;
  try {
    const { col, base } = await collectionFor('snapshots');
    const found = await col
      .aggregate(
        [
          { $match: { ...base, [SNAP.userId]: { $in: ids } } },
          { $sort: { createdAt: -1 } },
          { $group: { _id: '$' + SNAP.userId, name: { $first: '$' + SNAP.fullName } } },
        ],
        { maxTimeMS: config.queryTimeoutMs }
      )
      .toArray();
    const names = new Map(found.map((f) => [f._id, f.name]));
    for (const row of rows) {
      if (row.attribution && names.has(row.userId)) row.attribution.name = names.get(row.userId) || null;
    }
  } catch (err) {
    /* names are a nicety - the id is already correct */
  }
}

/** Which exit windows belong to one user, direct or inferred. */
async function windowsForUser(rows, userId) {
  const attributed = await attributeWindows(rows);
  if (userId === null || userId === undefined) return [];
  return attributed.filter((r) => r.attribution && r.attribution.userId === userId);
}

function invalidate() {
  cache.clear();
}

module.exports = {
  attributeWindows,
  windowsForUser,
  positionStream,
  invalidate,
  SAMPLE_MATCH_METRES,
  SAMPLE_MATCH_MS,
  FENCE_SLACK_METRES,
};
