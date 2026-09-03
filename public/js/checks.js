/* Geofence Checks: every clock-in validation call, with the geometry recomputed
   next to what the API decided. This is where accuracy padding gets audited. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let rows = [];
  let total = 0;

  PM.boot('checks.html', async ({ root, meta }) => {
    const siteOptions = PM.optionsFrom(meta.logSites || [], 'id', 'id', 'validations').map((o) => ({
      ...o,
      label: o.value === 'null' ? 'unmapped' : 'Site ' + o.label,
    }));

    PM.buildFilterBar(() => [
      { kind: 'daterange' },
      { kind: 'multi', key: 'userId', label: 'User', options: PM.optionsFrom(meta.logUsers || [], 'id', 'id', 'validations') },
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: siteOptions },
      {
        kind: 'multi',
        key: 'verdict',
        label: 'Recomputed verdict',
        options: [
          { value: 'in', label: 'Inside' },
          { value: 'out', label: 'Outside' },
          { value: 'unknown', label: 'Uncertain' },
        ],
      },
      { kind: 'multi', key: 'accuracyBand', label: 'Accuracy band', options: PM.optionsFrom(meta.accuracyBands || [], 'key', 'label') },
      { kind: 'tri', key: 'withinRadius', label: 'Reported within', yes: 'Within', no: 'Outside' },
      { kind: 'tri', key: 'actualWithinRadius', label: 'Geometry within', yes: 'Within', no: 'Outside' },
      { kind: 'tri', key: 'mismatch', label: 'Grace applied', yes: 'Only these', no: 'Exclude' },
      { kind: 'tri', key: 'triggeredClockOut', label: 'Auto clock-out', yes: 'Only these', no: 'Exclude' },
      { kind: 'tri', key: 'unmapped', label: 'Unmapped', yes: 'Only these', no: 'Exclude' },
      { kind: 'number', key: 'accuracyMax', label: 'Accuracy <= m' },
      { kind: 'number', key: 'accuracyMin', label: 'Accuracy >= m' },
      { kind: 'number', key: 'outsideCountMin', label: 'Outside streak >=' },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'address, user id, site id' },
    ]);

    root.append(
      el('div', { class: 'tiles', id: 'check-tiles' }),
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { text: 'Accuracy against distance from the boundary' }),
            el('span', { class: 'sub', text: 'Points left of the line are inside the fence' }),
          ]),
          el('div', { class: 'card-body' }, [
            el('div', { class: 'chart-wrap tall' }, [el('canvas', { id: 'chart-scatter' })]),
            el('div', {
              html: PMChart.legend([
                { color: C.in, label: 'Inside' },
                { color: C.out, label: 'Outside' },
                { color: C.warning, label: 'Uncertain' },
              ]),
            }),
            el('div', {
              class: 'hint',
              text: 'A point near the line with a tall accuracy value is a coin-flip verdict: the fix cannot resolve which side of the fence the device is on.',
            }),
          ]),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [el('h2', { text: 'Checks over time' })]),
          el('div', { class: 'card-body' }, [
            el('div', { class: 'chart-wrap tall' }, [el('canvas', { id: 'chart-time' })]),
            el('div', {
              html: PMChart.legend([
                { color: C.in, label: 'Passed' },
                { color: C.out, label: 'Failed geometry' },
                { color: C.series[3], label: 'Auto clock-outs' },
              ]),
            }),
          ]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Validation calls' }),
          el('span', { class: 'sub', id: 'table-sub' }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm', text: '↓ CSV', onclick: () => window.open('/api/logs.csv?' + queryString(), '_blank') }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'checks-table' })]),
        el('div', { class: 'pager', id: 'pager' }),
      ])
    );

    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  async function load() {
    PM.showSkeleton({
      '#check-tiles': 'tiles:5',
      '#chart-scatter': 'chart',
      '#chart-time': 'chart',
      '#checks-table': 'table:10x8',
    });
    const qs = queryString();
    const [data, stats] = await Promise.all([api('/api/logs?' + qs), api('/api/stats?' + qs)]);
    rows = data.rows || [];
    total = data.total || 0;
    renderTiles(stats.geofenceChecks, data);
    renderCharts(stats);
    renderTable();
    PM.setSubtitle(fmt.int(total) + ' validation calls match');
    PM.markLoaded();
  }

  function renderTiles(g, data) {
    const host = document.querySelector('#check-tiles');
    host.innerHTML = '';
    const tile = (label, value, note, tone) =>
      el('div', { class: 'tile ' + (tone ? 'is-' + tone : '') }, [
        el('div', { class: 'tile-label', text: label }),
        el('div', { class: 'tile-value', text: value }),
        el('div', { class: 'tile-note', text: note }),
      ]);
    if (!g) {
      host.append(el('div', { class: 'empty', text: 'No geofence check collection available.' }));
      return;
    }
    const uncertain = rows.filter((r) => r.verdict === 'unknown').length;
    host.append(
      tile('Checks matched', fmt.int(total), 'showing ' + rows.length + ' on this page'),
      tile('Compliance', fmt.pct(g.complianceRate), fmt.int(g.actualOutside) + ' failed the geometry', g.complianceRate < 95 ? 'warning' : 'good'),
      tile('Accuracy grace saves', fmt.int(g.grace), 'avg padding ' + fmt.metres(g.avgRadiusPadding), g.grace ? 'warning' : undefined),
      tile('Auto clock-outs', fmt.int(g.clockOuts), 'device left the fence', g.clockOuts ? 'serious' : undefined),
      tile('Uncertain on this page', fmt.int(uncertain), 'accuracy overlaps the boundary', uncertain ? 'warning' : undefined),
      tile('Unmapped clock-ins', fmt.int(g.unmapped), 'no fence attached'),
      tile('Avg accuracy', fmt.accuracy(g.avgAccuracy), 'worst ' + fmt.accuracy(g.worstAccuracy)),
      tile('Longest outside streak', fmt.int(g.maxOutsideCount), 'consecutive failed checks', g.maxOutsideCount > 1 ? 'warning' : undefined)
    );
  }

  function renderCharts(stats) {
    const groups = { in: [], out: [], unknown: [] };
    for (const row of rows) {
      if (!row.relation || row.accuracy === null) continue;
      (groups[row.verdict] || groups.unknown).push({
        x: row.relation.distanceFromBoundary,
        y: row.accuracy,
        label: (row.siteId != null ? 'Site ' + row.siteId : 'unmapped') + ' · user ' + row.userId + ' · ' + fmt.dayTime(row.capturedAt),
      });
    }
    PMChart.scatter(document.querySelector('#chart-scatter'), {
      xTitle: 'metres from fence boundary (negative = inside)',
      yTitle: 'GPS accuracy (m)',
      points: [
        { label: 'Inside', data: groups.in, color: C.in },
        { label: 'Outside', data: groups.out, color: C.out },
        { label: 'Uncertain', data: groups.unknown, color: C.warning },
      ],
    });

    const timeline = PM.padBuckets(stats.geofenceTimeline || [], stats.granularity, {
      zero: ['total', 'within', 'outside', 'clockOuts'],
      nulls: ['avgAccuracy'],
    });
    PMChart.stackedTime(document.querySelector('#chart-time'), {
      labels: timeline.map((t) => fmt.dayTime(t.at)),
      yTitle: 'checks',
      datasets: [
        { label: 'Passed', data: timeline.map((t) => t.within), color: C.in },
        { label: 'Failed geometry', data: timeline.map((t) => t.outside), color: C.out },
        { label: 'Auto clock-outs', data: timeline.map((t) => t.clockOuts), color: C.series[3] },
      ],
    });
  }

  function renderTable() {
    const host = document.querySelector('#checks-table');
    host.innerHTML = '';
    if (!rows.length) {
      host.append(el('div', { class: 'empty', text: 'No validation calls match these filters.' }));
      document.querySelector('#pager').innerHTML = '';
      return;
    }
    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>When</th><th>User</th><th>Site</th><th class="num">Accuracy</th><th class="num">From centre</th><th class="num">From boundary</th><th>Reported</th><th>Geometry</th><th>Recomputed</th><th>Outcome</th></tr></thead>';
    const body = el('tbody');
    for (const row of rows) {
      body.append(
        el('tr', {
          class: 'clickable',
          onclick: () => openDetail(row),
          html:
            '<td>' + fmt.dayTime(row.capturedAt) + '<div class="person-sub">' + fmt.ago(row.capturedAt) + '</div></td>' +
            '<td>' + (row.userId === null ? '--' : row.userId) + '</td>' +
            '<td>' +
            (row.siteId != null
              ? 'Site ' + row.siteId + '<div class="person-sub" title="' + esc(row.siteAddress || '') + '">' + esc(row.siteAddress || '') + '</div>'
              : '<span class="badge badge-neutral">unmapped</span>') +
            '</td>' +
            '<td class="num">' + PM.accuracyBadge(row.accuracyBand, row.accuracy) + '</td>' +
            '<td class="num">' + (row.relation ? fmt.metres(row.relation.distanceFromCenter) : '--') + '</td>' +
            '<td class="num">' + (row.relation ? (row.relation.inside ? '−' : '+') + fmt.metres(Math.abs(row.relation.distanceFromBoundary)) : '--') + '</td>' +
            '<td>' + (row.isWithinRadius === null ? '--' : row.isWithinRadius ? '<span class="badge badge-good">within</span>' : '<span class="badge badge-critical">outside</span>') + '</td>' +
            '<td>' + (row.actualIsWithinRadius === null ? '--' : row.actualIsWithinRadius ? '<span class="badge badge-good">within</span>' : '<span class="badge badge-critical">outside</span>') + (row.graceApplied ? '<div class="person-sub">grace +' + fmt.metres(row.radiusPadding) + '</div>' : '') + '</td>' +
            '<td>' + PM.geofenceBadge(null, row.verdict, row.verdictReason) + '</td>' +
            '<td>' + (row.triggeredClockOut ? '<span class="badge badge-serious">auto clock-out</span>' : row.outsideCount ? '<span class="badge badge-warning">streak ' + row.outsideCount + '</span>' : '<span class="badge badge-neutral">no action</span>') + '</td>',
        })
      );
    }
    table.append(body);
    host.append(table);

    const page = Number(PM.state.filters.page || 1);
    const limit = Number(PM.state.filters.limit || 100);
    const pager = document.querySelector('#pager');
    pager.innerHTML = '';
    pager.append(
      el('span', { text: 'Showing ' + rows.length + ' of ' + fmt.int(total) }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', text: '← Previous', disabled: page <= 1 ? 'disabled' : null, onclick: () => PM.setFilter('page', String(page - 1)) }),
      el('span', { text: 'Page ' + page }),
      el('button', { class: 'btn btn-sm', text: 'Next →', disabled: page * limit >= total ? 'disabled' : null, onclick: () => PM.setFilter('page', String(page + 1)) })
    );
    document.querySelector('#table-sub').textContent = 'click a row to see the fix on a map with the fence';
  }

  function openDetail(row) {
    PM.openDrawer({
      title: (row.siteId != null ? 'Site ' + row.siteId : 'Unmapped') + ' check · user ' + row.userId,
      subtitle: fmt.date(row.capturedAt) + ' · ' + (row.siteAddress || 'no address on record'),
      tabs: [
        {
          id: 'map',
          label: 'Fix & fence',
          render: (host) => {
            const mapHost = el('div', { class: 'map mini', style: 'height:320px' });
            host.append(mapHost, el('div', { html: PMMap.legend() }));
            const map = PMMap.create(mapHost);
            setTimeout(() => map.invalidateSize(), 60);
            // Same fence-provenance trap as the exit-window replay: this fence
            // came out of the geofence log itself (siteArea.locations), which is
            // the most authoritative radius in the store, but siteCircle only
            // draws a boundary when told the radius is on record. Spread from
            // row.fence it never was, so the check that this whole page audits
            // was drawn against a dashed grey 40 m guess.
            const framePoints = [];
            if (row.fence) {
              const drawn = PMMap.siteCircle(map, {
                ...row.fence,
                siteId: row.siteId,
                address: row.siteAddress,
                radiusIsAuthoritative: row.fence.radius !== null && row.fence.radius !== undefined,
                hasFence: row.fence.radius !== null && row.fence.radius !== undefined,
                centreConfidence: 'recorded',
                // The padded radius the API actually judged against, shown in
                // the popup next to the fence it was padded from.
                effectiveRadius: row.effectiveRadius,
              });
              framePoints.push(row.fence);
              if (drawn) framePoints.push(...drawn.extent);
            }
            if (row.location) {
              PMMap.deviceMarker(
                map,
                {
                  name: 'User ' + row.userId,
                  location: row.location,
                  accuracy: row.accuracy,
                  computedVerdict: row.verdict,
                  verdictReason: row.verdictReason,
                  isInsideGeofence: row.actualIsWithinRadius,
                  relation: row.relation,
                  jobSiteId: row.siteId,
                  capturedAt: row.capturedAt,
                  deviceType: null,
                  battery: null,
                  clockedIn: !row.triggeredClockOut,
                  site: { address: row.siteAddress },
                },
                { permanentLabel: true, pulse: true }
              );
              if (row.fence && row.relation && !row.relation.inside) {
                PMMap.guideLine(map, row.location, row.fence, {
                  text: fmt.metres(row.relation.distanceFromBoundary) + ' outside · head ' + (row.relation.compass ? oppositeCompass(row.relation.compass) : ''),
                });
              }
            }
            // Outside the `if (row.location)` it used to live in: a check with a
            // fence but no usable fix left the map on the world view, which is
            // the one case where you most want to see the fence on its own.
            if (row.location) framePoints.push(row.location);
            PMMap.fit(map, framePoints, { zoom: 17 });
            host.append(
              el('div', { class: 'section-title', text: 'Effective radius' }),
              PM.kv([
                ['Fence radius', row.fence && row.fence.radius != null ? fmt.metres(row.fence.radius) : 'not on record'],
                ['Accuracy padding', row.radiusPadding === null ? '--' : '+' + fmt.metres(row.radiusPadding)],
                ['Effective radius used', row.effectiveRadius === null ? '--' : fmt.metres(row.effectiveRadius)],
                ['Distance from centre', row.relation ? fmt.metres(row.relation.distanceFromCenter) : '--'],
                [
                  'Why it matters',
                  row.graceApplied
                    ? 'The raw geometry put this fix outside the fence; the accuracy padding is the only reason it counted as inside.'
                    : 'The verdict does not depend on the accuracy padding here.',
                ],
              ])
            );
          },
        },
        {
          id: 'detail',
          label: 'Decision',
          render: (host) =>
            host.append(
              PM.kv([
                ['Logged at', fmt.date(row.capturedAt)],
                ['Device timestamp', fmt.date(row.deviceTimestamp)],
                ['User', String(row.userId)],
                ['Time entry', row.timeEntryId === null ? '--' : '#' + row.timeEntryId],
                ['Coordinates', fmt.coords(row.location)],
                ['Accuracy', PM.accuracyBadge(row.accuracyBand, row.accuracy)],
                ['Reported within radius', fmt.bool(row.isWithinRadius)],
                ['Geometry within radius', fmt.bool(row.actualIsWithinRadius)],
                ['Accuracy grace applied', fmt.bool(row.graceApplied)],
                ['Recomputed verdict', row.verdict + (row.verdictReason ? ' - ' + row.verdictReason : '')],
                ['Consecutive outside count', String(row.outsideCount)],
                ['Triggered clock-out', fmt.bool(row.triggeredClockOut)],
                ['Unmapped clock-in', fmt.bool(row.unmapped)],
                row.unmappedEntry
                  ? ['Unmapped entry', '#' + row.unmappedEntry.id + ' · clock in ' + fmt.date(row.unmappedEntry.clockIn) + ' · ' + (row.unmappedEntry.networkStatus || '')]
                  : undefined,
                ['Site address', row.siteAddress || '--'],
              ])
            ),
        },
        {
          id: 'raw',
          label: 'Raw document',
          render: (host) => {
            const pre = el('pre', { class: 'json', text: 'loading...' });
            host.append(pre);
            api('/api/logs/' + row.id)
              .then((data) => {
                pre.innerHTML = PM.jsonHighlight(data.raw);
              })
              .catch((err) => {
                pre.textContent = err.message;
              });
          },
        },
      ],
    });
  }

  function oppositeCompass(compass) {
    const map = { N: 'S', S: 'N', E: 'W', W: 'E' };
    return compass
      .split('')
      .map((c) => map[c] || c)
      .join('');
  }
})();
