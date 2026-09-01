/* Overview: the at-a-glance operations picture. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let liveMap = null;
  let mapLayers = [];

  PM.boot('index.html', async ({ root, meta }) => {
    PM.buildFilterBar([
      { kind: 'daterange' },
      {
        kind: 'multi',
        key: 'tenantId',
        label: 'Tenant',
        options: PM.optionsFrom(meta.tenants || [], 'id', 'name', 'snapshots'),
      },
      { kind: 'multi', key: 'userId', label: 'User', options: PM.optionsFrom(meta.users || [], 'id', 'name', 'snapshots') },
      {
        kind: 'multi',
        key: 'deviceType',
        label: 'Device',
        options: PM.optionsFrom(meta.deviceTypes || [], 'key', 'key', 'count'),
      },
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: PM.optionsFrom(meta.jobSiteIds || [], 'id', 'id', 'snapshots') },
      {
        kind: 'multi',
        key: 'accuracyBand',
        label: 'GPS accuracy',
        options: PM.optionsFrom(meta.accuracyBands || [], 'key', 'label'),
      },
      { kind: 'tri', key: 'clockedIn', label: 'Clocked in', yes: 'On the clock', no: 'Off the clock' },
      { kind: 'tri', key: 'insideGeofence', label: 'Inside fence', yes: 'Inside', no: 'Outside', nullable: true },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'name, email, employee ref' },
    ]);

    root.append(
      el('div', { class: 'tiles', id: 'tiles' }),
      el('div', { id: 'notices' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Where everyone is right now' }),
          el('span', { class: 'sub', id: 'map-sub' }),
          el('div', { class: 'spacer' }),
          el('a', { class: 'btn btn-sm', href: '/map.html', text: 'Full map ↗' }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'map', id: 'overview-map' })]),
        el('div', { html: PMMap.legend() }),
      ]),
      el('div', { class: 'grid-2' }, [
        card('Geofence state over time', 'Snapshot counts per bucket, stacked', 'chart-geo', 'tall', [
          el('div', {
            html: PMChart.legend([
              { color: C.in, label: 'Inside fence' },
              { color: C.out, label: 'Outside fence' },
              { color: C.unknown, label: 'No fence flag' },
            ]),
          }),
        ]),
        card('GPS accuracy over time', 'Average and worst fix per bucket, metres', 'chart-acc', 'tall', [
          el('div', {
            html: PMChart.legend([
              { color: C.series[0], label: 'Average accuracy' },
              { color: C.series[3], label: 'Worst accuracy' },
            ]),
          }),
        ]),
      ]),
      el('div', { class: 'grid-2' }, [
        card('Accuracy distribution', 'How trustworthy the location data is', 'chart-hist'),
        card('Devices per platform', 'Snapshots by platform', 'chart-device'),
      ]),
      el('div', { class: 'grid-2' }, [
        card('Site activity', 'Snapshots per site, inside vs outside the fence', 'chart-sites', 'tall', [
          el('div', {
            html: PMChart.legend([
              { color: C.in, label: 'Inside fence' },
              { color: C.out, label: 'Outside fence' },
            ]),
          }),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { text: 'Per-user activity' }),
            el('div', { class: 'spacer' }),
            el('a', { class: 'btn btn-sm', href: '/users.html', text: 'All users ↗' }),
          ]),
          el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'user-table' })]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Geofence validation calls' }),
          el('span', { class: 'sub', text: 'What the clock-in checks decided, from validateClockInLogs' }),
          el('div', { class: 'spacer' }),
          el('a', { class: 'btn btn-sm', href: '/checks.html', text: 'Inspect checks ↗' }),
        ]),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'tiles', id: 'check-tiles' }),
          el('div', { style: 'margin-top:14px' }, [
            el('div', { class: 'chart-wrap', id: 'chart-checks-wrap' }, [el('canvas', { id: 'chart-checks' })]),
            el('div', {
              html: PMChart.legend([
                { color: C.in, label: 'Passed (within radius)' },
                { color: C.out, label: 'Failed geometry' },
                { color: C.series[3], label: 'Auto clock-outs' },
              ]),
            }),
          ]),
        ]),
      ])
    );

    liveMap = PMMap.create(document.querySelector('#overview-map'));
    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  function card(title, subtitle, canvasId, size, extra) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: title }), subtitle ? el('span', { class: 'sub', text: subtitle }) : null]),
      el('div', { class: 'card-body' }, [
        el('div', { class: 'chart-wrap ' + (size || '') }, [el('canvas', { id: canvasId })]),
        ...(extra || []),
      ]),
    ]);
  }

  async function load() {
    PM.showSkeleton({
      '#tiles': 'tiles:8',
      '#overview-map': 'map',
      '#chart-geo': 'chart',
      '#chart-acc': 'chart',
      '#chart-hist': 'chart',
      '#chart-device': 'chart',
      '#chart-sites': 'chart',
      '#chart-checks': 'chart',
      '#user-table': 'table:8x7',
      '#check-tiles': 'tiles:5',
    });
    const qs = queryString();
    const [stats, users] = await Promise.all([api('/api/stats?' + qs), api('/api/users?' + qs + '&limit=200')]);
    renderTiles(stats);
    renderNotices(stats, users);
    renderMap(users.rows);
    renderCharts(stats);
    renderUserTable(stats.perUser || []);
    renderChecks(stats);
    PM.setSubtitle(
      fmt.int((stats.devices || {}).totalSnapshots) +
        ' snapshots · ' +
        fmt.int((stats.devices || {}).trackedUsers) +
        ' users in range · buckets by ' +
        stats.granularity
    );
    PM.markLoaded();
  }

  function tile(label, value, opts) {
    const options = opts || {};
    const node = el('div', { class: 'tile ' + (options.tone ? 'is-' + options.tone : '') + (options.href ? ' clickable' : '') }, [
      el('div', { class: 'tile-label', text: label }),
      el('div', { class: 'tile-value', html: value === null || value === undefined ? '--' : String(value) }),
      options.note ? el('div', { class: 'tile-note', text: options.note }) : null,
    ]);
    if (options.href) node.addEventListener('click', () => (location.href = options.href));
    return node;
  }

  function renderTiles(stats) {
    const d = stats.devices || {};
    const host = document.querySelector('#tiles');
    host.innerHTML = '';
    host.append(
      tile('Devices reporting', fmt.int(d.trackedUsers), {
        note: d.stale ? d.stale + ' stale (>15 min quiet)' : 'all reporting recently',
        tone: d.stale ? 'warning' : undefined,
        href: '/users.html',
      }),
      tile('On the clock', fmt.int(d.clockedIn), { note: d.clockedOut + ' clocked out', href: '/users.html?clockedIn=true' }),
      tile('Inside a fence', fmt.int(d.insideGeofence), {
        tone: 'good',
        note: d.geofenceUnknown ? d.geofenceUnknown + ' with no fence flag' : 'device-reported',
        href: '/users.html?insideGeofence=true',
      }),
      tile('Outside a fence', fmt.int(d.outsideGeofence), {
        tone: d.outsideGeofence ? 'critical' : undefined,
        note: d.outsideButClockedIn ? d.outsideButClockedIn + ' of them still clocked in' : 'none clocked in outside',
        href: '/users.html?insideGeofence=false',
      }),
      tile('Median accuracy', fmt.accuracy(d.medianAccuracy), {
        note: 'avg ' + fmt.accuracy(d.avgAccuracy) + ' · worst ' + fmt.accuracy(d.worstAccuracy),
        tone: d.medianAccuracy > 50 ? 'warning' : undefined,
      }),
      tile('Poor fixes', fmt.int(d.poorAccuracy), {
        note: 'devices over ±50 m right now',
        tone: d.poorAccuracy ? 'serious' : undefined,
        href: '/users.html?accuracyMin=50',
      }),
      tile('Low battery', fmt.int(d.lowBattery), {
        note: 'at or under 20%',
        tone: d.lowBattery ? 'warning' : undefined,
        href: '/users.html?batteryMax=20',
      }),
      tile('Offline devices', fmt.int(d.offline), {
        note: 'no connectivity on last ping',
        tone: d.offline ? 'critical' : undefined,
        href: '/users.html?connected=false',
      }),
      tile('Permission gaps', fmt.int(d.permissionGaps), {
        note: d.locationBackgroundMissing + ' missing background location',
        tone: d.locationBackgroundMissing ? 'critical' : d.permissionGaps ? 'warning' : undefined,
        href: '/users.html?permissionMissing=LOCATION_BACKGROUND',
      }),
      tile('Face checks pending', fmt.int(d.facialPending), { note: 'required but not completed' })
    );
  }

  /** Only surface a notice when something actually needs a human. */
  function renderNotices(stats, users) {
    const host = document.querySelector('#notices');
    host.innerHTML = '';
    const notes = [];
    const d = stats.devices || {};

    const disagreements = (users.rows || []).filter((r) => r.verdictDisagrees);
    if (disagreements.length) {
      notes.push(
        '<b>' +
          disagreements.length +
          ' device' +
          (disagreements.length > 1 ? 's' : '') +
          ' disagree with the geometry.</b> The app reported one geofence state while the stored coordinates and radius say the other: ' +
          disagreements
            .slice(0, 4)
            .map((r) => esc(r.name || 'user ' + r.userId) + ' (app: ' + (r.isInsideGeofence ? 'inside' : 'outside') + ', computed: ' + r.computedVerdict + ')')
            .join('; ') +
          '.'
      );
    }
    if (d.outsideButClockedIn) {
      notes.push('<b>' + d.outsideButClockedIn + ' clocked-in device(s) are outside their fence.</b> Check the exit windows and the geofence calls.');
    }
    if (stats.geofenceChecks && stats.geofenceChecks.grace) {
      notes.push(
        '<b>' +
          stats.geofenceChecks.grace +
          ' clock-in check(s) passed only because of the accuracy grace.</b> Raw geometry put the device outside, and the accuracy padding pulled it back in.'
      );
    }
    if (!stats.exitWindows || !stats.exitWindows.available) {
      notes.push(
        '<b>No exit-window documents in this database yet.</b> The Exit Windows page is wired up and will populate as soon as documents of <code>type: "exit_window"</code> land - no config change needed.'
      );
    }
    for (const text of notes) host.append(el('div', { class: 'notice', html: '<span>⚠</span><span>' + text + '</span>' }));
  }

  function renderMap(rows) {
    PMMap.clear(mapLayers);
    mapLayers = [];
    const plotted = (rows || []).filter((r) => r.location);
    const seenSites = new Map();
    for (const row of plotted) {
      if (row.site && row.site.lat != null && !seenSites.has(row.site.siteId)) seenSites.set(row.site.siteId, row.site);
    }
    for (const site of seenSites.values()) mapLayers.push(PMMap.siteCircle(liveMap, site));
    for (const row of plotted) {
      mapLayers.push(PMMap.deviceMarker(liveMap, row, { pulse: row.ageMinutes !== null && row.ageMinutes < 5, onClick: openUser }));
      if (row.guide && row.fence) {
        mapLayers.push(
          PMMap.guideLine(liveMap, row.location, row.fence, {
            text: fmt.metres(row.guide.distanceMetres) + ' ' + (row.guide.compass || '') + ' of the fence',
          })
        );
      }
    }
    PMMap.fit(
      liveMap,
      plotted.map((r) => r.location)
    );
    document.querySelector('#map-sub').textContent =
      plotted.length + ' of ' + (rows || []).length + ' devices have a fix · ' + seenSites.size + ' fence(s) drawn';
  }

  function openUser(row) {
    location.href = '/users.html?search=' + encodeURIComponent(row.name || row.userId || '');
  }

  function renderCharts(stats) {
    const timeline = PM.padBuckets(stats.timeline || [], stats.granularity, {
      zero: ['count', 'inside', 'outside', 'unknown', 'clockedIn', 'offline', 'users'],
      nulls: ['avgAccuracy', 'worstAccuracy'],
    });
    const labels = timeline.map((t) => fmt.dayTime(t.at));

    PMChart.stackedTime(document.querySelector('#chart-geo'), {
      labels,
      yTitle: 'snapshots',
      datasets: [
        { label: 'Inside fence', data: timeline.map((t) => t.inside), color: C.in },
        { label: 'Outside fence', data: timeline.map((t) => t.outside), color: C.out },
        { label: 'No fence flag', data: timeline.map((t) => t.unknown), color: C.unknown },
      ],
    });

    PMChart.lineTime(document.querySelector('#chart-acc'), {
      labels,
      yTitle: 'metres',
      series: [
        { label: 'Average accuracy', data: timeline.map((t) => t.avgAccuracy), color: C.series[0] },
        { label: 'Worst accuracy', data: timeline.map((t) => t.worstAccuracy), color: C.series[3], dashed: true },
      ],
    });

    const hist = stats.accuracyHistogram || [];
    const bounds = [0, 5, 10, 20, 30, 50, 75, 100, 200, 500];
    PMChart.bars(document.querySelector('#chart-hist'), {
      labels: hist.map((b) => {
        if (b.from === 'none') return 'no fix';
        const index = bounds.indexOf(b.from);
        const next = bounds[index + 1];
        return next ? b.from + '-' + next + ' m' : b.from + '+ m';
      }),
      values: hist.map((b) => b.count),
      color: C.in,
      yTitle: 'snapshots',
      unit: 'snapshots',
    });

    const devices = Object.entries(stats.deviceSplit || {});
    PMChart.bars(document.querySelector('#chart-device'), {
      labels: devices.map(([k]) => k),
      values: devices.map(([, v]) => v),
      color: C.series[1],
      horizontal: true,
      unit: 'snapshots',
    });

    const sites = (stats.topSites || []).filter((s) => s.siteId !== null);
    PMChart.groupedBars(document.querySelector('#chart-sites'), {
      labels: sites.map((s) => 'Site ' + s.siteId),
      horizontal: true,
      datasets: [
        { label: 'Inside fence', data: sites.map((s) => s.inside), color: C.in },
        { label: 'Outside fence', data: sites.map((s) => s.outside), color: C.out },
      ],
    });
  }

  function renderUserTable(perUser) {
    const host = document.querySelector('#user-table');
    host.innerHTML = '';
    if (!perUser.length) {
      host.append(el('div', { class: 'empty', text: 'No snapshots in this range.' }));
      return;
    }
    const maxSnapshots = Math.max(...perUser.map((u) => u.snapshots));
    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>User</th><th class="num">Snapshots</th><th>Inside / outside</th><th class="num">Avg accuracy</th><th class="num">Worst</th><th class="num">Min battery</th><th>Last seen</th></tr></thead>';
    const body = el('tbody');
    for (const u of perUser) {
      const total = u.inside + u.outside || 1;
      body.append(
        el('tr', {
          class: 'clickable',
          title: 'Open this user',
          onclick: (event) =>
            PM.openRow('/user.html?userId=' + (u.userId === null ? 'anonymous' : u.userId), event),
          html:
            '<td><div class="person"><div class="avatar">' +
            esc(fmt.initials(u.name)) +
            '</div><div class="person-main"><div class="person-name">' +
            esc(u.name) +
            '</div><div class="person-sub">' +
            (u.userId === null ? 'no session' : 'id ' + u.userId) +
            (u.offline ? ' · ' + u.offline + ' offline pings' : '') +
            '</div></div></div></td>' +
            '<td class="num">' +
            fmt.int(u.snapshots) +
            ' ' +
            PM.meter(u.snapshots, maxSnapshots, C.series[6]) +
            '</td>' +
            '<td><span style="font-variant-numeric:tabular-nums">' +
            fmt.int(u.inside) +
            ' / ' +
            fmt.int(u.outside) +
            '</span> ' +
            PM.meter(u.inside, total, C.in) +
            '</td>' +
            '<td class="num">' +
            fmt.accuracy(u.avgAccuracy) +
            '</td><td class="num">' +
            fmt.accuracy(u.worstAccuracy) +
            '</td><td class="num">' +
            (u.minBattery === null ? '--' : u.minBattery + '%') +
            '</td><td>' +
            fmt.ago(u.lastSeenAt) +
            '</td>',
        })
      );
    }
    table.append(body);
    host.append(table);
  }

  function renderChecks(stats) {
    const g = stats.geofenceChecks;
    const host = document.querySelector('#check-tiles');
    host.innerHTML = '';
    if (!g) {
      host.append(el('div', { class: 'empty', text: stats.geofenceChecksUnavailable || 'No geofence checks available.' }));
      return;
    }
    host.append(
      tile('Checks made', fmt.int(g.total), { note: g.users + ' user(s) across ' + g.sites + ' site(s)' }),
      tile('Compliance', fmt.pct(g.complianceRate), {
        tone: g.complianceRate !== null && g.complianceRate < 95 ? 'warning' : 'good',
        note: fmt.int(g.actualOutside) + ' failed the raw geometry',
      }),
      tile('Saved by accuracy grace', fmt.int(g.grace), {
        tone: g.grace ? 'warning' : undefined,
        note: 'avg padding ' + fmt.metres(g.avgRadiusPadding),
      }),
      tile('Auto clock-outs', fmt.int(g.clockOuts), { tone: g.clockOuts ? 'serious' : undefined, note: 'triggered by leaving a fence' }),
      tile('Unmapped clock-ins', fmt.int(g.unmapped), { note: 'no site geofence attached' }),
      tile('Check accuracy', fmt.accuracy(g.avgAccuracy), { note: 'best ' + fmt.accuracy(g.bestAccuracy) + ' · worst ' + fmt.accuracy(g.worstAccuracy) })
    );

    const timeline = PM.padBuckets(stats.geofenceTimeline || [], stats.granularity, {
      zero: ['total', 'within', 'outside', 'clockOuts'],
      nulls: ['avgAccuracy'],
    });
    PMChart.stackedTime(document.querySelector('#chart-checks'), {
      labels: timeline.map((t) => fmt.dayTime(t.at)),
      yTitle: 'checks',
      datasets: [
        { label: 'Passed', data: timeline.map((t) => t.within), color: C.in },
        { label: 'Failed geometry', data: timeline.map((t) => t.outside), color: C.out },
        { label: 'Auto clock-outs', data: timeline.map((t) => t.clockOuts), color: C.series[3] },
      ],
    });
  }
})();
