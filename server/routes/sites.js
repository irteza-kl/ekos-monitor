'use strict';
const express = require('express');
const config = require('../config');
const { collectionFor } = require('../db');
const F = require('../lib/filters');
const { SNAP } = F;
const P = require('../lib/pipelines');
const normalize = require('../lib/normalize');
const geo = require('../lib/geo');
const csv = require('../lib/csv');
const { getSites } = require('../lib/sites');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

/**
 * Geofence sites with who is on them right now. Occupancy is taken from the
 * newest snapshot per user so a site shows live headcount, not history.
 */
router.get('/sites', async (req, res, next) => {
  try {
    const sites = await getSites({ force: req.query.refresh === '1' });

    let occupancy = new Map();
    try {
      const { col, base } = await collectionFor('snapshots');
      const match = F.and([base, F.snapshotMatch(req.query)]);
      const result = await col
        .aggregate(
          P.latestPerUser({ match, postMatch: F.snapshotPostMatch(req.query), sort: { createdAt: -1 }, skip: 0, limit: 500 }),
          opts
        )
        .next();

      for (const doc of result.rows || []) {
        const row = normalize.snapshot(doc);
        if (row.jobSiteId == null) continue;
        const bucket = occupancy.get(row.jobSiteId) || { present: [], inside: 0, outside: 0, unknown: 0 };
        bucket.present.push({
          userId: row.userId,
          name: row.name,
          clockedIn: row.clockedIn,
          insideGeofence: row.isInsideGeofence,
          accuracy: row.accuracy,
          battery: row.battery,
          capturedAt: row.capturedAt,
          ageMinutes: row.ageMinutes,
          location: row.location,
        });
        if (row.isInsideGeofence === true) bucket.inside += 1;
        else if (row.isInsideGeofence === false) bucket.outside += 1;
        else bucket.unknown += 1;
        occupancy.set(row.jobSiteId, bucket);
      }
    } catch (err) {
      if (err.code !== 'COLLECTION_MISSING') throw err;
    }

    const rows = sites.map((s) => {
      const occ = occupancy.get(s.siteId) || { present: [], inside: 0, outside: 0, unknown: 0 };
      // Distance of each present device from this fence, for the guide panel.
      const present = occ.present.map((p) => {
        if (!p.location || !s.plottable || s.radius == null) return { ...p, relation: null, verdict: null };
        const judged = geo.verdictWithAccuracy(
          { lat: p.location.lat, lng: p.location.lng },
          { lat: s.lat, lng: s.lng, radius: s.radius },
          p.location.accuracy
        );
        return { ...p, relation: judged.relation, verdict: judged.verdict, verdictReason: judged.reason };
      });
      return {
        ...s,
        occupancy: { total: present.length, inside: occ.inside, outside: occ.outside, unknown: occ.unknown },
        present,
        breachRate:
          s.validations && s.outsideEvents != null ? geo.round((100 * s.outsideEvents) / s.validations, 1) : null,
        mapsUrl: s.plottable ? 'https://www.google.com/maps/search/?api=1&query=' + s.lat + ',' + s.lng : null,
      };
    });

    const filterId = F.nums(req.query.jobSiteId);
    const filtered = filterId.length ? rows.filter((r) => filterId.includes(r.siteId)) : rows;

    res.json({
      rows: filtered,
      total: filtered.length,
      withFence: filtered.filter((r) => r.hasFence).length,
      plottable: filtered.filter((r) => r.plottable).length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sites.csv', async (req, res, next) => {
  try {
    const sites = await getSites();
    const text = csv.toCsv(sites, [
      { key: 'siteId', label: 'Site ID' },
      { key: 'label', label: 'Label' },
      { key: 'address', label: 'Address' },
      { key: 'city', label: 'City' },
      { key: 'country', label: 'Country' },
      { key: 'lat', label: 'Latitude' },
      { key: 'lng', label: 'Longitude' },
      { key: 'radius', label: 'Radius (m)' },
      { key: 'effectiveRadius', label: 'Max Effective Radius (m)' },
      { key: 'source', label: 'Coordinate Source' },
      { key: 'validations', label: 'Geofence Checks' },
      { key: 'outsideEvents', label: 'Outside Events' },
      { key: 'graceEvents', label: 'Accuracy-Grace Events' },
      { key: 'clockOutEvents', label: 'Auto Clock-Outs' },
      { key: 'snapshots', label: 'Snapshots' },
      { key: 'insideSnapshots', label: 'Snapshots Inside' },
      { key: 'outsideSnapshots', label: 'Snapshots Outside' },
      { key: 'avgAccuracy', label: 'Avg Accuracy (m)' },
      { key: 'worstAccuracy', label: 'Worst Accuracy (m)' },
      { key: 'users', label: 'Distinct Users' },
      { key: 'lastSeenAt', label: 'Last Activity (UTC)' },
    ]);
    csv.send(res, 'phantom-sites.csv', text);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
