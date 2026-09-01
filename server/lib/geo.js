'use strict';
const R = 6371008.8; // mean earth radius, metres
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function isPoint(p) {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/** Great-circle distance in metres. */
function haversine(a, b) {
  if (!isPoint(a) || !isPoint(b)) return null;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a -> b, degrees from north. */
function bearing(a, b) {
  if (!isPoint(a) || !isPoint(b)) return null;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compass(brg) {
  if (!Number.isFinite(brg)) return null;
  return COMPASS[Math.round(brg / 22.5) % 16];
}

/**
 * Where a point sits relative to a circular geofence.
 * Positive distanceFromBoundary means outside the fence by that many metres.
 */
function fenceRelation(point, fence) {
  if (!isPoint(point) || !isPoint(fence) || !Number.isFinite(fence.radius)) return null;
  const distance = haversine(fence, point);
  const brg = bearing(fence, point);
  return {
    distanceFromCenter: round(distance, 1),
    distanceFromBoundary: round(distance - fence.radius, 1),
    inside: distance - fence.radius <= 0,
    bearing: round(brg, 0),
    compass: compass(brg),
  };
}

/**
 * Verdict that respects GPS accuracy: a fix whose accuracy circle straddles the
 * fence boundary cannot honestly be called in or out.
 */
function verdictWithAccuracy(point, fence, accuracy) {
  const relation = fenceRelation(point, fence);
  if (!relation) return { verdict: 'unknown', reason: 'missing coordinates', relation: null };
  const acc = Number.isFinite(accuracy) ? accuracy : null;
  if (acc === null) {
    return { verdict: relation.inside ? 'in' : 'out', reason: 'no accuracy reported', relation };
  }
  if (Math.abs(relation.distanceFromBoundary) <= acc) {
    return {
      verdict: 'unknown',
      reason: 'accuracy ' + acc.toFixed(0) + 'm straddles the boundary',
      relation,
    };
  }
  return { verdict: relation.inside ? 'in' : 'out', reason: null, relation };
}

const ACCURACY_BANDS = [
  { key: 'excellent', label: 'Excellent (<10m)', max: 10 },
  { key: 'good', label: 'Good (10-25m)', max: 25 },
  { key: 'fair', label: 'Fair (25-50m)', max: 50 },
  { key: 'poor', label: 'Poor (50-100m)', max: 100 },
  { key: 'unusable', label: 'Unusable (100m+)', max: Infinity },
];

function accuracyBand(accuracy) {
  if (!Number.isFinite(accuracy)) return 'unknown';
  const band = ACCURACY_BANDS.find((b) => accuracy < b.max);
  return band ? band.key : 'unusable';
}

/** Centroid of a set of points, good enough for deriving a site centre. */
function centroid(points) {
  const pts = (points || []).filter(isPoint);
  if (!pts.length) return null;
  let lat = 0;
  let lng = 0;
  for (const p of pts) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / pts.length, lng: lng / pts.length };
}

/** Bounding box of points, as [[south, west], [north, east]]. */
function bounds(points) {
  const pts = (points || []).filter(isPoint);
  if (!pts.length) return null;
  let s = pts[0].lat;
  let n = pts[0].lat;
  let w = pts[0].lng;
  let e = pts[0].lng;
  for (const p of pts) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
  }
  return [[s, w], [n, e]];
}

module.exports = {
  haversine,
  bearing,
  compass,
  fenceRelation,
  verdictWithAccuracy,
  accuracyBand,
  ACCURACY_BANDS,
  centroid,
  bounds,
  isPoint,
  round,
};
