'use strict';
const express = require('express');
const F = require('../lib/filters');
const { clockInsCached } = require('../lib/clockIns');
const csv = require('../lib/csv');

const router = express.Router();

/**
 * Clock-ins: one row per time entry, closed by its shift trail where there is
 * one. See lib/clockIns.js for where each field comes from.
 *
 * One page of rows, latest clock-in first; the totals always cover every row
 * in range. The answer is computed once per filter set and cached, so turning
 * a page slices it rather than running the aggregation again.
 */
router.get('/clockins', async (req, res, next) => {
  try {
    const data = await clockInsCached(req.query);
    const limit = Math.min(Math.max(Math.floor(F.num(req.query.limit) || 50), 1), 500);
    // Past the end - the answer shrank under a page kept across a refresh -
    // lands on the last page rather than an empty one.
    const asked = Math.max(Math.floor(F.num(req.query.offset) || 0), 0);
    const lastPage = data.rows.length ? Math.floor((data.rows.length - 1) / limit) * limit : 0;
    const offset = Math.min(asked, lastPage);
    res.json({
      ...data,
      rows: data.rows.slice(offset, offset + limit),
      total: data.rows.length,
      offset,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

const CSV_COLUMNS = [
  { key: 'userId', label: 'User ID' },
  { key: 'name', label: 'Name' },
  { key: 'employeeRef', label: 'Employee Ref' },
  { key: 'tenantId', label: 'Tenant' },
  { key: 'siteId', label: 'Site ID' },
  { key: 'siteName', label: 'Site Name', get: (r) => (r.site ? r.site.displayName || r.site.name : null) },
  { key: 'timezone', label: 'Timezone' },
  { key: 'clockIn', label: 'Clock In (UTC)' },
  { key: 'clockInNetwork', label: 'Clock-In Network' },
  { key: 'fenceArrivalAt', label: 'Geofence Clock-In (UTC)' },
  { key: 'state', label: 'State' },
  { key: 'clockOut', label: 'Clock Out (UTC)' },
  { key: 'clockOutSource', label: 'Clock Out Source' },
  { key: 'durationMinutes', label: 'Duration (min)' },
  { key: 'durationIsFloor', label: 'Duration Is A Floor' },
  { key: 'lastOnClockAt', label: 'Last Heartbeat On The Clock (UTC)' },
  { key: 'scheduleName', label: 'Scheduled Shift', get: (r) => (r.schedule ? r.schedule.name : null) },
  { key: 'scheduleStart', label: 'Scheduled Start (UTC)', get: (r) => (r.schedule ? r.schedule.start : null) },
  { key: 'lateMinutes', label: 'Minutes After Scheduled Start', get: (r) => (r.schedule ? r.schedule.lateMinutes : null) },
  { key: 'verdict', label: 'Fence Verdict At Clock-In', get: (r) => r.atClockIn.verdict },
  { key: 'distance', label: 'Distance From Boundary (m)', get: (r) => r.atClockIn.distanceFromBoundary },
  { key: 'accuracy', label: 'Accuracy At Clock-In (m)', get: (r) => r.atClockIn.accuracy },
  { key: 'firstFixDelay', label: 'First Fix After Clock-In (min)', get: (r) => r.atClockIn.delayMinutes },
  { key: 'firstFixSource', label: 'First Fix Source', get: (r) => r.atClockIn.source },
  { key: 'facialRequired', label: 'Face Checks Required', get: (r) => r.facial.required },
  { key: 'facialCompleted', label: 'Face Checks Completed', get: (r) => r.facial.completed },
  { key: 'heartbeats', label: 'Heartbeats', get: (r) => r.heartbeats.count },
  { key: 'offlineHeartbeats', label: 'Offline Heartbeats', get: (r) => r.heartbeats.offline },
  { key: 'coverage', label: 'Trail Coverage (%)', get: (r) => (r.trail ? r.trail.coverage : null) },
  { key: 'restarts', label: 'App Restarts', get: (r) => (r.trail ? r.trail.runtimeStarts : null) },
  { key: 'deviceType', label: 'Device', get: (r) => r.device.type },
  { key: 'appVersion', label: 'App Version', get: (r) => r.device.appVersion },
  { key: 'timeEntryId', label: 'Time Entry ID' },
  { key: 'shiftKey', label: 'Shift Key' },
  { key: 'sources', label: 'Sources' },
];

router.get('/clockins.csv', async (req, res, next) => {
  try {
    const data = await clockInsCached(req.query);
    csv.send(res, 'phantom-clock-ins.csv', csv.toCsv(data.rows, CSV_COLUMNS));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
