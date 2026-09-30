/*
 * Trends: how the fleet's location data has looked over the selected range.
 * Split out of the Overview - context worth having, not something that needs
 * acting on, so it no longer sits between the reader and the problems.
 */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const { panelFailed } = PMPanel;
  const C = PM.colors;

  PM.boot('trends.html', async ({ root, meta }) => {
    PM.buildFilterBar(() => [
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
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: PM.optionsFrom(meta.jobSiteIds || [], 'id', 'label', 'snapshots') },
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
            el('span', { class: 'sub', text: 'totals across the selected range, not the current state' }),
            el('div', { class: 'spacer' }),
            el('a', { class: 'btn btn-sm', href: PM.withWindow('/users.html'), text: 'All users ↗' }),
          ]),
          el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'user-table' })]),
        ]),
      ])
    );

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

  /**
   * Bumped by every load, so a response that returns after a newer load has
   * started - a filter changed while it was out - is dropped instead of
   * overwriting the newer answer.
   */
  let loadSeq = 0;

  async function load() {
    const seq = ++loadSeq;
    PM.showSkeleton({
      '#chart-geo': 'chart',
      '#chart-acc': 'chart',
      '#chart-hist': 'chart',
      '#chart-device': 'chart',
      '#chart-sites': 'chart',
      '#user-table': 'table:8x7',
    });
    let stats = null;
    try {
      stats = await api('/api/stats?' + queryString());
    } catch (err) {
      stats = null;
    }
    if (seq !== loadSeq) return;
    if (!stats) {
      panelFailed('#chart-geo', '#chart-acc', '#chart-hist', '#chart-device', '#chart-sites', '#user-table');
      PM.markStale('Could not load the statistics for this page.');
      return;
    }
    renderCharts(stats);
    renderUserTable(stats.perUser || []);
    const d = stats.devices || {};
    PM.setSubtitle(fmt.int(d.totalSnapshots) + ' snapshots · ' + fmt.int(d.trackedUsers) + ' users in range');
    PM.markLoaded();
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
      // Places, not numbers. A bar chart of "Site 12, Site 28, Site 63" is a
      // chart nobody can read without a second window open.
      labels: sites.map((s) => PM.siteName(s, s.siteId)),
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
})();
