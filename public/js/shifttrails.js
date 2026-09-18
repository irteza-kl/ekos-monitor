/* Shift Trails: the app's own state, written as a trail of entries rather than
   as heartbeats.

   Eight fields - when, which process, which person, which site, which handset,
   battery, and the live location permission and precision. No coordinates, so
   there is no map, no trail and no fence verdict on this page, and none is
   implied: a column that reads "unknown" on every row is worse than a column
   that is not there.

   What this stream can say that nothing else in the console can:
     - the app process was RECREATED (runId changed), which is what an OS kill
       or a crash looks like from the outside;
     - the location permission RIGHT NOW, read live rather than cached;
     - that a person exists at all, before they have ever sent a heartbeat. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let rows = [];
  let total = 0;
  let trailMeta = { available: false, users: [], devices: [], permissions: [], precisions: [], sites: [] };

  const PERMISSION_LABEL = {
    always: 'Always',
    when_in_use: 'While using the app',
    denied: 'Denied',
  };

  const PRECISION_LABEL = {
    fine: 'Fine',
    coarse: 'Coarse',
    null: 'Not reported (iOS)',
  };

  PM.boot('shift-trails.html', async ({ root }) => {
    // Built before the dropdown contents arrive and rebuilt when they do, so
    // a snapshot taken here would leave every list empty for the life of the
    // page. Same reason the Exit Windows page passes a function.
    PM.buildFilterBar(() => [
      { kind: 'daterange' },
      {
        kind: 'multi',
        key: 'userId',
        label: 'User',
        options: (trailMeta.users || []).map((u) => ({
          value: u.id,
          // A person with no heartbeat has no name anywhere in this store, so
          // the id is the only honest label and the list says why.
          label: (u.name || 'User ' + u.id) + (u.heartbeatKnown ? '' : ' · trails only'),
          count: u.count,
        })),
      },
      {
        kind: 'multi',
        key: 'deviceType',
        label: 'Device',
        options: PM.optionsFrom(trailMeta.devices || [], 'key', 'key', 'count'),
      },
      {
        kind: 'multi',
        key: 'locationPermission',
        label: 'Location permission',
        options: (trailMeta.permissions || []).map((p) => ({
          value: p.key,
          label: PERMISSION_LABEL[p.key] || p.key,
          count: p.count,
        })),
      },
      {
        kind: 'multi',
        key: 'locationPrecision',
        label: 'Precision',
        options: (trailMeta.precisions || []).map((p) => ({
          value: p.key === null ? 'null' : p.key,
          label: p.key === null ? PRECISION_LABEL.null : PRECISION_LABEL[p.key] || p.key,
          count: p.count,
        })),
      },
      {
        kind: 'multi',
        key: 'siteId',
        label: 'Site',
        options: (trailMeta.sites || []).map((s) => ({
          value: s.key === null ? 'null' : s.key,
          label: s.key === null ? 'No site (unmapped)' : siteLabel(s.key),
          count: s.count,
        })),
      },
      { kind: 'number', key: 'batteryMax', label: 'Battery <= %' },
      { kind: 'number', key: 'batteryMin', label: 'Battery >= %' },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'run id, user id, site id, device' },
    ]);

    root.append(
      el('div', { id: 'st-banner' }),
      el('div', { class: 'tiles', id: 'st-tiles' }),
      el('div', { class: 'card', id: 'st-chart-card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Trail entries over time' }),
          el('span', { class: 'sub', text: 'how often the app actually writes, and how many devices are writing' }),
        ]),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'chart-wrap' }, [el('canvas', { id: 'st-timeline' })]),
          el('div', {
            class: 'hint',
            text:
              'The shape of this line is the cadence. Until the payload says why each entry was written, ' +
              'a flat rate means the app is reporting on a timer and a ragged one means it is reporting on ' +
              'events - and only the first of those makes a gap meaningful.',
          }),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Shift trails' }),
          el('span', { class: 'sub', id: 'st-sub' }),
          el('div', { class: 'spacer' }),
          el('button', {
            class: 'btn btn-sm',
            text: '↓ CSV',
            onclick: () => window.open('/api/shift-trails.csv?' + queryString(), '_blank'),
          }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'st-table' })]),
        el('div', { class: 'pager', id: 'pager' }),
      ])
    );

    await loadMeta();
    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', async () => {
      await loadMeta();
      await load();
    });
  });

  function siteLabel(siteId) {
    const sites = (PM.state.meta || {}).sites || [];
    const hit = sites.find((s) => s.siteId === siteId);
    return (hit ? PM.siteName(hit, siteId) : 'Site ' + siteId) + ' · #' + siteId;
  }

  async function loadMeta() {
    try {
      trailMeta = await api('/api/shift-trails/meta');
    } catch (err) {
      trailMeta = { available: false, users: [], devices: [], permissions: [], precisions: [], sites: [] };
    }
    PM.rebuildFilterBar();
  }

  async function load() {
    PM.showSkeleton({
      '#st-tiles': 'tiles:10',
      '#st-timeline': 'chart',
      '#st-table': 'table:12x8',
    });
    const qs = queryString();
    const [data, stats] = await Promise.all([api('/api/shift-trails?' + qs), api('/api/shift-trails/summary?' + qs)]);
    rows = data.rows || [];
    total = data.total || 0;

    renderBanner(data, stats);
    if (data.unavailable) {
      // Nothing to count, chart or page through. The banner is the whole
      // answer, and an empty chart frame beside it would only look broken.
      document.querySelector('#st-tiles').innerHTML = '';
      document.querySelector('#st-table').innerHTML = '';
      document.querySelector('#pager').innerHTML = '';
      document.querySelector('#st-chart-card').hidden = true;
      PM.setSubtitle('no shift trails in this database yet');
      PM.markLoaded();
      return;
    }
    document.querySelector('#st-chart-card').hidden = false;
    renderTiles(stats);
    renderChart(stats);
    renderTable();
    PM.setSubtitle(fmt.int(total) + ' entries match');
    PM.markLoaded();
  }

  function renderBanner(data, stats) {
    const host = document.querySelector('#st-banner');
    host.innerHTML = '';

    if (data.unavailable) {
      host.append(
        el('div', {
          class: 'notice',
          html:
            '<span>◷</span><span><b>No shift trails yet.</b> Nothing in this database has the shape of one. ' +
            'The page is ready for them: trails are found by shape rather than by collection name, so they ' +
            'will appear here whether the writer gives them their own collection or mixes them into ' +
            '<code>ekosClientState</code> the way the exit windows are.</span>',
        })
      );
      return;
    }

    // What this stream cannot answer yet, stated once, at the top. Each of
    // these is a field the payload review asks the writer for, and each one is
    // a thing a reader would otherwise assume the page is telling them.
    host.append(
      el('div', {
        class: 'notice',
        html:
          '<span>ℹ</span><span><b>This stream carries eight fields and no position.</b> ' +
          'There is no map and no fence verdict here because an entry has no coordinates - for where ' +
          'someone was, the heartbeats are still the only source. Three limits worth holding in mind: ' +
          '<b>a gap between entries is not yet evidence of anything</b>, because the payload does not say ' +
          'whether it writes on a timer or on events; <b>a restart is only counted when both runs sit ' +
          'inside the selected range</b>, so the earliest run of each person is never counted as one; and ' +
          'the payload carries no device id, so <b>one person on two handsets is indistinguishable from ' +
          'one handset restarting</b>.</span>',
      })
    );

    if (stats && stats.usersWithoutHeartbeats) {
      host.append(
        el('div', {
          class: 'notice',
          html:
            '<span>✦</span><span><b>' +
            fmt.int(stats.usersWithoutHeartbeats) +
            ' of these ' +
            fmt.int(stats.users) +
            ' people have never sent a heartbeat.</b> ' +
            'They exist in this console on this page and nowhere else - no user page, no position, and no ' +
            'name, because the name comes from the employee record embedded on a heartbeat. This is the ' +
            'case the payload was added for.</span>',
        })
      );
    }

    if (stats && stats.anonymousEntries) {
      host.append(
        el('div', {
          class: 'notice',
          html:
            '<span>⚠</span><span><b>' +
            fmt.int(stats.anonymousEntries) +
            ' entries carry no user id.</b> Unlike an exit window, an entry has no GPS samples to fingerprint ' +
            'against the heartbeat stream, so these cannot be matched to a person by any route at all.</span>',
        })
      );
    }
  }

  function renderTiles(s) {
    const host = document.querySelector('#st-tiles');
    host.innerHTML = '';
    const tile = (label, value, note, tone) =>
      el('div', { class: 'tile ' + (tone ? 'is-' + tone : '') }, [
        el('div', { class: 'tile-label', text: label }),
        el('div', { class: 'tile-value', text: value }),
        el('div', { class: 'tile-note', text: note }),
      ]);

    const permission = (key) => (s.permissions || []).find((p) => p.key === key);
    const denied = (permission('denied') || {}).count || 0;
    const whenInUse = (permission('when_in_use') || {}).count || 0;
    const coarse = ((s.precisions || []).find((p) => p.key === 'coarse') || {}).count || 0;
    const notReported = ((s.precisions || []).find((p) => p.key === null) || {}).count || 0;
    const battery = s.battery || {};
    const namedSites = (s.sites || []).filter((x) => x.key !== null).length;
    const noSite = ((s.sites || []).find((x) => x.key === null) || {}).count || 0;

    host.append(
      tile('Entries', fmt.int(s.total), s.range.min ? 'first ' + fmt.dayTime(s.range.min) : 'in this range'),
      tile(
        'People',
        fmt.int(s.users),
        s.usersWithoutHeartbeats
          ? fmt.int(s.usersWithoutHeartbeats) + ' seen only here'
          : 'all known to the heartbeats',
        s.usersWithoutHeartbeats ? 'info' : undefined
      ),
      tile('Runs', fmt.int(s.runs), 'distinct app processes'),
      tile(
        'Restarts',
        fmt.int(s.restarts),
        'the process was recreated',
        s.restarts ? 'serious' : undefined
      ),
      tile(
        'Location denied',
        fmt.int(denied),
        denied ? 'no location at all on these entries' : 'none refused outright',
        denied ? 'critical' : undefined
      ),
      tile(
        'Foreground only',
        fmt.int(whenInUse),
        'tracking stops when the app is backgrounded',
        whenInUse ? 'serious' : undefined
      ),
      tile(
        'Coarse location',
        fmt.int(coarse),
        coarse ? 'fixes land 1-3 km out at this setting' : fmt.int(notReported) + ' not reported (iOS)',
        coarse ? 'warning' : undefined
      ),
      tile(
        'Battery critical',
        fmt.int(battery.critical || 0),
        'at or below 10%',
        battery.critical ? 'critical' : undefined
      ),
      tile(
        'Battery low',
        fmt.int(battery.low || 0),
        'at or below 20%' + (battery.avg === null ? '' : ' · avg ' + fmt.num(battery.avg, 1) + '%'),
        battery.low ? 'warning' : undefined
      ),
      tile(
        'Sites',
        fmt.int(namedSites),
        noSite ? fmt.int(noSite) + ' entries with no site' : 'named on these entries'
      )
    );
  }

  function renderChart(s) {
    const timeline = PM.padBuckets(s.timeline || [], s.granularity, { zero: ['count', 'users'] });
    PMChart.lineTime(document.querySelector('#st-timeline'), {
      labels: timeline.map((t) => fmt.dayTime(t.at)),
      yTitle: 'entries',
      series: [
        { label: 'Entries', data: timeline.map((t) => t.count), color: C.series[0] },
        { label: 'People writing', data: timeline.map((t) => t.users), color: C.series[2], dashed: true },
      ],
    });
  }

  function personCell(row) {
    if (row.userId === null || row.userId === undefined) {
      return '<span class="badge badge-warning">no user id</span>';
    }
    const label = esc(row.name || 'User ' + row.userId);
    if (!row.heartbeatKnown) {
      // No user page to send them to: that page is built from heartbeats and
      // would be empty. Saying so beats a link that goes nowhere useful.
      return (
        '<b>' + label + '</b> <span class="badge badge-info" title="this person has never sent a heartbeat, so ' +
        'there is no user page, no position and no name for them anywhere else in this console">trails only</span>' +
        '<div class="person-sub">#' + row.userId + '</div>'
      );
    }
    return (
      '<a href="/user.html?userId=' + row.userId + '"><b>' + label + '</b></a>' +
      '<div class="person-sub">#' + row.userId + '</div>'
    );
  }

  function runCell(row) {
    if (!row.runId) return '<span class="hint">--</span>';
    const short = row.runId.length > 10 ? row.runId.slice(0, 8) + '…' : row.runId;
    const badge = row.restart
      ? '<span class="badge badge-critical" title="this is the first entry of a new run for this person - ' +
        'the app process was recreated at this point">restart</span>'
      : '';
    const position = row.run ? 'run ' + row.run.ordinal + ' of ' + row.run.of + ' · ' + fmt.int(row.run.entries) + ' entries' : '';
    return (
      '<span class="mono" title="' + esc(row.runId) + '">' + esc(short) + '</span> ' + badge +
      (position ? '<div class="person-sub">' + position + '</div>' : '')
    );
  }

  function permissionCell(row) {
    const value = row.locationPermission;
    if (value === null) return '<span class="badge badge-neutral">not reported</span>';
    if (!row.locationPermissionKnown) {
      return (
        '<span class="badge badge-warning" title="the app sent a value this console does not recognise">' +
        esc(value) + '</span>'
      );
    }
    const cls = value === 'denied' ? 'badge-critical' : value === 'when_in_use' ? 'badge-warning' : 'badge-good';
    return '<span class="badge ' + cls + '">' + esc(PERMISSION_LABEL[value]) + '</span>';
  }

  function precisionCell(row) {
    if (row.locationPrecision === null) {
      // Not a gap in the data: iOS does not report this, and "not reported"
      // must never read as "fine".
      return '<span class="badge badge-neutral" title="iOS does not report a precision - this is the ' +
        'documented value, not missing data">not reported</span>';
    }
    const cls = row.coarseLocation ? 'badge-warning' : 'badge-neutral';
    return '<span class="badge ' + cls + '">' + esc(PRECISION_LABEL[row.locationPrecision] || row.locationPrecision) + '</span>';
  }

  function renderTable() {
    const host = document.querySelector('#st-table');
    host.innerHTML = '';
    if (!rows.length) {
      host.append(
        el('div', {
          class: 'empty',
          text: 'No shift trails match these filters, in ' + PM.rangeLabel() + '.',
        })
      );
      document.querySelector('#pager').innerHTML = '';
      return;
    }

    const node = el('table');
    node.innerHTML =
      '<thead><tr><th>Recorded</th><th>User</th><th>Run</th><th>Site</th><th>Device</th>' +
      '<th class="num">Battery</th><th>Location permission</th><th>Precision</th></tr></thead>';
    const body = el('tbody');
    for (const row of rows) {
      body.append(
        el('tr', {
          class: 'clickable' + (row.restart ? ' is-flagged' : ''),
          title: 'Open this entry',
          onclick: (event) => {
            if (event.target.closest('a')) return;
            openDetail(row);
          },
          html:
            '<td>' + fmt.dayTime(row.recordedAt) + '<div class="person-sub">' + fmt.ago(row.recordedAt) + '</div></td>' +
            '<td>' + personCell(row) + '</td>' +
            '<td>' + runCell(row) + '</td>' +
            '<td>' +
            (row.siteId === null
              ? '<span class="badge badge-neutral" title="the payload sends null here for an unmapped clock-in">no site</span>'
              : esc(siteLabel(row.siteId))) +
            '</td>' +
            '<td>' + esc(row.deviceType || '?') + '</td>' +
            '<td class="num">' + PM.batteryBadge(row.battery) + '</td>' +
            '<td>' + permissionCell(row) + '</td>' +
            '<td>' + precisionCell(row) + '</td>',
        })
      );
    }
    node.append(body);
    host.append(node);

    const pager = document.querySelector('#pager');
    pager.innerHTML = '';
    const page = Number(PM.state.filters.page || 1);
    const limit = Number(PM.state.filters.limit || 100);
    pager.append(
      el('span', { text: 'Showing ' + rows.length + ' of ' + fmt.int(total) }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm',
        text: '← Previous',
        disabled: page <= 1 ? 'disabled' : null,
        onclick: () => PM.setFilter('page', String(page - 1)),
      }),
      el('span', { text: 'Page ' + page }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Next →',
        disabled: page * limit >= total ? 'disabled' : null,
        onclick: () => PM.setFilter('page', String(page + 1)),
      })
    );
    document.querySelector('#st-sub').textContent = 'click an entry for its full breakdown';
  }

  function openDetail(row) {
    PM.openDrawer({
      title: row.name || (row.userId === null ? 'Entry with no user' : 'User ' + row.userId),
      subtitle: fmt.date(row.recordedAt) + (row.restart ? ' · the app process was recreated here' : ''),
      tabs: [
        {
          id: 'entry',
          label: 'The entry',
          render: (host) => {
            host.append(
              PM.kv([
                ['Recorded at', fmt.date(row.recordedAt)],
                ['Age', fmt.ago(row.recordedAt)],
                [
                  'User',
                  row.userId === null
                    ? '<span class="badge badge-warning">no user id on this entry</span>'
                    : (row.name ? esc(row.name) + ' ' : '') +
                      '<span class="hint">#' + row.userId + '</span>' +
                      (row.heartbeatKnown
                        ? ' <a href="/user.html?userId=' + row.userId + '">open their page →</a>'
                        : ' <span class="badge badge-info">never sent a heartbeat</span>'),
                ],
                ['Site', row.siteId === null ? 'none - unmapped clock-in' : esc(siteLabel(row.siteId))],
                ['Device', esc(row.deviceType || '--')],
                ['Battery', PM.batteryBadge(row.battery)],
                ['Location permission', permissionCell(row)],
                ['Location precision', precisionCell(row)],
              ])
            );

            host.append(el('h3', { text: 'This run' }));
            host.append(
              PM.kv([
                ['Run id', '<span class="mono">' + esc(row.runId || '--') + '</span>'],
                row.run ? ['Position', 'run ' + row.run.ordinal + ' of ' + row.run.of + ' for this person, in ' + PM.rangeLabel()] : null,
                row.run ? ['Entries in this run', fmt.int(row.run.entries)] : null,
                row.run ? ['Run first seen', fmt.date(row.run.firstAt)] : null,
                row.run ? ['Run last seen', fmt.date(row.run.lastAt)] : null,
                [
                  'Restart',
                  row.restart
                    ? '<span class="badge badge-critical">yes</span> the previous run ended and this one began'
                    : row.run && row.run.ordinal === 1
                      ? 'not visible - this is the earliest run for this person in ' +
                        PM.rangeLabel() +
                        ', so there is nothing before it to compare against'
                      : 'no - the same run as the entry before it',
                ],
              ])
            );
            host.append(
              el('div', {
                class: 'hint',
                text:
                  'A run is one life of the app process. The payload carries no start time for it, so ' +
                  '"first seen" is the earliest entry this run wrote that is still in the store - which is ' +
                  'not the same thing as when the process actually started.',
              })
            );
          },
        },
        {
          id: 'raw',
          label: 'Raw document',
          render: (host) => {
            host.append(el('div', { class: 'sk sk-line' }));
            api('/api/shift-trails/' + row.id).then(
              (data) => {
                host.innerHTML = '';
                host.append(el('pre', { class: 'json', html: PM.jsonHighlight(data.raw) }));
              },
              (err) => {
                host.innerHTML = '';
                host.append(el('div', { class: 'empty', text: 'Could not load: ' + err.message }));
              }
            );
          },
        },
      ],
    });
  }
})();
