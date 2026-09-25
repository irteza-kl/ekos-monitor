/* One user, one page.
   Above: a hero header, KPI tiles, and the person / device / state / shift
   detail cards. Below: everything else in tabs - location & trail, history,
   geofence validation calls, exit windows, raw document. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  const params = new URLSearchParams(location.search);
  const userId = params.get('userId') || 'anonymous';

  let detail = null;
  let tabs = null;
  let heartbeatPage = 1;
  // Scoped to the Heartbeats tab rather than added to the page filter bar.
  // The bar re-scopes the whole page - the KPI tiles, the trail, the History
  // charts - and "let me read the offline pings" is a question about this one
  // table, not a decision to view the person through an offline-only lens.
  let heartbeatOfflineOnly = false;
  let shiftTrailPage = 1;
  // The trail map, its preferences, its window bar, its replay and the note
  // that accounts for every heartbeat all live in PMTrailMap now - the
  // Heartbeats page mounts the same panel. What stays here is the time window,
  // because it scopes this page's other queries too (see scopedQuery).

  PM.boot(
    'user.html',
    async ({ root }) => {
      PM.buildFilterBar(
        () => [
          { kind: 'daterange' },
          {
            kind: 'multi',
            key: 'accuracyBand',
            label: 'Accuracy band',
            options: PM.optionsFrom(PM.state.meta.accuracyBands || [], 'key', 'label'),
          },
          { kind: 'tri', key: 'clockedIn', label: 'Clocked in', yes: 'On the clock', no: 'Off the clock' },
          { kind: 'tri', key: 'insideGeofence', label: 'Inside fence', yes: 'Inside', no: 'Outside', nullable: true },
        ],
        // userId is this page's identity, not a filter chip to clear.
        { hideChips: ['userId'] }
      );

      root.append(
        el('div', { class: 'crumb' }, [el('a', { href: PM.withWindow('/users.html'), text: '← All users & devices' })]),
        el('div', { class: 'hero', id: 'hero' }),
        el('div', { class: 'tiles tiles-4', id: 'user-tiles' }),
        el('div', { id: 'user-notices' }),
        el('div', { class: 'detail-grid' }, [
          card('Person', 'identity-card'),
          card('Device', 'device-card'),
          card('Right now', 'state-card'),
          card('Shift & verification', 'shift-card'),
        ]),
        el('div', { class: 'tab-card', id: 'tab-host' })
      );

      tabs = PM.pageTabs(
        document.querySelector('#tab-host'),
        [
          { id: 'location', label: 'Location & trail', padded: false, render: renderLocationTab, onShow: resizeMap },
          { id: 'history', label: 'History', render: renderHistoryTab },
          { id: 'heartbeats', label: 'Heartbeats', render: renderHeartbeatsTab },
          { id: 'calls', label: 'Geofence validation calls', render: renderCallsTab },
          { id: 'exit-windows', label: 'Exit windows', render: renderExitWindowsTab },
          { id: 'shift-trails', label: 'Shift trails', render: renderShiftTrailsTab },
          { id: 'raw', label: 'Raw document', render: renderRawTab },
        ],
        // Nothing to render until the first load() resolves.
        { defer: true, skeleton: 'block' }
      );

      await load();
      // The page filter is the authority: changing it drops any narrower map
      // window, or the filter bar would appear to do nothing.
      window.addEventListener('pm:filters', () => {
        mapWindow = null;
        load();
      });
      window.addEventListener('pm:refresh', load);
    },
    { activeFile: 'users.html', title: 'User' }
  );

  function card(title, id) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: title })]),
      el('div', { class: 'card-body', id }),
    ]);
  }

  async function load() {
    PM.showSkeleton({
      '#hero': 'text:2',
      '#user-tiles': 'tiles:8',
      '#identity-card': 'kv:8',
      '#device-card': 'kv:8',
      '#state-card': 'kv:6',
      '#shift-card': 'kv:6',
    });
    try {
      detail = await api(
        '/api/users/' + encodeURIComponent(userId) + '?historyLimit=' + PMTrailMap.fixLimit() + '&' + scopedQuery()
      );
    } catch (err) {
      renderLoadFailure(err);
      return;
    }

    const row = detail.current;
    const stats = detail.stats || {};
    heartbeatPage = 1; // a new time range means the old page numbers are moot
    shiftTrailPage = 1;
    PM.setTitle(row.name || (row.userId === null ? 'Unidentified device' : 'User ' + row.userId));
    PM.setSubtitle(
      [
        row.employeeRef,
        row.tenantName,
        row.userId === null ? 'no session id' : 'user ' + row.userId,
        fmt.int(stats.snapshots) + ' heartbeats in range',
      ]
        .filter(Boolean)
        .join(' · ')
    );

    renderHero(row);
    renderTiles(stats);
    renderNotices(row);
    renderIdentity(row);
    renderDevice(row);
    renderState(row);
    renderShift(row);

    tabs.setCount('history', (detail.track || []).length);
    tabs.setCount('heartbeats', stats.snapshots);
    tabs.setCount('calls', (detail.logs || []).length);
    tabs.setCount('exit-windows', (detail.exitWindows || []).length);
    // Shift trails are not part of the user payload, so their count is asked
    // for separately - and not awaited, because the rest of the page has no
    // reason to wait on it. The old badge goes first: a count from the previous
    // time range must not stand beside a range it no longer describes.
    tabs.setCount('shift-trails', null);
    loadShiftTrailCount();
    tabs.invalidate();
    PM.markLoaded();
  }

  // ------------------------------------------------------------------- above
  function renderHero(row) {
    const host = document.querySelector('#hero');
    host.innerHTML = '';
    const badges = el('div', { class: 'hero-badges' });
    badges.innerHTML =
      (row.accountStatus
        ? '<span class="badge ' +
          (String(row.accountStatus).toUpperCase() === 'ACTIVE' ? 'badge-good' : 'badge-warning') +
          '">' +
          esc(row.accountStatus) +
          '</span>'
        : '') +
      (row.clockedIn
        ? '<span class="badge badge-good">● On the clock</span>'
        : '<span class="badge badge-neutral">○ Off the clock</span>') +
      PM.geofenceBadge(row.isInsideGeofence, row.computedVerdict, row.verdictReason) +
      PM.accuracyBadge(row.accuracyBand, row.accuracy) +
      PM.batteryBadge(row.battery) +
      '<span class="badge badge-neutral">' + esc(row.deviceType || 'device ?') + ' · v' + esc(row.appVersion || '?') + '</span>' +
      (row.offline ? '<span class="badge badge-critical">offline</span>' : '') +
      (row.verdictDisagrees ? '<span class="badge badge-critical">⚑ verdict mismatch</span>' : '');

    host.append(
      el('div', { class: 'hero-avatar', text: fmt.initials(row.name) }),
      el('div', { class: 'hero-main' }, [
        el('div', { class: 'hero-name', text: row.name || 'Unidentified device' }),
        el('div', {
          class: 'hero-sub',
          text:
            [
              row.employeeRef,
              row.tenantName,
              row.role,
              row.jobSiteId != null || row.site ? PM.siteName(row.site, row.jobSiteId) : 'no site',
            ]
              .filter(Boolean)
              .join(' · ') || 'no session data',
        }),
      ]),
      el('div', { style: 'margin-left:auto;min-width:0' }, [
        badges,
        el('div', { class: 'hero-seen', text: 'last snapshot ' + fmt.ago(row.capturedAt) + ' · ' + fmt.date(row.capturedAt) }),
      ])
    );
  }

  function tile(label, value, note, tone) {
    return el('div', { class: 'tile ' + (tone ? 'is-' + tone : '') }, [
      el('div', { class: 'tile-label', text: label }),
      el('div', { class: 'tile-value', text: value }),
      el('div', { class: 'tile-note', text: note }),
    ]);
  }

  function renderTiles(stats) {
    const host = document.querySelector('#user-tiles');
    host.innerHTML = '';
    const flagged = (stats.inside || 0) + (stats.outside || 0);
    const battery =
      (stats.minBattery === null || stats.minBattery === undefined ? '?' : stats.minBattery) +
      '-' +
      (stats.maxBattery === null || stats.maxBattery === undefined ? '?' : stats.maxBattery) +
      '%';
    host.append(
      tile('Heartbeats in range', fmt.int(stats.snapshots), 'since ' + fmt.dayTime(stats.firstSeenAt)),
      tile(
        'Inside fence',
        fmt.int(stats.inside),
        flagged ? fmt.pct((100 * (stats.inside || 0)) / flagged) + ' of flagged heartbeats' : 'no fence flags'
      ),
      tile(
        'Outside fence',
        fmt.int(stats.outside),
        flagged ? fmt.pct((100 * (stats.outside || 0)) / flagged) + ' of flagged heartbeats' : 'no fence flags',
        stats.outside ? 'critical' : undefined
      ),
      tile(
        'Avg accuracy',
        fmt.accuracy(stats.avgAccuracy),
        'best ' + fmt.accuracy(stats.bestAccuracy) + ' · worst ' + fmt.accuracy(stats.worstAccuracy),
        stats.avgAccuracy > 50 ? 'warning' : undefined
      ),
      // Travelled distance is summed over the plotted track, which is the newest
      // `historyLimit` heartbeats - not the range - whenever a device reports
      // faster than that. Every other tile here is over the whole range, so the
      // one that is not has to say so.
      tile(
        'Distance travelled',
        fmt.metres(stats.travelledMetres),
        detail.trackTruncated ? 'over the plotted trail, not the range' : 'summed between heartbeats',
        detail.trackTruncated ? 'warning' : undefined
      ),
      tile('Battery range', battery, 'across the window', stats.minBattery !== null && stats.minBattery <= 10 ? 'warning' : undefined),
      tile('Offline pings', fmt.int(stats.offline), 'heartbeats with no connectivity', stats.offline ? 'serious' : undefined),
      tile(
        'Sites visited',
        fmt.int((stats.siteIds || []).length),
        (stats.siteIds || []).length ? 'sites ' + stats.siteIds.join(', ') : 'none mapped'
      )
    );
  }

  function renderNotices(row) {
    const host = document.querySelector('#user-notices');
    host.innerHTML = '';
    const notes = [];
    if (row.verdictDisagrees) {
      notes.push(
        '<b>The app flag and the geometry disagree.</b> The device reports ' +
          (row.isInsideGeofence ? 'inside' : 'outside') +
          ' while the stored fence puts it ' +
          esc(row.computedVerdict) +
          '.'
      );
    }
    if (row.computedVerdict === 'unknown') {
      // Capitalise the reason: it is a sentence fragment from the geo helper.
      const reason = esc(row.verdictReason || '');
      notes.push(
        '<b>The latest heartbeat cannot decide the fence.</b> ' +
          (reason ? reason.charAt(0).toUpperCase() + reason.slice(1) + ' - ' : '') +
          'treat inside/outside for this user as unresolved.'
      );
    }
    if ((row.permissionsMissing || []).includes('LOCATION_BACKGROUND')) {
      notes.push('<b>Background location is denied.</b> Geofence events will be missed while the app is not in the foreground.');
    }
    if (row.battery !== null && row.battery <= 15) {
      notes.push('<b>Battery is at ' + row.battery + '%.</b> Expect the heartbeat to stop soon.');
    }
    for (const text of notes) {
      host.append(el('div', { class: 'notice', html: '<span>⚠</span><span>' + text + '</span>' }));
    }
  }

  function renderIdentity(row) {
    const host = document.querySelector('#identity-card');
    host.innerHTML = '';
    host.append(
      PM.kv([
        ['Full name', row.name || '--'],
        ['Email', row.email ? '<a href="mailto:' + esc(row.email) + '">' + esc(row.email) + '</a>' : '--'],
        ['Phone', row.phone || '--'],
        ['Employee reference', row.employeeRef || '--'],
        ['Role', [row.role, row.accountType].filter(Boolean).join(' · ') || '--'],
        ['Tenant', row.tenantName ? esc(row.tenantName) + (row.tenantCode ? ' (code ' + esc(row.tenantCode) + ')' : '') : '--'],
        ['User id', row.userId === null ? 'none - reports without a session' : String(row.userId)],
        ['Subscription', row.subscription || '--'],
        [
          'Tenant rules',
          row.tenantSettings
            ? [
                row.tenantSettings.geoFenceClockOutEnabled ? 'geofence clock-out on' : 'geofence clock-out off',
                row.tenantSettings.enableFacialRecognition ? 'face verification on' : 'face verification off',
                row.tenantSettings.facialVerificationInterval
                  ? 'every ' + fmt.duration(row.tenantSettings.facialVerificationInterval / 60)
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : '--',
        ],
      ])
    );
  }

  /** batteryOptimizationPermission is a tri-state, so say what it means. */
  function batteryOptimisation(value) {
    if (value === null || value === undefined) return '';
    return value ? ' · exempt from battery optimisation' : ' · subject to battery optimisation';
  }

  function renderDevice(row) {
    const host = document.querySelector('#device-card');
    host.innerHTML = '';
    const perms = el('div', { class: 'chips', style: 'margin-top:10px' });
    for (const p of row.permissionsEnabled || []) {
      perms.append(el('span', { class: 'chip', html: '<span class="badge badge-good">✓</span>' + esc(p) }));
    }
    for (const p of row.permissionsMissing || []) {
      perms.append(el('span', { class: 'chip', html: '<span class="badge badge-critical">✕</span>' + esc(p) }));
    }
    host.append(
      PM.kv([
        ['Platform', (row.deviceType || '?') + ' · app ' + (row.appVersion || '?') + ' build ' + (row.buildVersion || '?')],
        ['Battery', PM.batteryBadge(row.battery) + batteryOptimisation(row.batteryOptimizationPermission)],
        [
          'Connectivity',
          (row.isConnected
            ? '<span class="badge badge-good">connected</span>'
            : '<span class="badge badge-critical">disconnected</span>') +
            ' ' +
            (row.isReachable
              ? '<span class="badge badge-neutral">reachable</span>'
              : '<span class="badge badge-warning">unreachable</span>'),
        ],
        [
          'Session',
          (row.sessionLoggedIn ? 'session active' : 'session inactive') +
            ' · ' +
            (row.isUserLoggedIn ? 'user logged in' : 'user logged out'),
        ],
        [
          'Timezone',
          (row.timezone || '?') +
            (row.timezoneOffsetMinutes === null
              ? ''
              : ' (UTC' + (row.timezoneOffsetMinutes >= 0 ? '+' : '') + row.timezoneOffsetMinutes / 60 + ')'),
        ],
        ['Device clock', row.deviceTime || '--'],
        ['Clock drift vs server', row.clockDriftSeconds === null ? '--' : row.clockDriftSeconds + ' s'],
        [
          'Always-on location',
          row.locationAlways
            ? '<span class="badge badge-good">allowed</span>'
            : '<span class="badge badge-warning">not allowed</span>',
        ],
      ]),
      el('div', { class: 'section-title', style: 'margin-top:14px', text: 'Permissions' }),
      perms
    );
  }

  function renderState(row) {
    const host = document.querySelector('#state-card');
    host.innerHTML = '';
    const rel = row.relation;
    host.append(
      PM.kv([
        [
          'Clock',
          row.clockedIn
            ? '<span class="badge badge-good">● on the clock</span>'
            : '<span class="badge badge-neutral">○ off the clock</span>',
        ],
        ['Geofence (device flag)', PM.geofenceBadge(row.isInsideGeofence)],
        [
          'Geofence (recomputed)',
          row.computedVerdict
            ? PM.geofenceBadge(null, row.computedVerdict, row.verdictReason) +
              (row.verdictReason ? ' <span class="hint">' + esc(row.verdictReason) + '</span>' : '')
            : 'no fence on record for this site',
        ],
        [
          'Site',
          row.jobSiteId != null || row.site
            ? esc(PM.siteName(row.site, row.jobSiteId)) +
              (row.site && row.site.address ? ' <span class="hint">' + esc(row.site.address) + '</span>' : '')
            : 'unmapped',
        ],
        ['Fix', fmt.coords(row.location) + ' · ' + PM.accuracyBadge(row.accuracyBand, row.accuracy)],
        rel
          ? [
              'Distance to boundary',
              fmt.metres(Math.abs(rel.distanceFromBoundary)) +
                (rel.inside ? ' inside' : ' outside') +
                ' · bearing ' +
                rel.bearing +
                '° ' +
                rel.compass,
            ]
          : undefined,
        row.guide
          ? [
              'Guide back',
              '<a href="' +
                row.guide.directionsUrl +
                '" target="_blank" rel="noopener">walking directions ↗</a> (' +
                fmt.metres(row.guide.distanceMetres) +
                ' ' +
                (row.guide.compass || '') +
                ')',
            ]
          : undefined,
        ['Geofence entered', fmt.dateIn(row.geofenceIn, row.timezone)],
        ['Geofence left', fmt.dateIn(row.geofenceOut, row.timezone)],
        [
          'Last snapshot',
          // Their local time answers "when", the relative time answers "how
          // fresh"; a viewer eleven hours away needs both.
          fmt.dateIn(row.capturedAt, row.timezone) + ' (' + fmt.ago(row.capturedAt) + ')',
        ],
      ])
    );
  }

  function renderShift(row) {
    const host = document.querySelector('#shift-card');
    host.innerHTML = '';
    const te = row.timeEntry;
    const fv = row.facialVerification || {};
    host.append(
      PM.kv([
        ['Time entry', te ? '#' + te.id + ' · ' + (te.status || '?') + (te.date ? ' · ' + te.date : '') : 'none open'],
        [
          'Clock in',
          te ? fmt.dateIn(te.clockIn, row.timezone) + (te.clockInNetworkStatus ? ' (' + te.clockInNetworkStatus + ')' : '') : '--',
        ],
        [
          'Clock out',
          te ? fmt.dateIn(te.clockOut, row.timezone) + (te.clockOutNetworkStatus ? ' (' + te.clockOutNetworkStatus + ')' : '') : '--',
        ],
        ['Geofence clock in', te ? fmt.dateIn(te.geoFenceClockIn, row.timezone) : '--'],
        ['Geofence clock out', te ? fmt.dateIn(te.geoFenceClockOut, row.timezone) : '--'],
        ['Site area', te && te.siteAreaId != null ? 'Site area ' + te.siteAreaId : '--'],
        [
          'Face verification',
          fv.enabled
            ? (fv.completed || 0) +
              ' of ' +
              (fv.required || 0) +
              ' done' +
              (fv.intervalSeconds ? ' · every ' + fmt.duration(fv.intervalSeconds / 60) : '') +
              (fv.pending ? ' <span class="badge badge-warning">pending</span>' : '')
            : 'disabled for this tenant',
        ],
        ['Total duration', te && te.totalDuration ? String(te.totalDuration) : '--'],
      ])
    );
  }

  // -------------------------------------------------------------------- tabs

  let mapWindow = null;


  /**
   * Every request this page makes, scoped the same way.
   *
   * The map window was applied in load() only, so the Heartbeats tab - which
   * fetches its own page from /api/snapshots - kept answering for the whole page
   * range while the map beside it answered for fifteen minutes. Two tabs of the
   * same person disagreeing about how many heartbeats exist is worse than either
   * number on its own, so the scope lives here and every caller goes through it.
   *
   * `range: 'custom'` matters: queryString() resolves a preset like "last 24h"
   * into its own `from` and deletes `to`, so an explicit window has to say it is
   * not a preset or it would be silently overwritten.
   */
  function scopedQuery(extra) {
    const scope = mapWindow ? { range: "custom", from: mapWindow.from, to: mapWindow.to } : null;
    if (!scope && !extra) return queryString();
    return queryString(Object.assign({}, scope, extra));
  }

  function setMapWindow(next) {
    mapWindow = next;
    load();
  }





  function chartBlock(title, subtitle, canvasId, extra) {
    return el('div', {}, [
      el('div', { style: 'display:flex;align-items:baseline;gap:10px;margin-bottom:6px' }, [
        el('div', { style: 'font-size:13.5px;font-weight:600', text: title }),
        el('span', { class: 'hint', text: subtitle }),
      ]),
      el('div', { class: 'chart-wrap short' }, [el('canvas', { id: canvasId })]),
      ...(extra || []),
    ]);
  }

  /**
   * A line chart cannot show more points than the canvas has pixels, and
   * Chart.js will try anyway: three charts over a 50,000-point track is a hung
   * tab, and even at 5,000 the lines are denser than they are readable.
   *
   * So the track is bucketed into at most MAX_CHART_POINTS contiguous buckets.
   * Which value represents a bucket is chosen per series rather than by taking
   * every Nth point, because a stride silently drops exactly the spikes these
   * charts exist to show:
   *
   *   accuracy  -> the WORST in the bucket (the fix least able to judge a fence)
   *   battery   -> the LOWEST in the bucket (the one that predicts a silence)
   *   fence     -> the COUNT of each state, which is what the axis already says
   *
   * Under the threshold nothing happens and the charts are exactly as before.
   */
  const MAX_CHART_POINTS = 1500;

  function bucketTrack(track, maxPoints) {
    const size = Math.max(1, Math.ceil(track.length / maxPoints));
    if (size === 1) {
      return {
        size: 1,
        labels: track.map((p) => fmt.dayTime(p.at)),
        accuracy: track.map((p) => p.accuracy),
        battery: track.map((p) => p.battery),
        inside: track.map((p) => (p.insideGeofence === true ? 1 : 0)),
        outside: track.map((p) => (p.insideGeofence === false ? 1 : 0)),
        noflag: track.map((p) => (p.insideGeofence === null || p.insideGeofence === undefined ? 1 : 0)),
      };
    }
    const out = { size, labels: [], accuracy: [], battery: [], inside: [], outside: [], noflag: [] };
    for (let start = 0; start < track.length; start += size) {
      const bucket = track.slice(start, start + size);
      const accs = bucket.map((p) => p.accuracy).filter((v) => v !== null && v !== undefined);
      const batts = bucket.map((p) => p.battery).filter((v) => v !== null && v !== undefined);
      out.labels.push(fmt.dayTime(bucket[0].at));
      out.accuracy.push(accs.length ? Math.max(...accs) : null);
      out.battery.push(batts.length ? Math.min(...batts) : null);
      out.inside.push(bucket.filter((p) => p.insideGeofence === true).length);
      out.outside.push(bucket.filter((p) => p.insideGeofence === false).length);
      out.noflag.push(bucket.filter((p) => p.insideGeofence === null || p.insideGeofence === undefined).length);
    }
    return out;
  }

  function renderHistoryTab(host) {
    const track = detail.track || [];
    if (!track.length) {
      host.append(el('div', { class: 'empty', text: 'No heartbeats with coordinates in this time range.' }));
      return;
    }
    const b = bucketTrack(track, MAX_CHART_POINTS);
    const per = b.size === 1 ? 'per heartbeat' : 'per ' + fmt.int(b.size) + ' heartbeats';
    const grouped =
      b.size === 1
        ? ''
        : ' · ' + fmt.int(track.length) + ' heartbeats grouped into ' + fmt.int(b.labels.length) + ' points';

    host.append(
      el('div', { class: 'stack' }, [
        chartBlock('GPS accuracy ' + per, 'metres · lower is better' + (b.size === 1 ? '' : ' · worst in each group') + grouped, 'chart-acc'),
        chartBlock('Battery ' + per, 'per cent' + (b.size === 1 ? '' : ' · lowest in each group') + grouped, 'chart-batt'),
        chartBlock(
          'Geofence state ' + per,
          b.size === 1 ? 'what the device reported in each heartbeat' : 'heartbeats by reported state in each group' + grouped,
          'chart-geo',
          [
            el('div', {
              html: PMChart.legend([
                { color: C.in, label: 'Inside fence' },
                { color: C.out, label: 'Outside fence' },
                { color: C.unknown, label: 'No fence flag' },
              ]),
            }),
          ]
        ),
      ])
    );

    const labels = b.labels;
    PMChart.lineTime(document.querySelector('#chart-acc'), {
      labels,
      yTitle: 'metres',
      series: [{ label: b.size === 1 ? 'GPS accuracy' : 'Worst GPS accuracy', data: b.accuracy, color: C.series[0] }],
    });
    PMChart.lineTime(document.querySelector('#chart-batt'), {
      labels,
      yTitle: 'battery %',
      series: [{ label: b.size === 1 ? 'Battery' : 'Lowest battery', data: b.battery, color: C.series[3] }],
    });
    PMChart.stackedTime(document.querySelector('#chart-geo'), {
      labels,
      yTitle: 'heartbeats',
      datasets: [
        { label: 'Inside', data: b.inside, color: C.in },
        { label: 'Outside', data: b.outside, color: C.out },
        { label: 'No flag', data: b.noflag, color: C.unknown },
      ],
    });
  }

  /**
   * Heartbeats: one row per stored ekosClientState document, straight from
   * /api/snapshots so each row carries the recomputed geofence verdict and the
   * distance to the boundary - not just what the app claimed. Paged, because a
   * busy device writes thousands per day.
   */
  async function renderHeartbeatsTab(host) {
    host.append(
      el('div', { class: 'tab-block' }, [
        tabHeader(
          'Every stored heartbeat for this user, newest first - one document per device ping',
          el('button', {
            class: 'btn btn-sm',
            text: '↓ CSV',
            // The export carries the tab filter too. A CSV that quietly holds
            // more rows than the table it came from is worse than no CSV.
            onclick: () =>
              window.open(
                '/api/snapshots.csv?' + scopedQuery({ userId, limit: 2000, offline: offlineParam() }),
                '_blank'
              ),
          })
        ),
        // The same window the map uses, and the same object behind it - narrowing
        // here narrows there, because they are two views of one question.
        el('div', { class: 'map-toolbar map-window', id: 'hb-window' }),
        // Its own row, under the window. The window is shared with the map;
        // this is not, and putting them in one bar would imply otherwise.
        el('div', { class: 'map-toolbar tab-filters', id: 'hb-filters' }),
        el('div', { class: 'chips', id: 'hb-summary' }),
        el('div', { id: 'hb-table' }, [el('div', { class: 'empty', text: 'loading heartbeats…' })]),
        el('div', { class: 'pager', id: 'hb-pager' }),
      ])
    );
    // The same bar the map carries, and the same window object behind it:
    // narrowing here narrows there, because they are two views of one question.
    PMTrailMap.windowBar(document.querySelector('#hb-window'), windowSpec(), { narrow: false });
    renderHeartbeatFilters(document.querySelector('#hb-filters'));
    await loadHeartbeats();
  }

  /**
   * The tab filter as a query parameter, or nothing at all.
   *
   * Absent rather than `false` when it is off: `offline=false` is a real
   * filter server-side - it means "only heartbeats that were online" - and
   * sending it would drop every offline ping from the default view.
   */
  function offlineParam() {
    return heartbeatOfflineOnly ? 'true' : undefined;
  }

  /**
   * Offline is the pair of flags, not one of them: a device with no network at
   * all and a device on a network it cannot reach the server through are
   * different failures, and the badge on a row is drawn from both. The filter
   * matches that badge (see filters.snapshotMatch), so the rows that come back
   * are exactly the rows that were showing it.
   */
  function renderHeartbeatFilters(host) {
    if (!host) return;
    host.innerHTML = '';
    const box = el('input', { type: 'checkbox', checked: heartbeatOfflineOnly ? 'checked' : null });
    const chip = el(
      'label',
      {
        class: 'chip' + (heartbeatOfflineOnly ? ' is-on' : ''),
        title:
          'Only the heartbeats this device stored while it had no network, or had one it could not reach the ' +
          'server through. The same test as the offline badge on a row.',
      },
      [box, document.createTextNode('Offline only')]
    );
    box.addEventListener('change', () => {
      heartbeatOfflineOnly = box.checked;
      chip.classList.toggle('is-on', box.checked);
      // A different set of rows is a different pagination; page 4 of the whole
      // stream is not page 4 of the offline ones.
      heartbeatPage = 1;
      loadHeartbeats();
    });
    host.append(
      el('span', { class: 'toolbar-field' }, [el('span', { text: 'Show' })]),
      chip,
      el('span', { class: 'hint', text: 'no network, or unable to reach the server' })
    );
  }

  async function loadHeartbeats() {
    PM.showSkeleton({ '#hb-table': 'table:12x8' }, { force: true });
    const table = document.querySelector('#hb-table');
    if (!table) return;
    let data;
    try {
      data = await api(
        '/api/snapshots?' + scopedQuery({ userId, limit: 100, page: heartbeatPage, offline: offlineParam() })
      );
    } catch (err) {
      table.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
      return;
    }
    const rows = data.rows || [];
    tabs.setCount('heartbeats', data.total);

    const summary = document.querySelector('#hb-summary');
    const noFix = rows.filter((r) => !r.location).length;
    const mismatches = rows.filter((r) => r.verdictDisagrees).length;
    const uncertain = rows.filter((r) => r.computedVerdict === 'unknown').length;
    const offline = rows.filter((r) => r.offline).length;
    // With the filter on, every row is offline and "N offline" would be a
    // tautology dressed as a finding - so the chip states the filter instead,
    // and the total says what it is a total OF.
    summary.innerHTML =
      '<span class="chip"><b>' +
      fmt.int(data.total) +
      '</b>&nbsp;' +
      (heartbeatOfflineOnly ? 'offline heartbeats in range' : 'heartbeats in range') +
      '</span>' +
      '<span class="chip"><b>' + noFix + '</b>&nbsp;without coordinates on this page</span>' +
      '<span class="chip"><b>' + uncertain + '</b>&nbsp;uncertain verdict</span>' +
      '<span class="chip"><b>' + mismatches + '</b>&nbsp;app/geometry mismatch</span>' +
      (heartbeatOfflineOnly
        ? '<span class="chip is-on">filtered to offline only</span>'
        : '<span class="chip"><b>' + offline + '</b>&nbsp;offline</span>');

    table.innerHTML = '';
    if (!rows.length) {
      table.append(el('div', { class: 'empty', text: 'No heartbeats in this time range.' }));
      document.querySelector('#hb-pager').innerHTML = '';
      return;
    }

    // Same table, same gap rows and same drawer as the Heartbeats page - this
    // is that page filtered to one person.
    PMHeartbeats.table(table, rows, { gapRows: true, onOpen: openHeartbeat });
    const pager = document.querySelector('#hb-pager');
    pager.innerHTML = '';
    pager.append(
      el('span', { text: 'Showing ' + rows.length + ' of ' + fmt.int(data.total) + ' · page ' + heartbeatPage }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm',
        text: '← Newer',
        disabled: heartbeatPage <= 1 ? 'disabled' : null,
        onclick: () => {
          heartbeatPage -= 1;
          loadHeartbeats();
        },
      }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Older →',
        disabled: heartbeatPage * 100 >= data.total ? 'disabled' : null,
        onclick: () => {
          heartbeatPage += 1;
          loadHeartbeats();
        },
      })
    );
  }

  /** One heartbeat, expanded - the fields that do not fit the table. */
  function openHeartbeat(row) {
    // The row may not carry the person (this page already knows them), so fill
    // the name in for the drawer subtitle.
    PMHeartbeats.drawer({ ...row, name: row.name || (detail.current && detail.current.name) || null });
  }
  /**
   * What the window bar needs to draw itself, wherever it is drawn.
   *
   * `meta.from`/`to` are the span the trail actually covers, so the bar's
   * presets are anchored on the newest heartbeat that loaded rather than on the
   * wall clock - a truncated trail is at the END of the range, and "the last
   * hour" has to mean the last hour of the data to be any use.
   */
  function windowSpec() {
    return {
      meta: { from: detail.trackFrom, to: detail.trackTo, truncated: detail.trackTruncated },
      window: mapWindow,
      onWindow: setMapWindow,
    };
  }

  /**
   * One person's trail, in the shared panel.
   *
   * Everything below the title is PMTrailMap's: the toolbar, the window, the
   * map, the replay and the note. This decides only what the panel is being
   * shown, and answers the two questions it cannot answer for itself - is a
   * path between these points honest, and is a replay.
   */
  function renderLocationTab(host) {
    PMTrailMap.render(host, {
      title: 'Location & trail',
      points: detail.track || [],
      clockIns: detail.logs || [],
      sites: detail.sites || [],
      current: detail.current,
      meta: {
        inRange: (detail.stats || {}).snapshots,
        fetched: detail.trackFetched,
        noFix: detail.trackNoFix,
        truncated: detail.trackTruncated,
        limit: detail.trackLimit,
        ceiling: detail.trackCeiling,
        from: detail.trackFrom,
        to: detail.trackTo,
        travelledMetres: (detail.stats || {}).travelledMetres,
      },
      window: mapWindow,
      onWindow: setMapWindow,
      onReload: load,
      // One person, one device stream. The path and the replay are always
      // honest here, which is the case this panel was written for.
      path: true,
      replay: true,
    });
  }

  /** Leaflet needs a nudge whenever its container was hidden while sizing. */
  function resizeMap() {
    PMTrailMap.resize();
  }

  function tabHeader(text, action) {
    return el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap' }, [
      el('span', { class: 'hint', text }),
      el('div', { style: 'flex:1' }),
      action || null,
    ]);
  }

  function renderCallsTab(host) {
    const logs = detail.logs || [];
    const block = el('div', { class: 'tab-block' });
    host.append(block);
    block.append(
      tabHeader(
        logs.length + ' most recent validation calls for this user',
        el('a', {
          class: 'btn btn-sm',
          href: PM.withWindow('/checks.html?userId=' + encodeURIComponent(userId)),
          target: '_blank',
          rel: 'noopener',
          text: 'Open in Geofence Checks ↗',
        })
      )
    );
    if (!logs.length) {
      block.append(el('div', { class: 'empty', text: 'No geofence validation calls recorded for this user.' }));
      return;
    }

    const failed = logs.filter((l) => l.actualIsWithinRadius === false).length;
    const grace = logs.filter((l) => l.graceApplied).length;
    const uncertain = logs.filter((l) => l.verdict === 'unknown').length;
    const clockOuts = logs.filter((l) => l.triggeredClockOut).length;
    block.append(
      el('div', { class: 'chips' }, [
        el('span', { class: 'chip', html: '<b>' + logs.length + '</b>&nbsp;calls' }),
        el('span', { class: 'chip', html: '<b>' + failed + '</b>&nbsp;failed the raw geometry' }),
        el('span', { class: 'chip', html: '<b>' + grace + '</b>&nbsp;passed only on accuracy padding' }),
        el('span', { class: 'chip', html: '<b>' + uncertain + '</b>&nbsp;uncertain' }),
        el('span', { class: 'chip', html: '<b>' + clockOuts + '</b>&nbsp;auto clock-outs' }),
      ])
    );

    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>When</th><th>Site</th><th class="num">Accuracy</th><th class="num">From boundary</th>' +
      '<th>Reported</th><th>Geometry</th><th>Recomputed</th><th>Outcome</th></tr></thead>';
    const body = el('tbody');
    for (const log of logs) {
      body.append(
        el('tr', {
          html:
            '<td>' + fmt.dayTime(log.capturedAt) + '<div class="person-sub">' + fmt.ago(log.capturedAt) + '</div></td>' +
            '<td>' +
            (log.siteId != null || log.siteName
              ? esc(PM.siteName({ name: log.siteName, address: log.siteAddress }, log.siteId))
              : '<span class="badge badge-neutral">unmapped</span>') +
            '<div class="person-sub" title="' + esc(log.siteAddress || '') + '">' + esc(log.siteAddress || '') + '</div></td>' +
            '<td class="num">' + PM.accuracyBadge(log.accuracyBand, log.accuracy) + '</td>' +
            '<td class="num">' +
            (log.relation ? (log.relation.inside ? '−' : '+') + fmt.metres(Math.abs(log.relation.distanceFromBoundary)) : '--') +
            '</td>' +
            '<td>' +
            (log.isWithinRadius ? '<span class="badge badge-good">within</span>' : '<span class="badge badge-critical">outside</span>') +
            '</td>' +
            '<td>' +
            (log.actualIsWithinRadius
              ? '<span class="badge badge-good">within</span>'
              : '<span class="badge badge-critical">outside</span>') +
            (log.graceApplied ? '<div class="person-sub">grace +' + fmt.metres(log.radiusPadding) + '</div>' : '') +
            '</td>' +
            '<td>' + PM.geofenceBadge(null, log.verdict, log.verdictReason) + '</td>' +
            '<td>' +
            (log.triggeredClockOut
              ? '<span class="badge badge-serious">auto clock-out</span>'
              : log.outsideCount
                ? '<span class="badge badge-warning">streak ' + log.outsideCount + '</span>'
                : '<span class="badge badge-neutral">no action</span>') +
            '</td>',
        })
      );
    }
    table.append(body);
    block.append(el('div', { class: 'table-block' }, [el('div', { class: 'table-scroll' }, [table])]));
  }

  /**
   * The same table and the same drawer as the Exit Windows page - this tab is
   * that page, filtered to one person, so it renders through the shared view
   * instead of a thinner copy that could not be opened.
   */
  function renderExitWindowsTab(host) {
    const windows = detail.exitWindows || [];
    const anon = ((PM.state.meta || {}).exitWindows || {}).anonymousWindows || 0;
    // This tab runs the Exit Windows query with the filter bar applied, so it
    // has to say so: a tab that silently ignored the bar and one that honours it
    // look identical until you notice the count disagreeing with the other page.
    const scope = PM.rangeLabel();

    host.append(
      tabHeader(
        windows.length +
          ' exit window(s) matched to this user in ' +
          scope +
          ' · every filter on the bar applies here · click one to replay its samples',
        el('a', { class: 'btn btn-sm', href: PM.withWindow('/exit-windows.html'), text: 'All exit windows' })
      )
    );

    // More windows matched the filters than could be attributed in one pass, so
    // this person may own one that was never looked at. Say it rather than let
    // a short list pass for a complete one.
    if (detail.exitWindowsTruncated) {
      host.append(
        el('div', {
          class: 'notice',
          style: 'margin-bottom:12px',
          html:
            '<span>⚠</span><span>More than 500 exit windows match these filters. Only the 500 most recent were ' +
            'checked against this user, so this list may be incomplete - narrow the time range to be sure.</span>',
        })
      );
    }

    const empty = el('div', { class: 'empty' }, [
      el('div', { text: 'No exit windows matched this user in ' + scope + '.' }),
      el('div', { class: 'hint', style: 'margin-top:8px;max-width:600px;margin-left:auto;margin-right:auto' }, [
        document.createTextNode(
          anon
            ? 'The ' +
              anon +
              ' exit windows in this database carry userId: null, so they are matched to people by comparing each ' +
              'window’s GPS samples against the heartbeat stream. None of them matched this user here. Widen the ' +
              'time range, or clear the other filters, before concluding there are none. '
            : 'Widen the time range, or clear the other filters, before concluding there are none. '
        ),
        el('a', { href: PM.withWindow('/exit-windows.html'), text: 'See all windows' }),
      ]),
    ]);

    const body = el('div');
    host.append(body);
    PMExitWindows.table(body, windows, { empty });
  }
  /**
   * The load failed. A user who simply has not reported inside the selected
   * range is not an error, so that case says so and offers the wider ranges
   * rather than leaving a dead end.
   */
  function renderLoadFailure(err) {
    const info = (err && err.payload) || {};
    const host = document.querySelector('#hero');
    host.innerHTML = '';
    const box = el('div', { class: 'empty', style: 'width:100%' });
    if (info.outOfRange) {
      box.append(
        el('div', { text: 'No heartbeats from this user in the selected range.' }),
        el('div', {
          class: 'hint',
          style: 'margin-top:6px',
          text: info.lastSeenAt ? 'Last seen ' + fmt.date(info.lastSeenAt) + ' (' + fmt.ago(info.lastSeenAt) + ').' : '',
        }),
        el('div', { style: 'margin-top:12px;display:flex;gap:8px;justify-content:center' }, [
          el('button', { class: 'btn btn-sm', text: 'Last 24 hours', onclick: () => PM.setFilter('range', '24h') }),
          el('button', { class: 'btn btn-sm', text: 'Last 7 days', onclick: () => PM.setFilter('range', '7d') }),
          el('button', { class: 'btn btn-sm', text: 'All time', onclick: () => PM.setFilter('range', 'all') }),
        ])
      );
      PM.setSubtitle('quiet in this range');
    } else {
      box.append(el('div', { text: err.message }));
      PM.setSubtitle('could not load this user');
    }
    host.append(box);
  }

  /**
   * Shift trails: one sealed document per shift, the same table and the same
   * drawer as the Shift Trails page - this tab is that page, filtered to one
   * person, so it renders through PMShiftTrails rather than a thinner copy
   * that could not be opened.
   *
   * It fetches its own rows instead of reading `detail`, because a trail is
   * not a heartbeat: the user payload is built from ekosClientState snapshots
   * and carries none of these. Paged for the same reason the Heartbeats tab
   * is - a year of shifts is a lot of rows - though the page size is smaller
   * because each row here is a whole shift.
   */
  async function renderShiftTrailsTab(host) {
    host.append(
      el('div', { class: 'tab-block' }, [
        tabHeader(
          'Every shift this person’s app sealed and pushed, newest first · the date range on the bar applies here · ' +
            'click a shift to walk its path',
          el('a', {
            class: 'btn btn-sm',
            href: PM.withWindow('/shift-trails.html'),
            text: 'All shift trails',
          })
        ),
        el('div', { class: 'table-scroll', id: 'st-tab-table' }, [
          el('div', { class: 'empty', text: 'loading shift trails…' }),
        ]),
        el('div', { class: 'pager', id: 'st-tab-pager' }),
      ])
    );
    await loadShiftTrails();
  }

  /**
   * A trail is matched to a person by `userId`, which the store holds as a
   * number. This page's identity is whatever came in on the query string, and
   * it is not always one - `anonymous` is a real value here, and so is a
   * device that has never carried a session.
   *
   * That matters more than it looks: the server drops a non-numeric `userId`
   * rather than failing on it, so asking for one would quietly return EVERY
   * shift in the database under this person's name. So the tab refuses to ask
   * the question it cannot ask, and says why.
   */
  function trailUserId() {
    // Digits only. Number() alone accepts "0x10", "1e2" and "1.5", and would
    // turn a malformed link into some other person's shifts.
    const raw = String(userId).trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  }

  /**
   * The tab badge, at page load rather than when the tab is first opened.
   *
   * `limit=1` because only `total` is wanted, and the list endpoint computes it
   * with a countDocuments over the same match the tab itself runs - so this is
   * the number the tab will show, not an estimate of it.
   *
   * Every load() starts one of these, and a slow answer to an old range must
   * not land on top of a newer one, so only the latest request may write.
   */
  let shiftTrailCountSeq = 0;
  async function loadShiftTrailCount() {
    const seq = ++shiftTrailCountSeq;
    const id = trailUserId();
    if (id === null) return; // no numeric id: no shift can be matched, so no count
    try {
      const data = await api('/api/shift-trails?' + scopedQuery({ userId: id, limit: 1, page: 1 }));
      if (seq !== shiftTrailCountSeq || data.unavailable) return;
      tabs.setCount('shift-trails', data.total || 0);
    } catch (err) {
      // A badge is not worth an error on the page; the tab reports it if opened.
    }
  }

  // Pager clicks and range changes can overlap, and the answers can come back
  // out of order. Only the latest request may write - otherwise a slow page 2
  // lands on top of page 3, or an old range's total on the tab badge.
  let shiftTrailTabSeq = 0;
  async function loadShiftTrails() {
    const seq = ++shiftTrailTabSeq;
    const table = document.querySelector('#st-tab-table');
    const pager = document.querySelector('#st-tab-pager');
    if (!table) return;

    const id = trailUserId();
    if (id === null) {
      table.innerHTML = '';
      table.append(
        el('div', { class: 'empty' }, [
          el('div', { text: 'This device has no user id, so no shift can be matched to it.' }),
          el('div', {
            class: 'hint',
            style: 'margin-top:8px',
            text:
              'Shift trails are keyed to a numeric user id. A device reporting without a session cannot be ' +
              'matched to one, and showing every shift here would be worse than showing none.',
          }),
        ])
      );
      pager.innerHTML = '';
      tabs.setCount('shift-trails', null);
      return;
    }

    PM.showSkeleton({ '#st-tab-table': 'table:8x13' }, { force: true });
    let data;
    try {
      // page is overridden explicitly: the number on the filter bar belongs to
      // whatever page set it, not to this tab's pagination.
      data = await api('/api/shift-trails?' + scopedQuery({ userId: id, limit: 25, page: shiftTrailPage }));
    } catch (err) {
      if (seq !== shiftTrailTabSeq) return;
      table.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
      pager.innerHTML = '';
      return;
    }

    if (seq !== shiftTrailTabSeq) return;

    // No trails have ever been written to this database. That is a property of
    // the store, not of this person, so it says so rather than reading as
    // "this person sealed no shifts".
    if (data.unavailable) {
      table.innerHTML = '';
      table.append(
        el('div', { class: 'empty' }, [
          el('div', { text: 'No shift trails exist in this database yet.' }),
          el('div', { class: 'hint', style: 'margin-top:8px', text: data.unavailable }),
        ])
      );
      pager.innerHTML = '';
      tabs.setCount('shift-trails', null);
      return;
    }

    const rows = data.rows || [];
    const total = data.total || 0;
    tabs.setCount('shift-trails', total);

    PMShiftTrails.table(table, rows, {
      empty: el('div', { class: 'empty' }, [
        el('div', { text: 'No shifts sealed for this person in ' + PM.rangeLabel() + '.' }),
        el('div', {
          class: 'hint',
          style: 'margin-top:8px',
          text:
            'A trail is written at clock-out and pushed when the network allows, so a shift still running - or ' +
            'one sealed on a phone that has not been online since - will not be here yet.',
        }),
      ]),
    });

    pager.innerHTML = '';
    if (!rows.length) return;
    const limit = Number(data.limit || 25);
    pager.append(
      el('span', { text: 'Showing ' + rows.length + ' of ' + fmt.int(total) + ' · page ' + shiftTrailPage }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm',
        text: '← Newer',
        disabled: shiftTrailPage <= 1 ? 'disabled' : null,
        onclick: () => {
          shiftTrailPage -= 1;
          loadShiftTrails();
        },
      }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Older →',
        disabled: shiftTrailPage * limit >= total ? 'disabled' : null,
        onclick: () => {
          shiftTrailPage += 1;
          loadShiftTrails();
        },
      })
    );
  }

  function renderRawTab(host) {
    host.append(
      tabHeader(
        'Newest snapshot for this user, exactly as stored in MongoDB',
        el('button', { class: 'btn btn-sm', text: '⧉ Copy JSON', onclick: copyJson })
      ),
      el('pre', { class: 'json', style: 'max-height:600px', html: PM.jsonHighlight(detail.raw) })
    );
  }

  function copyJson() {
    if (!detail) return;
    navigator.clipboard
      .writeText(JSON.stringify(detail.raw, null, 2))
      .then(() => PM.toast('Raw document copied', 'ok'))
      .catch(() => PM.toast('Could not copy', 'error'));
  }
})();
