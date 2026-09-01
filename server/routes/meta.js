'use strict';
const express = require('express');
const config = require('../config');
const { resolveCollections, collectionFor, ping } = require('../db');
const { SNAP, LOG } = require('../lib/filters');
const { ACCURACY_BANDS } = require('../lib/geo');
const { ALL_PERMISSIONS } = require('../lib/normalize');
const { getSites } = require('../lib/sites');

const router = express.Router();
const opts = { allowDiskUse: true, maxTimeMS: config.queryTimeoutMs };

let cache = { at: 0, data: null };
const TTL_MS = 60 * 1000;

router.get('/meta', async (req, res, next) => {
  try {
    if (req.query.refresh !== '1' && cache.data && Date.now() - cache.at < TTL_MS) {
      return res.json({ ...cache.data, cached: true });
    }

    const collections = await resolveCollections({ force: req.query.refresh === '1' });
    const data = {
      database: collections.database,
      collections: {
        snapshots: collections.snapshots,
        clockInLogs: collections.clockInLogs,
        exitWindows: collections.exitWindows,
        counts: collections.counts,
        available: collections.available,
      },
      accuracyBands: ACCURACY_BANDS.map((b) => ({ key: b.key, label: b.label, max: b.max === Infinity ? null : b.max })),
      permissions: ALL_PERMISSIONS,
      generatedAt: new Date().toISOString(),
    };

    // --- snapshots facets ---------------------------------------------------
    try {
      const { col, base } = await collectionFor('snapshots');
      const facet = await col
        .aggregate(
          [
            { $match: base },
            {
              $facet: {
                range: [{ $group: { _id: null, min: { $min: '$createdAt' }, max: { $max: '$createdAt' } } }],
                users: [
                  {
                    $group: {
                      _id: '$' + SNAP.userId,
                      name: { $last: '$' + SNAP.fullName },
                      tenantId: { $last: '$' + SNAP.tenantId },
                      lastSeenAt: { $max: '$createdAt' },
                      snapshots: { $sum: 1 },
                    },
                  },
                  { $sort: { lastSeenAt: -1 } },
                ],
                tenants: [
                  {
                    $group: {
                      _id: '$' + SNAP.tenantId,
                      name: { $last: { $arrayElemAt: ['$currentUser.data.tenantAccount.tenant.name', 0] } },
                      snapshots: { $sum: 1 },
                    },
                  },
                  { $sort: { snapshots: -1 } },
                ],
                deviceTypes: [{ $group: { _id: '$deviceType', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
                appVersions: [
                  { $group: { _id: '$' + SNAP.appVersion, builds: { $addToSet: '$' + SNAP.build }, n: { $sum: 1 } } },
                  { $sort: { n: -1 } },
                ],
                timezones: [{ $group: { _id: '$timezone', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
                jobSites: [
                  { $group: { _id: { $ifNull: ['$' + SNAP.jobSiteId, '$' + SNAP.jobSiteIdAlt] }, n: { $sum: 1 } } },
                  { $sort: { n: -1 } },
                ],
              },
            },
          ],
          opts
        )
        .next();

      const first = (arr) => (arr && arr[0]) || {};
      data.snapshotRange = { min: first(facet.range).min || null, max: first(facet.range).max || null };
      data.users = facet.users.map((u) => ({
        id: u._id,
        name: u.name || (u._id === null ? 'Unidentified device' : 'User ' + u._id),
        tenantId: u.tenantId ?? null,
        lastSeenAt: u.lastSeenAt,
        snapshots: u.snapshots,
      }));
      data.tenants = facet.tenants.map((t) => ({
        id: t._id,
        name: t.name || (t._id === null ? 'No tenant' : 'Tenant ' + t._id),
        snapshots: t.snapshots,
      }));
      data.deviceTypes = facet.deviceTypes.map((d) => ({ key: d._id, count: d.n })).filter((d) => d.key);
      data.appVersions = facet.appVersions
        .map((v) => ({ key: v._id, builds: (v.builds || []).filter(Boolean), count: v.n }))
        .filter((v) => v.key);
      data.timezones = facet.timezones.map((t) => ({ key: t._id, count: t.n })).filter((t) => t.key);
      data.jobSiteIds = facet.jobSites.map((s) => ({ id: s._id, snapshots: s.n })).filter((s) => s.id !== null);
    } catch (err) {
      if (err.code !== 'COLLECTION_MISSING') throw err;
      data.snapshotsUnavailable = err.message;
    }

    // --- clock-in log facets ------------------------------------------------
    try {
      const { col } = await collectionFor('clockInLogs');
      const facet = await col
        .aggregate(
          [
            {
              $facet: {
                range: [{ $group: { _id: null, min: { $min: '$createdAt' }, max: { $max: '$createdAt' } } }],
                sites: [{ $group: { _id: '$' + LOG.siteId, n: { $sum: 1 } } }, { $sort: { n: -1 } }],
                users: [{ $group: { _id: '$userId', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
              },
            },
          ],
          opts
        )
        .next();
      data.logRange = { min: (facet.range[0] || {}).min || null, max: (facet.range[0] || {}).max || null };
      data.logSites = facet.sites.map((s) => ({ id: s._id, validations: s.n }));
      data.logUsers = facet.users.map((u) => ({ id: u._id, validations: u.n }));
    } catch (err) {
      if (err.code !== 'COLLECTION_MISSING') throw err;
      data.clockInLogsUnavailable = err.message;
    }

    // --- exit window facets (collection is optional) ------------------------
    data.exitWindows = { available: false };
    try {
      const { col, base } = await collectionFor('exitWindows');
      const facet = await col
        .aggregate(
          [
            { $match: base },
            {
              $facet: {
                statuses: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
                resolutions: [{ $group: { _id: '$resolution', n: { $sum: 1 } } }],
                openedBy: [{ $group: { _id: '$openedBy', n: { $sum: 1 } } }],
                deviceTypes: [{ $group: { _id: '$deviceType', n: { $sum: 1 } } }],
                users: [{ $group: { _id: '$userId', employeeId: { $last: '$employeeId' }, n: { $sum: 1 } } }],
                companies: [{ $group: { _id: { $ifNull: ['$companyId', '$tenantId'] }, n: { $sum: 1 } } }],
                range: [{ $group: { _id: null, min: { $min: '$openedAt' }, max: { $max: '$openedAt' } } }],
                total: [{ $count: 'value' }],
              },
            },
          ],
          opts
        )
        .next();
      const asList = (a) => a.map((x) => ({ key: x._id, count: x.n })).filter((x) => x.key !== null);
      const epochToIso = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : v || null);
      data.exitWindows = {
        available: true,
        total: (facet.total[0] || {}).value || 0,
        statuses: asList(facet.statuses),
        resolutions: asList(facet.resolutions),
        openedBy: asList(facet.openedBy),
        deviceTypes: asList(facet.deviceTypes),
        // Windows written without a session have userId null - not a filterable value.
        users: facet.users.filter((u) => u._id !== null).map((u) => ({ id: u._id, employeeId: u.employeeId, count: u.n })),
        anonymousWindows: (facet.users.find((u) => u._id === null) || {}).n || 0,
        companies: asList(facet.companies),
        sites: [],
        range: {
          min: epochToIso((facet.range[0] || {}).min),
          max: epochToIso((facet.range[0] || {}).max),
        },
      };
    } catch (err) {
      if (err.code !== 'COLLECTION_MISSING') throw err;
      data.exitWindows = { available: false, reason: 'No exit_window documents found in ' + config.dbName };
    }

    try {
      const sites = await getSites({ force: req.query.refresh === '1' });
      data.sites = sites.map((s) => ({
        siteId: s.siteId,
        label: s.label,
        hasFence: s.hasFence,
        radius: s.radius,
        address: s.address,
      }));
    } catch (err) {
      data.sites = [];
      data.sitesError = err.message;
    }

    cache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/health', async (req, res) => {
  try {
    const latency = await ping();
    const collections = await resolveCollections();
    res.json({
      ok: true,
      database: collections.database,
      pingMs: latency,
      counts: collections.counts,
      collections: {
        snapshots: collections.snapshots,
        clockInLogs: collections.clockInLogs,
        exitWindows: collections.exitWindows,
      },
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

module.exports = router;
