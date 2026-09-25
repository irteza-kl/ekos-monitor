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
  const { el, fmt, api, queryString } = PM;
  const C = PM.colors;
  // The table, the cells and the drawer live in PMShiftTrails, because the
  // "Shift trails" tab on a user page is this same table filtered to one
  // person. What stays here is page-level: the filter bar, the tiles, the
  // chart and the pager.
  const { siteLabel, PERMISSION_LABEL, PRECISION_LABEL } = PMShiftTrails;

  let rows = [];
  let total = 0;
  let trailMeta = { available: false, users: [], sites: [], devices: [], permissions: [], precisions: [] };

  PM.boot('shift-trails.html', async ({ root }) => {
    PM.buildFilterBar(() =>
      [
        { kind: 'daterange' },
        { kind: 'multi', key: 'tenantId', label: 'Tenant', options: PM.tenantOptions(trailMeta.tenants) },
        {
          kind: 'multi',
          key: 'userId',
          label: 'User',
          options: (trailMeta.users || []).map((u) => ({
            value: u.id,
            label: (u.name || 'User ' + u.id) + (u.heartbeatKnown ? '' : ' · trails only'),
            count: u.count,
            byTenant: u.byTenant,
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
            byTenant: s.byTenant,
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
            byTenant: p.byTenant,
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
            byTenant: p.byTenant,
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
        s.runtimeStarts ? 'warning' : undefined
      ),
      tile(
        'Gaps',
        fmt.int(s.gaps),
        'the app was awake but blind',
        s.gaps ? 'critical' : undefined
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

  function renderTable(data) {
    const host = document.querySelector('#st-table');
    // The table itself is PMShiftTrails' - the same one the user page tab
    // shows - so this decides only what an empty result means here, and owns
    // the pager, which is a property of this page's filter bar and not of the
    // rows.
    PMShiftTrails.table(host, rows, {
      empty: el('div', { class: 'empty', text: 'No shift trails match these filters, in ' + PM.rangeLabel() + '.' }),
    });
    if (!rows.length) {
      document.querySelector('#pager').innerHTML = '';
      return;
    }

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
})();
