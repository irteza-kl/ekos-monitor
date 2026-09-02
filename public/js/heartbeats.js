/* Heartbeats: every stored device ping, for every user, newest first.

   The other pages summarise - one row per person, one dot per fix. This one is
   the raw stream, because a lot of questions ("what did that phone report at
   14:03", "when did it go quiet", "who is reporting 300 m accuracy") are only
   answerable against individual documents.

   Silences are first-class here: a device that stops reporting looks exactly
   like a quiet one unless the gap is drawn (see js/heartbeats.view.js). */
(function () {
  'use strict';
  const { el, fmt, api, queryString } = PM;
  const C = PM.colors;

  let rows = [];
  let total = 0;
  let lastGaps = [];

  PM.boot('heartbeats.html', async ({ root, meta }) => {
    PM.buildFilterBar(() => [
      { kind: 'daterange' },
      { kind: 'multi', key: 'tenantId', label: 'Tenant', options: PM.optionsFrom(meta.tenants || [], 'id', 'name', 'snapshots') },
      { kind: 'multi', key: 'userId', label: 'User', options: PM.optionsFrom(meta.users || [], 'id', 'name', 'snapshots') },
      { kind: 'multi', key: 'deviceType', label: 'Device', options: PM.optionsFrom(meta.deviceTypes || [], 'key', 'key', 'count') },
      { kind: 'multi', key: 'appVersion', label: 'App version', options: PM.optionsFrom(meta.appVersions || [], 'key', 'key', 'count') },
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: PM.optionsFrom(meta.jobSiteIds || [], 'id', 'id', 'snapshots') },
      { kind: 'multi', key: 'accuracyBand', label: 'Accuracy band', options: PM.optionsFrom(meta.accuracyBands || [], 'key', 'label') },
      {
        kind: 'multi',
        key: 'permissionMissing',
        label: 'Missing permission',
        options: (meta.permissions || []).map((p) => ({ value: p, label: p })),
      },
      { kind: 'tri', key: 'clockedIn', label: 'Clocked in', yes: 'On the clock', no: 'Off the clock' },
      { kind: 'tri', key: 'insideGeofence', label: 'Inside fence', yes: 'Inside', no: 'Outside', nullable: true },
      { kind: 'tri', key: 'connected', label: 'Connectivity', yes: 'Online', no: 'Offline' },
      { kind: 'tri', key: 'hasLocation', label: 'Coordinates', yes: 'With a fix', no: 'Without a fix' },
      { kind: 'number', key: 'accuracyMax', label: 'Accuracy <= m', placeholder: 'e.g. 25' },
      { kind: 'number', key: 'accuracyMin', label: 'Accuracy >= m', placeholder: 'e.g. 50' },
      { kind: 'number', key: 'batteryMax', label: 'Battery <= %', placeholder: 'e.g. 20' },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'name, email, ref, tz' },
    ]);

    root.append(
      el('div', { class: 'tiles', id: 'hb-tiles' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Heartbeats over time' }),
          el('span', { class: 'sub', id: 'hb-chart-sub' }),
        ]),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'chart-wrap' }, [el('canvas', { id: 'hb-timeline' })]),
          el('div', { html: PMChart.legend([{ color: C.series[0], label: 'Heartbeats stored' }]) }),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Every heartbeat' }),
          el('span', { class: 'sub', id: 'hb-sub' }),
          el('div', { class: 'spacer' }),
          el('button', {
            class: 'btn btn-sm',
            text: '↓ CSV',
            onclick: () => window.open('/api/snapshots.csv?' + queryString({ limit: 5000 }), '_blank'),
          }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { id: 'hb-table' })]),
        el('div', { class: 'pager', id: 'pager' }),
      ])
    );

    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  async function load() {
    PM.showSkeleton({
      '#hb-tiles': 'tiles:8',
      '#hb-timeline': 'chart',
      '#hb-table': 'table:12x10',
    });
    const qs = queryString();
    const [data, stats] = await Promise.all([api('/api/snapshots?' + qs), api('/api/stats?' + qs)]);
    rows = data.rows || [];
    total = data.total || 0;

    renderTiles(stats, data);
    renderTimeline(stats);
    renderTable();

    PM.setSubtitle(fmt.int(total) + ' heartbeats match · newest first');
    PM.markLoaded();
  }

  function renderTiles(stats, data) {
    const host = document.querySelector('#hb-tiles');
    host.innerHTML = '';
    const d = stats.devices || {};
    const bands = stats.accuracyBands || {};
    const conn = stats.connectivity || {};
    const critical = lastGaps.filter((g) => g.critical).length;
    const tile = (label, value, note, tone, id) =>
      el('div', { class: 'tile ' + (tone ? 'is-' + tone : ''), id: id || null }, [
        el('div', { class: 'tile-label', text: label }),
        el('div', { class: 'tile-value', text: value }),
        el('div', { class: 'tile-note', text: note }),
      ]);

    host.append(
      tile('Heartbeats', fmt.int(total), rows.length + ' on this page'),
      tile('Devices reporting', fmt.int(d.trackedUsers), 'distinct users in range'),
      tile(
        'Gaps on this page',
        fmt.int(lastGaps.length),
        critical + ' critical (≥30 min)',
        lastGaps.length ? (critical ? 'critical' : 'warning') : undefined,
        'tile-gaps'
      ),
      tile('Without coordinates', fmt.int(d.noLocation), 'heartbeat carried no fix', d.noLocation ? 'warning' : undefined),
      tile('Avg accuracy', fmt.accuracy(d.avgAccuracy), 'worst ' + fmt.accuracy(d.worstAccuracy)),
      tile(
        'Poor or unusable fixes',
        fmt.int((bands.poor || 0) + (bands.unusable || 0)),
        'over 50 m of uncertainty',
        (bands.poor || 0) + (bands.unusable || 0) ? 'warning' : undefined
      ),
      tile('Offline pings', fmt.int(conn.offline), 'no connectivity when stored', conn.offline ? 'serious' : undefined),
      tile('Permission gaps', fmt.int(d.permissionGaps), fmt.int(d.locationBackgroundMissing) + ' missing background location', d.permissionGaps ? 'warning' : undefined)
    );
  }

  function renderTimeline(stats) {
    const peak = (stats.timeline || []).reduce((max, t) => Math.max(max, t.users || 0), 0);
    const sub = document.querySelector('#hb-chart-sub');
    if (sub) sub.textContent = 'documents per ' + (stats.granularity === 'minute15' ? '15 minutes' : stats.granularity) + ' · up to ' + peak + ' device(s) reporting in a bucket';
    const timeline = PM.padBuckets(stats.timeline || [], stats.granularity, { zero: ['count', 'users'] });
    PMChart.lineTime(document.querySelector('#hb-timeline'), {
      labels: timeline.map((t) => fmt.dayTime(t.at)),
      yTitle: 'heartbeats',
      // One series: charts.js keeps a single y-axis, and heartbeats (thousands)
      // against devices (single digits) on one scale would flatten the second
      // line onto the axis. The device count lives in the tiles instead.
      series: [{ label: 'Heartbeats', data: timeline.map((t) => t.count), color: C.series[0] }],
    });
  }

  function renderTable() {
    const host = document.querySelector('#hb-table');
    // One user selected means the rows are one device's stream, so silences can
    // be drawn between them. Mixed users get the column instead - a gap row
    // between two different people's heartbeats would mean nothing.
    const raw = PM.state.filters.userId;
    const selectedUsers = raw === undefined || raw === null || raw === '' ? [] : String(raw).split(',').filter(Boolean);
    const singleUser = selectedUsers.length === 1;

    const result = PMHeartbeats.table(host, rows, {
      showUser: !singleUser,
      gapRows: singleUser,
      silence: !singleUser,
      empty: 'No heartbeats match these filters. Widen the time range or clear a filter.',
    });
    lastGaps = result.gaps || [];
    // the tiles are drawn before the table, so refresh the gap tile now that the
    // silences are known
    const tile = document.querySelector('#tile-gaps');
    if (tile) {
      const critical = lastGaps.filter((g) => g.critical).length;
      tile.className = 'tile ' + (lastGaps.length ? (critical ? 'is-critical' : 'is-warning') : '');
      tile.querySelector('.tile-value').textContent = fmt.int(lastGaps.length);
      tile.querySelector('.tile-note').textContent = critical + ' critical (≥30 min)';
    }

    document.querySelector('#hb-sub').textContent = singleUser
      ? 'one device selected - silences are drawn between rows'
      : 'silence before each heartbeat is measured per device';

    const page = Number(PM.state.filters.page || 1);
    const limit = Number(PM.state.filters.limit || 100);
    const pager = document.querySelector('#pager');
    pager.innerHTML = '';
    if (!rows.length) return;
    pager.append(
      el('span', { text: 'Showing ' + rows.length + ' of ' + fmt.int(total) + ' · page ' + page }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm',
        text: '← Newer',
        disabled: page <= 1 ? 'disabled' : null,
        onclick: () => PM.setFilter('page', String(page - 1)),
      }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Older →',
        disabled: page * limit >= total ? 'disabled' : null,
        onclick: () => PM.setFilter('page', String(page + 1)),
      })
    );
  }
})();
