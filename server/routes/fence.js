'use strict';
const express = require('express');
const { fenceTimeCached } = require('../lib/fence');
const csv = require('../lib/csv');

const router = express.Router();

const load = (query) => fenceTimeCached(query);

/**
 * Time on site, measured rather than sampled.
 *
 * Separate from /api/stats on purpose: it answers a different question, it costs
 * a partition sort over the whole range, and keeping it apart lets the Overview
 * page request both at once instead of waiting for one slower endpoint.
 */
router.get('/fence-time', async (req, res, next) => {
  try {
    const data = await load(req.query);
    // The visit list is long and only the user page needs all of it.
    const detail = req.query.visits === '1';
    res.json({
      generatedAt: data.generatedAt,
      totals: data.totals,
      perUser: data.perUser,
      openVisits: data.openVisits,
      visits: detail ? data.visits : data.visits.slice(0, 200),
      visitsTruncated: detail ? false : data.visits.length > 200,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/fence-time.csv', async (req, res, next) => {
  try {
    const data = await load(req.query);
    const hours = (v) => (v === null || v === undefined ? '' : Math.round((v / 3600000) * 100) / 100);
    const pct = (v) => (v === null || v === undefined ? '' : Math.round(v * 1000) / 10);
    const rows = data.perUser.map((u) => ({
      userId: u.userId,
      name: u.name,
      timezone: u.timezone,
      insideHours: hours(u.insideMs),
      outsideHours: hours(u.outsideMs),
      unknownHours: hours(u.unknownMs),
      silentHours: hours(u.silentMs),
      onClockHours: hours(u.onClockMs),
      measuredHours: hours(u.measuredMs),
      observedHours: hours(u.observedMs),
      insidePct: pct(u.insideShare),
      insidePctByBeats: pct(u.insideShareByBeats),
      accountedPct: pct(u.accountedShare),
      visits: u.visits,
      closedVisits: u.closedVisits,
      jitterVisits: u.jitterVisits,
      longestVisitHours: hours(u.longestVisitMs),
      eventCoverage: u.eventCoverage,
      beatsPerHour: u.beatsPerHour,
      insideNow: u.insideNow,
      neverExited: u.neverExited,
    }));
    const text = csv.toCsv(rows, [
      { key: 'userId', label: 'User ID' },
      { key: 'name', label: 'Name' },
      { key: 'timezone', label: 'Timezone' },
      { key: 'insideHours', label: 'Inside (h)' },
      { key: 'outsideHours', label: 'Outside (h)' },
      { key: 'unknownHours', label: 'No Verdict (h)' },
      { key: 'silentHours', label: 'Silent (h)' },
      { key: 'onClockHours', label: 'On The Clock (h)' },
      { key: 'measuredHours', label: 'Measured (h)' },
      { key: 'observedHours', label: 'Watched (h)' },
      { key: 'insidePct', label: 'Inside % (by time)' },
      { key: 'insidePctByBeats', label: 'Inside % (by heartbeat count)' },
      { key: 'accountedPct', label: 'Of Watched Time Accounted %' },
      { key: 'visits', label: 'Visits (floor)' },
      { key: 'closedVisits', label: 'Visits With Recorded Exit' },
      { key: 'jitterVisits', label: 'Visits Under A Minute' },
      { key: 'longestVisitHours', label: 'Longest Visit (h)' },
      { key: 'eventCoverage', label: 'Crossing Marker Coverage' },
      { key: 'beatsPerHour', label: 'Heartbeats / h' },
      { key: 'insideNow', label: 'Inside On Last Heartbeat' },
      { key: 'neverExited', label: 'Entered And Never Left' },
    ]);
    csv.send(res, 'phantom-fence-time.csv', text);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
