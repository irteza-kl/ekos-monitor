/* Shift Trails: one sealed document per shift, and everything in it.

   The app seals a trail at clock-out and pushes it when the network allows.
   Each one carries the shift's own facts, a summary it computed itself, and an
   entries array - every entry either a GPS `fix` or a `runtime_start`, the app
   process having been recreated mid-shift.

   So a row here is a SHIFT, not a ping. What it answers that nothing else in
   this console can:

     - how much of a shift the app could actually say where somebody was
       (coverage), and where the rest of it went (absences);
     - that the app process was recreated during the shift, how many times, and
       whether the foreground service survived it;
     - the live location permission and precision, and whether either changed
       halfway through - which is what explains a trail that stops dead.

   The path is drawn in the drawer against the site's own fence, because a
   trail with nothing to measure it against is half an answer on a geofence
   console. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let rows = [];
  let total = 0;
  let trailMeta = { available: false, users: [], sites: [], devices: [], permissions: [], precisions: [] };

  const PERMISSION_LABEL = { always: 'Always', when_in_use: 'While using the app', denied: 'Denied' };
  const PRECISION_LABEL = { fine: 'Fine', coarse: 'Coarse' };

  /**
   * What each entry kind is and how it reads.
   *
   * Green for a fix, red for a gap, amber for a restart - the severity of the
   * thing, not a palette: a fix is the app working, a gap is the app unable to
   * see the device at all, and a restart is the process having died and come
   * back, which is bad but not blind.
   *
   * Keyed by the app's own value, and anything not in here is rendered as
   * itself rather than as the nearest kind we know. The Kind column used to
   * ask "is this a runtime start?" and call everything else a fix, so when
   * `gap` started arriving every one of them was drawn as its opposite.
   */
  const ENTRY_KIND = {
    fix: { label: 'Fix', badge: 'badge-good' },
    gap: { label: 'Gap', badge: 'badge-critical' },
    // The app's own field is `runtime_start`; a reader comparing this against
    // the raw document needs that word, so it goes in the tooltip rather than
    // being lost. On screen it is a restart, which is what it means and what
    // the tile, the column and the filter beside it already call it.
    runtime_start: { label: 'Restart', badge: 'badge-warning', title: 'the app process was recreated - "runtime_start" in the document' },
  };

  /** `services_disabled` -> `services disabled`, for a value we have no label for. */
  function humanise(value) {
    const words = String(value).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  PM.boot('shift-trails.html', async ({ root }) => {
    PM.buildFilterBar(() =>
      [
        { kind: 'daterange' },
        {
          kind: 'multi',
          key: 'userId',
          label: 'User',
          options: (trailMeta.users || []).map((u) => ({
            value: u.id,
            label: (u.name || 'User ' + u.id) + (u.heartbeatKnown ? '' : ' · trails only'),
            count: u.count,
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
            label: p.key === null ? 'Not reported (iOS)' : PRECISION_LABEL[p.key] || p.key,
            count: p.count,
          })),
        },
        { kind: 'tri', key: 'hasRestarts', label: 'App restarted', yes: 'Only these' },
        { kind: 'tri', key: 'hasGaps', label: 'Has gaps', yes: 'Only these' },
        { kind: 'tri', key: 'hasAbsences', label: 'Has absences', yes: 'Only these' },
        { kind: 'tri', key: 'noFixes', label: 'No fixes at all', yes: 'Only these' },
        { kind: 'number', key: 'maxCoverage', label: 'Coverage <= %' },
        { kind: 'number', key: 'minDurationMinutes', label: 'Shift >= min' },
        { kind: 'text', key: 'search', label: 'Search', placeholder: 'shift key, run id, user or site id' },
      ].filter(Boolean)
    );

    root.append(
      el('div', { id: 'st-banner' }),
      el('div', { class: 'tiles', id: 'st-tiles' }),
      el('div', { class: 'card', id: 'st-chart-card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Shifts and restarts' }),
          el('span', { class: 'sub', text: 'sealed trails per day, and the app restarts inside them' }),
        ]),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'chart-wrap' }, [el('canvas', { id: 'st-timeline' })]),
          el('div', {
            html: PMChart.legend([
              { color: C.series[0], label: 'Shifts sealed' },
              { color: C.series[3], label: 'App restarts' },
            ]),
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
      trailMeta = { available: false, users: [], sites: [], devices: [], permissions: [], precisions: [] };
    }
    PM.rebuildFilterBar();
  }

  async function load() {
    PM.showSkeleton({ '#st-tiles': 'tiles:10', '#st-timeline': 'chart', '#st-table': 'table:10x11' });
    const qs = queryString();
    const [data, stats] = await Promise.all([api('/api/shift-trails?' + qs), api('/api/shift-trails/summary?' + qs)]);
    rows = data.rows || [];
    total = data.total || 0;

    renderBanner(data, stats);
    if (data.unavailable) {
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
    renderTable(data);
    PM.setSubtitle(fmt.int(total) + ' shifts match');
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
            'They are found by shape rather than by collection name, so they will appear here whether the ' +
            'writer gives them their own collection or mixes them into <code>ekosClientState</code>.</span>',
        })
      );
      return;
    }

    host.append(
      el('div', {
        class: 'notice',
        html:
          '<span>ℹ</span><span><b>One row is one shift</b>, sealed by the app at clock-out and pushed when ' +
          'the network allowed. <b>Coverage</b> is how much of the shift the app could say where somebody ' +
          'was; the rest is in <b>absences</b>, which the app itself works out and flags when the runtime ' +
          'restarted across one. A <b>restart</b> is the app process being recreated mid-shift - an OS kill, ' +
          'a crash or a force-quit - which nothing else in this console can see.' +
          '<br><br><b>Gaps and absences are different failures.</b> A <b>gap</b> is an entry the app wrote to ' +
          'say it was awake and could not get a position - it names the reason, usually location services ' +
          'switched off. An <b>absence</b> is a stretch where it wrote nothing at all: silence rather than a ' +
          'report of blindness, which is why the only clue to its cause is whether the runtime restarted ' +
          'across it. A shift can have gaps and no absences - the app talking steadily while blind - or ' +
          'absences and no gaps, which is the phone gone.</span>',
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
            ' people have never sent a heartbeat.</b> They exist in this console on this page and nowhere ' +
            'else - no user page, and no name, because the name comes from the employee record embedded on ' +
            'a heartbeat.</span>',
        })
      );
    }

    if (data.postFiltered) {
      host.append(
        el('div', {
          class: 'notice',
          html:
            '<span>⚠</span><span>The coverage, distance and duration filters are applied after the query, so ' +
            'the total above counts shifts <b>before</b> them. This page shows ' +
            fmt.int(data.matchedOnPage) +
            ' of the ' +
            fmt.int(data.limit) +
            ' it fetched.</span>',
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

    const denied = ((s.permissions || []).find((p) => p.key === 'denied') || {}).count || 0;
    const whenInUse = ((s.permissions || []).find((p) => p.key === 'when_in_use') || {}).count || 0;
    const coarse = ((s.precisions || []).find((p) => p.key === 'coarse') || {}).count || 0;

    host.append(
      tile('Shifts', fmt.int(s.total), s.range.min ? 'from ' + fmt.dayTime(s.range.min) : 'sealed trails'),
      tile(
        'People',
        fmt.int(s.users),
        s.usersWithoutHeartbeats ? fmt.int(s.usersWithoutHeartbeats) + ' seen only here' : 'all known to the heartbeats',
        s.usersWithoutHeartbeats ? 'info' : undefined
      ),
      tile(
        'Coverage',
        s.coverage === null ? '--' : fmt.pct(s.coverage),
        fmt.num(s.positionedMinutes, 0) + ' of ' + fmt.num(s.shiftMinutes, 0) + ' shift minutes positioned',
        s.coverage !== null && s.coverage < 80 ? 'serious' : undefined
      ),
      tile('Fixes', fmt.int(s.fixes), fmt.int(s.entries) + ' entries in total'),
      tile(
        'App restarts',
        fmt.int(s.runtimeStarts),
        fmt.int(s.shiftsWithRestarts) + ' shift(s) affected',
        s.runtimeStarts ? 'serious' : undefined
      ),
      tile(
        'Gaps',
        fmt.int(s.gaps),
        'the app was awake but blind',
        s.gaps ? 'serious' : undefined
      ),
      tile(
        'Absences',
        fmt.int(s.absences),
        fmt.int(s.shiftsWithAbsences) + ' shift(s) went silent',
        s.absences ? 'critical' : undefined
      ),
      tile(
        'Shifts with no fix',
        fmt.int(s.shiftsWithNoFix),
        'sealed without a single position',
        s.shiftsWithNoFix ? 'critical' : undefined
      ),
      tile(
        'Location denied',
        fmt.int(denied),
        denied ? 'entries with no location at all' : 'none refused outright',
        denied ? 'critical' : undefined
      ),
      tile(
        'Foreground only',
        fmt.int(whenInUse),
        'entries that cannot track in the background',
        whenInUse ? 'serious' : undefined
      ),
      tile('Coarse fixes', fmt.int(coarse), coarse ? 'accurate to 1-3 km, not metres' : 'every fix was fine-grained', coarse ? 'warning' : undefined)
    );
  }

  function renderChart(s) {
    const timeline = PM.padBuckets(s.timeline || [], s.granularity, { zero: ['count', 'restarts'] });
    PMChart.lineTime(document.querySelector('#st-timeline'), {
      labels: timeline.map((t) => fmt.dayTime(t.at)),
      yTitle: 'per day',
      series: [
        { label: 'Shifts sealed', data: timeline.map((t) => t.count), color: C.series[0] },
        { label: 'App restarts', data: timeline.map((t) => t.restarts), color: C.series[3], dashed: true },
      ],
    });
  }

  function personCell(row) {
    if (row.userId === null || row.userId === undefined) return '<span class="badge badge-warning">no user id</span>';
    const label = esc(row.name || 'User ' + row.userId);
    if (!row.heartbeatKnown) {
      return (
        '<b>' + label + '</b> <span class="badge badge-info" title="this person has never sent a heartbeat, so ' +
        'there is no user page and no name for them anywhere else in this console">trails only</span>' +
        '<div class="person-sub">#' + row.userId + '</div>'
      );
    }
    return '<a href="/user.html?userId=' + row.userId + '"><b>' + label + '</b></a><div class="person-sub">#' + row.userId + '</div>';
  }

  function coverageCell(row) {
    const c = row.stats.coverage;
    if (c === null) return '<span class="hint">--</span>';
    const cls = c >= 90 ? 'badge-good' : c >= 60 ? 'badge-warning' : 'badge-critical';
    return (
      '<span class="badge ' + cls + '">' + fmt.pct(c) + '</span>' +
      '<div class="person-sub">' + fmt.num(row.stats.positionedMinutes, 0) + ' of ' + fmt.num(row.durationMinutes, 0) + ' min</div>'
    );
  }

  function permissionCell(row) {
    const worst = row.stats.worstPermission;
    if (!worst) return '<span class="badge badge-neutral">not reported</span>';
    const cls = worst === 'denied' ? 'badge-critical' : worst === 'when_in_use' ? 'badge-warning' : 'badge-good';
    return (
      '<span class="badge ' + cls + '">' + esc(PERMISSION_LABEL[worst] || worst) + '</span>' +
      (row.stats.permissionChanged
        ? '<div class="person-sub" title="the permission was not the same for the whole shift, which is what ' +
          'explains a trail that stops part way through">changed mid-shift</div>'
        : '')
    );
  }

  /** One entry's kind, and the detail only that kind carries. */
  function kindCell(e) {
    const known = ENTRY_KIND[e.kind];
    if (!known) {
      return (
        '<span class="badge badge-info" title="an entry kind this console does not know yet - shown as the app sent it">' +
        esc(e.kind === null || e.kind === undefined ? 'no kind' : humanise(e.kind)) +
        '</span>'
      );
    }
    let sub = '';
    if (e.isGap && e.reason) {
      // The reason is the whole value of a gap: "services_disabled" means
      // location services were switched off, which nothing else here records.
      sub = '<div class="person-sub" title="why the app could not see the device">' + esc(humanise(e.reason)) + '</div>';
    } else if (e.isRuntimeStart && e.foregroundServicePresent === false) {
      sub = '<div class="person-sub" title="the process came back with no foreground service, which is the strongest sign here that the OS killed the app">no foreground service</div>';
    } else if (e.isRuntimeStart && e.foregroundServicePresent === true) {
      sub = '<div class="person-sub">service alive</div>';
    }
    const title = known.title ? ' title="' + esc(known.title) + '"' : '';
    return '<span class="badge ' + known.badge + '"' + title + '>' + esc(known.label) + '</span>' + sub;
  }

  function renderTable(data) {
    const host = document.querySelector('#st-table');
    host.innerHTML = '';
    if (!rows.length) {
      host.append(el('div', { class: 'empty', text: 'No shift trails match these filters, in ' + PM.rangeLabel() + '.' }));
      document.querySelector('#pager').innerHTML = '';
      return;
    }

    const node = el('table');
    node.innerHTML =
      '<thead><tr><th>Shift</th><th>User</th><th>Site</th><th class="num">Duration</th><th>Coverage</th>' +
      '<th class="num">Fixes</th><th class="num">Restarts</th>' +
      '<th class="num" title="entries where the app was running and said it could not get a position - it knows why">Gaps</th>' +
      '<th class="num" title="stretches where the app wrote nothing at all - silence, not a report of blindness">Absences</th>' +
      '<th class="num">Travelled</th><th class="num">Accuracy</th><th>Permission</th><th>Device</th></tr></thead>';
    const body = el('tbody');

    for (const row of rows) {
      const s = row.stats;
      const flagged = row.absenceCount || s.runtimeStartCount || s.gapCount || s.fixCount === 0;
      body.append(
        el('tr', {
          class: 'clickable' + (flagged ? ' is-flagged' : ''),
          title: 'Open this shift',
          onclick: (event) => {
            if (event.target.closest('a')) return;
            openDetail(row);
          },
          html:
            '<td>' + fmt.dayTime(row.clockOut || row.sealedAt) +
            '<div class="person-sub mono" title="the key the app knows this shift by">' + esc(row.shiftKey || '--') + '</div></td>' +
            '<td>' + personCell(row) + '</td>' +
            '<td>' +
            (row.siteId === null
              ? '<span class="badge badge-neutral" title="this clock-in was never mapped to a site">no site</span>'
              : esc(siteLabel(row.siteId))) +
            '</td>' +
            '<td class="num">' + fmt.duration(row.durationMinutes) + '</td>' +
            '<td>' + coverageCell(row) + '</td>' +
            '<td class="num">' + fmt.int(s.fixCount) +
            (s.fixCount === 0 ? ' <span class="badge badge-critical">none</span>' : '') + '</td>' +
            '<td class="num">' + (s.runtimeStartCount ? '<span class="badge badge-serious">' + s.runtimeStartCount + '</span>' : '0') +
            (s.runtimeStartsDisagree
              ? '<div class="person-sub" title="the app reported a different number of restarts than the runtime_start entries it sent">app said ' +
                fmt.int(row.reported.runtimeStarts) + '</div>'
              : '') + '</td>' +
            // Gaps carry their reason, absences their duration: the count alone
            // says how often, and what you actually want to know is why, or for
            // how long.
            '<td class="num">' + (s.gapCount ? '<span class="badge badge-critical">' + s.gapCount + '</span>' : '0') +
            (s.gapReasons && s.gapReasons.length
              ? '<div class="person-sub">' + esc(s.gapReasons.map(humanise).join(', ')) + '</div>'
              : '') + '</td>' +
            '<td class="num">' + (row.absenceCount ? '<span class="badge badge-critical">' + row.absenceCount + '</span>' : '0') +
            (row.absentMinutes ? '<div class="person-sub">' + fmt.duration(row.absentMinutes) + '</div>' : '') + '</td>' +
            '<td class="num">' + (s.travelledMetres === null ? '--' : fmt.metres(s.travelledMetres)) + '</td>' +
            '<td class="num">' + fmt.accuracy(s.avgAccuracy) +
            (s.coarseFixes ? '<div class="person-sub">' + s.coarseFixes + ' coarse</div>' : '') + '</td>' +
            '<td>' + permissionCell(row) + '</td>' +
            '<td>' + esc(row.deviceType || '?') +
            '<div class="person-sub">' + esc(row.appVersion || '') +
            (s.batteryStart === null ? '' : ' · ' + s.batteryStart + '→' + s.batteryEnd + '%') + '</div></td>',
        })
      );
    }

    node.append(body);
    host.append(node);

    const pager = document.querySelector('#pager');
    pager.innerHTML = '';
    const page = Number(PM.state.filters.page || 1);
    const limit = Number(data.limit || 50);
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
    document.querySelector('#st-sub').textContent = 'click a shift to walk its path';
  }

  // ------------------------------------------------------------------ drawer

  /**
   * Leaflet holds window listeners and tile caches until remove() is called,
   * and openDrawer only wipes the body - which detaches the container and
   * leaves the map running. The other drawers in this console release theirs
   * on pm:drawer-close; this one does the same.
   */
  let drawerMap = null;
  function releaseDrawerMap() {
    if (!drawerMap) return;
    try {
      drawerMap.remove();
    } catch (err) {
      /* the container went with the drawer body */
    }
    drawerMap = null;
  }
  window.addEventListener('pm:drawer-close', releaseDrawerMap);

  function openDetail(row) {
    releaseDrawerMap();
    const s = row.stats;
    PM.openDrawer({
      // The Entries tab is an eight-column table. At the default 760px its
      // last columns sit behind a horizontal scrollbar with most of the screen
      // free beside it.
      wide: true,
      title: (row.name || 'User ' + row.userId) + ' · shift ' + (row.shiftKey || ''),
      subtitle:
        fmt.dayTime(row.clockIn) + ' → ' + fmt.dayTime(row.clockOut) + ' · ' + fmt.duration(row.durationMinutes) +
        (row.timezone ? ' · ' + row.timezone : ''),
      tabs: [
        {
          id: 'shift',
          label: 'The shift',
          render: (host) => {
            host.append(el('div', { class: 'map-wrap', id: 'st-map', style: 'height:320px;margin-bottom:12px' }));

            host.append(
              PM.kv([
                ['Coverage', coverageCell(row)],
                ['Positioned', fmt.duration(s.positionedMinutes) + ' of ' + fmt.duration(row.durationMinutes)],
                s.unpositionedMinutes ? ['Unpositioned', fmt.duration(s.unpositionedMinutes)] : null,
                [
                  'Entries',
                  fmt.int(s.entryCount) +
                    ' · ' +
                    [
                      fmt.int(s.fixCount) + ' fixes',
                      s.gapCount ? fmt.int(s.gapCount) + ' gaps' : null,
                      fmt.int(s.runtimeStartCount) + ' restarts',
                    ]
                      .filter(Boolean)
                      .join(', '),
                ],
                s.gapCount
                  ? [
                      'Gaps',
                      '<span class="badge badge-critical">' + fmt.int(s.gapCount) + '</span> ' +
                        (s.gapReasons.length
                          ? 'reported as ' + s.gapReasons.map((r) => '<b>' + esc(humanise(r)) + '</b>').join(', ')
                          : 'with no reason given') +
                        (s.gapsDisagree
                          ? '<div class="person-sub">the app’s own summary counted ' + fmt.int(row.reported.gaps) + '</div>'
                          : ''),
                    ]
                  : null,
                s.unknownKinds && s.unknownKinds.length
                  ? [
                      'Unrecognised entries',
                      '<span class="badge badge-info">' + s.unknownKinds.map(esc).join(', ') + '</span> - a kind this ' +
                        'console does not know yet, shown as the app sent it',
                    ]
                  : null,
                ['Distinct runs', fmt.int(s.distinctRuns)],
                [
                  'App restarts',
                  s.runtimeStartsDisagree
                    ? '<span class="badge badge-warning">' + s.runtimeStartCount + ' entries, app reported ' +
                      fmt.int(row.reported.runtimeStarts) + '</span>'
                    : fmt.int(s.runtimeStartCount),
                ],
                s.serviceMissingOnRestart
                  ? [
                      'Foreground service gone',
                      '<span class="badge badge-critical">' + s.serviceMissingOnRestart + '</span> restart(s) came back with no service - ' +
                        'the strongest sign here that the OS killed the app',
                    ]
                  : null,
                ['Travelled', s.travelledMetres === null ? '--' : fmt.metres(s.travelledMetres) + ' along the path'],
                s.largestStepMetres ? ['Largest single step', fmt.metres(s.largestStepMetres)] : null,
                ['Longest gap between entries', fmt.duration(s.longestEntryGapMinutes)],
                ['Accuracy', fmt.accuracy(s.avgAccuracy) + ' avg, worst ' + fmt.accuracy(s.maxAccuracy)],
                s.coarseFixes ? ['Coarse fixes', s.coarseFixes + ' of ' + s.fixCount] : null,
                ['Battery', s.batteryStart === null ? '--' : s.batteryStart + '% → ' + s.batteryEnd + '% (min ' + s.batteryMin + '%)'],
                ['Permission', permissionCell(row)],
                ['Precision', (s.precisions || []).map((p) => PRECISION_LABEL[p] || p).join(', ') || 'not reported'],
                row.site && row.fence
                  ? [
                      'Against the fence',
                      fmt.int(row.fence.inside) + ' inside, ' + fmt.int(row.fence.outside) + ' outside, ' +
                        fmt.int(row.fence.uncertain) + ' uncertain' +
                        (row.fence.furthestOutside !== null ? ' · furthest ' + fmt.metres(row.fence.furthestOutside) : ''),
                    ]
                  : null,
                ['Sealed', fmt.date(row.sealedAt) + (row.sealLagSeconds !== null ? ' · ' + row.sealLagSeconds + 's after clock-out' : '')],
                ['Pushed', fmt.date(row.pushedAt) + (row.pushLagSeconds !== null ? ' · ' + row.pushLagSeconds + 's after sealing' : '')],
                ['Device', esc(row.deviceType || '--') + ' · ' + esc(row.appVersion || '?') + ' (' + esc(row.buildVersion || '?') + ')'],
              ])
            );

            if (row.absences.length) {
              host.append(el('h3', { text: 'Absences' }));
              const table = el('table');
              table.innerHTML =
                '<thead><tr><th>From</th><th>To</th><th class="num">Minutes</th><th>Runtime restarted</th></tr></thead>';
              const tbody = el('tbody');
              for (const a of row.absences) {
                tbody.append(
                  el('tr', {
                    html:
                      '<td>' + fmt.dayTime(a.from) + '</td><td>' + fmt.dayTime(a.to) + '</td>' +
                      '<td class="num">' + fmt.num(a.minutes, 0) + '</td>' +
                      '<td>' + (a.runtimeRestarted
                        ? '<span class="badge badge-serious">yes</span>'
                        : '<span class="badge badge-neutral">no</span>') + '</td>',
                  })
                );
              }
              table.append(tbody);
              host.append(el('div', { class: 'table-scroll' }, [table]));
              host.append(
                el('div', {
                  class: 'hint',
                  text:
                    'An absence is the app’s own judgement that it could not say where the device was. ' +
                    'Where the runtime restarted across one, the process died and came back - which is a ' +
                    'different failure from a device that simply lost its fix.',
                })
              );
            }

            // The map is sized after the panel is visible; a map built inside a
            // hidden container comes out 0x0.
            requestAnimationFrame(() => drawMap(row));
          },
        },
        {
          id: 'entries',
          label: 'Entries (' + row.entries.length + ')',
          render: (host) => {
            const table = el('table');
            table.innerHTML =
              '<thead><tr><th>Recorded</th><th>Kind</th><th>Position</th><th class="num">Accuracy</th>' +
              '<th class="num">Battery</th><th>Permission</th><th>Precision</th><th>Run</th></tr></thead>';
            const tbody = el('tbody');
            for (const e of row.entries) {
              tbody.append(
                el('tr', {
                  class: e.isRuntimeStart || e.isGap ? 'is-flagged' : '',
                  html:
                    '<td>' + fmt.dayTime(e.recordedAt) +
                    (e.fixLagSeconds ? '<div class="person-sub" title="how stale the fix was when it was logged">fix ' + e.fixLagSeconds + 's earlier</div>' : '') +
                    '</td>' +
                    '<td>' + kindCell(e) + '</td>' +
                    '<td>' + (e.location
                      ? '<span class="mono">' + fmt.coords(e.location) + '</span>' +
                        (e.fenceVerdict ? ' ' + PM.geofenceBadge(e.fenceVerdict === 'in' ? true : e.fenceVerdict === 'out' ? false : null) : '')
                      : '<span class="hint">no position</span>') + '</td>' +
                    '<td class="num">' + fmt.accuracy(e.accuracy) + '</td>' +
                    '<td class="num">' + (e.battery === null ? '--' : e.battery + '%') + '</td>' +
                    '<td>' + esc(PERMISSION_LABEL[e.locationPermission] || e.locationPermission || '--') + '</td>' +
                    '<td>' + (e.locationPrecision === null
                      ? '<span class="hint">not reported</span>'
                      : esc(PRECISION_LABEL[e.locationPrecision] || e.locationPrecision)) + '</td>' +
                    '<td class="mono" title="' + esc(e.runId || '') + '">' + esc((e.runId || '--').slice(0, 8)) + '</td>',
                })
              );
            }
            table.append(tbody);
            host.append(el('div', { class: 'table-scroll' }, [table]));
          },
        },
        {
          id: 'raw',
          label: 'Raw document',
          render: (host) => {
            host.append(el('div', { class: 'sk sk-line' }));
            api('/api/shift-trails/' + row.id).then(
              (res) => {
                host.innerHTML = '';
                host.append(el('pre', { class: 'json', html: PM.jsonHighlight(res.raw) }));
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

  function drawMap(row) {
    const target = document.querySelector('#st-map');
    if (!target) return;
    if (!row.path.length) {
      target.innerHTML = '';
      target.append(
        el('div', {
          class: 'empty',
          text: 'This shift sealed without a single position, so there is no path to draw.',
        })
      );
      return;
    }
    drawerMap = PMMap.create(target);
    const points = row.path.map((p) => ({ lat: p.lat, lng: p.lng, at: p.at, accuracy: p.accuracy }));

    // The fence first, so the path draws over it rather than under.
    if (row.site && row.site.fence) {
      PMMap.siteCircle(drawerMap, {
        lat: row.site.fence.lat,
        lng: row.site.fence.lng,
        radius: row.site.fence.radius,
        radiusIsAuthoritative: row.site.fence.radius !== null && row.site.fence.radius !== undefined,
        label: row.site.displayName || row.site.name || 'Site ' + row.site.siteId,
      });
    }
    PMMap.track(drawerMap, points, { dots: true });
    PMMap.fit(drawerMap, points.concat(row.site && row.site.fence ? [row.site.fence] : []));
  }
})();
