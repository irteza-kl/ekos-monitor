/* Exit Windows: the grace period that opens when a device leaves its fence.
   Each window is a decision with evidence - samples, accuracy, and outcome.

   Filters, KPI tiles, charts and the pager live here; the table itself and the
   row drawer come from PMExitWindows (js/exitwindows.view.js), so the same
   view serves the Exit windows tab on a user page. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let rows = [];
  let total = 0;

  const { resolutionLabel } = PMExitWindows;

  PM.boot('exit-windows.html', async ({ root, meta }) => {
    const ew = meta.exitWindows || {};

    PM.buildFilterBar([
      { kind: 'daterange' },
      {
        kind: 'multi',
        key: 'userId',
        label: 'User (matched)',
        options: PM.optionsFrom(meta.users || [], 'id', 'name', 'snapshots'),
      },
      { kind: 'multi', key: 'status', label: 'Status', options: PM.optionsFrom(ew.statuses || [], 'key', 'key', 'count') },
      {
        kind: 'multi',
        key: 'resolution',
        label: 'Resolution',
        options: (ew.resolutions || []).map((r) => ({ value: r.key, label: resolutionLabel(r.key), count: r.count })),
      },
      { kind: 'multi', key: 'openedBy', label: 'Opened by', options: PM.optionsFrom(ew.openedBy || [], 'key', 'key', 'count') },
      { kind: 'multi', key: 'deviceType', label: 'Device', options: PM.optionsFrom(ew.deviceTypes || [], 'key', 'key', 'count') },
      {
        kind: 'multi',
        key: 'jobSiteId',
        label: 'Site',
        options: (meta.sites || [])
          .filter((site) => site.siteId !== null && site.siteId !== undefined)
          .map((site) => ({ value: site.siteId, label: 'Site ' + site.siteId + (site.address ? ' - ' + site.address.slice(0, 24) : '') })),
      },
      {
        kind: 'multi',
        key: 'verdict',
        label: 'Contains sample',
        options: [
          { value: 'out', label: 'Outside' },
          { value: 'in', label: 'Inside' },
          { value: 'unknown', label: 'Uncertain' },
        ],
      },
      { kind: 'number', key: 'minSamples', label: 'Samples >=' },
      { kind: 'number', key: 'minDistance', label: 'Distance >= m' },
      { kind: 'number', key: 'minDurationMinutes', label: 'Duration >= min' },
      { kind: 'number', key: 'accuracyMax', label: 'Avg accuracy <= m' },
      { kind: 'tri', key: 'hasUnknown', label: 'Has uncertain samples', yes: 'Only these' },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'window id, employee, device' },
    ]);

    root.append(
      el('div', { id: 'sample-banner' }),
      el('div', { class: 'tiles', id: 'ew-tiles' }),
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { text: 'Windows opened over time' }),
            el('span', { class: 'sub', text: 'and how many ended in an automatic clock-out' }),
          ]),
          el('div', { class: 'card-body' }, [
            el('div', { class: 'chart-wrap' }, [el('canvas', { id: 'ew-timeline' })]),
            el('div', {
              html: PMChart.legend([
                { color: C.series[0], label: 'Windows opened' },
                { color: C.series[3], label: 'Ended in auto clock-out' },
              ]),
            }),
          ]),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { text: 'Sample verdicts' }),
            el('span', { class: 'sub', text: 'across every window in range' }),
          ]),
          el('div', { class: 'card-body' }, [
            el('div', { class: 'chart-wrap' }, [el('canvas', { id: 'ew-verdicts' })]),
            el('div', {
              class: 'hint',
              text: 'Uncertain samples are fixes whose accuracy circle crosses the fence boundary - the device cannot honestly be called in or out.',
            }),
          ]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Exit windows' }),
          el('span', { class: 'sub', id: 'ew-sub' }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm', text: '↓ CSV', onclick: () => window.open('/api/exit-windows.csv?' + queryString(), '_blank') }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'ew-table' })]),
        el('div', { class: 'pager', id: 'pager' }),
      ])
    );

    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  async function load() {
    const qs = queryString();
    const [data, stats] = await Promise.all([api('/api/exit-windows?' + qs), api('/api/stats?' + qs)]);
    rows = data.rows || [];
    total = data.total || 0;

    renderBanner(data);
    if (data.unavailable) {
      document.querySelector('#ew-tiles').innerHTML = '';
      document.querySelector('#ew-table').innerHTML = '';
      PM.setSubtitle('collection not present');
      PM.markLoaded();
      return;
    }
    renderTiles(stats.exitWindows || {});
    renderCharts(stats.exitWindows || {}, stats.granularity);
    renderTable();
    PM.setSubtitle(fmt.int(total) + ' windows match');
    PM.markLoaded();
  }

  function renderBanner(data) {
    const host = document.querySelector('#sample-banner');
    host.innerHTML = '';
    if (data.unavailable) {
      host.append(
        el('div', {
          class: 'notice',
          html:
            '<span>⚠</span><span><b>No exit-window data.</b> ' + esc(data.unavailable) + '</span>',
        })
      );
      return;
    }
    const anon = ((PM.state.meta || {}).exitWindows || {}).anonymousWindows || 0;
    const noUsers = !(((PM.state.meta || {}).exitWindows || {}).users || []).length;
    if (!anon || !noUsers) return;
    const attributed = rows.filter((r) => r.attribution && r.attribution.userId !== null).length;
    host.append(
      el('div', {
        class: 'notice',
        html:
          '<span>ℹ</span><span><b>These windows carry <code>userId: null</code></b> - the app writes them without a ' +
          'session, so there is no id to join on. ' +
          attributed +
          ' of ' +
          rows.length +
          ' on this page are matched to a person by comparing each window’s own GPS samples against the heartbeat ' +
          'stream: a heartbeat within 150 m and 180 s of a sample is the same handset. The badge in the user column ' +
          'says how strong each match is, and hovering it shows the evidence. A window whose id is ever populated ' +
          'joins exactly instead.</span>',
      })
    );
  }
  function renderTiles(s) {
    const host = document.querySelector('#ew-tiles');
    host.innerHTML = '';
    const tile = (label, value, note, tone) =>
      el('div', { class: 'tile ' + (tone ? 'is-' + tone : '') }, [
        el('div', { class: 'tile-label', text: label }),
        el('div', { class: 'tile-value', text: value }),
        el('div', { class: 'tile-note', text: note }),
      ]);
    const samples = s.samples || { in: 0, out: 0, unknown: 0 };
    const totalSamples = samples.in + samples.out + samples.unknown;
    host.append(
      tile(
        'Windows',
        fmt.int(s.total),
        s.users ? fmt.int(s.users) + ' user(s) involved' : 'no session ids on these documents'
      ),
      tile('Still open', fmt.int(s.open), 'grace period running', s.open ? 'warning' : undefined),
      tile('Expired', fmt.int(s.expired), 'closed without a signal', s.expired ? 'serious' : undefined),
      tile('Auto clock-outs', fmt.int(s.clockOuts), 'device never came back', s.clockOuts ? 'critical' : undefined),
      tile('Returned inside', fmt.int(s.returned), 'walked back into the fence', s.returned ? 'good' : undefined),
      tile('Needs review', fmt.int(s.needsReview), 'resolution flagged for a human', s.needsReview ? 'warning' : undefined),
      tile('Avg duration', fmt.duration(s.avgDurationMinutes), 'open to resolved'),
      tile('Avg samples', fmt.num(s.avgSamples, 1), 'fixes collected per window'),
      tile(
        'Uncertain samples',
        totalSamples ? fmt.pct((100 * samples.unknown) / totalSamples) : '--',
        fmt.int(samples.unknown) + ' of ' + fmt.int(totalSamples) + ' fixes',
        samples.unknown / (totalSamples || 1) > 0.15 ? 'warning' : undefined
      ),
      tile('Furthest outside', fmt.metres(s.maxDistanceFromBoundary), 'past the boundary'),
      tile('Avg accuracy', fmt.accuracy(s.avgAccuracy), 'mean of per-window averages')
    );
  }

  function renderCharts(s, granularity) {
    // The server picks the bucket size from the range (15 minutes on a short one),
    // so pad at whatever it actually used - a hardcoded 'hour' silently skips padding.
    const timeline = PM.padBuckets(s.timeline || [], granularity, { zero: ['count', 'clockOuts'] });
    PMChart.lineTime(document.querySelector('#ew-timeline'), {
      labels: timeline.map((t) => fmt.dayTime(t.at)),
      yTitle: 'windows',
      series: [
        { label: 'Windows opened', data: timeline.map((t) => t.count), color: C.series[0] },
        { label: 'Auto clock-outs', data: timeline.map((t) => t.clockOuts), color: C.series[3], dashed: true },
      ],
    });

    const samples = s.samples || { in: 0, out: 0, unknown: 0 };
    PMChart.bars(document.querySelector('#ew-verdicts'), {
      labels: ['Inside', 'Outside', 'Uncertain'],
      values: [samples.in, samples.out, samples.unknown],
      color: C.in,
      horizontal: true,
      unit: 'samples',
    });
  }

  function renderTable() {
    PMExitWindows.table(document.querySelector('#ew-table'), rows);

    const pager = document.querySelector('#pager');
    pager.innerHTML = '';
    if (!rows.length) return;
    const page = Number(PM.state.filters.page || 1);
    const limit = Number(PM.state.filters.limit || 50);
    pager.append(
      el('span', { text: 'Showing ' + rows.length + ' of ' + fmt.int(total) }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', text: '← Previous', disabled: page <= 1 ? 'disabled' : null, onclick: () => PM.setFilter('page', String(page - 1)) }),
      el('span', { text: 'Page ' + page }),
      el('button', { class: 'btn btn-sm', text: 'Next →', disabled: page * limit >= total ? 'disabled' : null, onclick: () => PM.setFilter('page', String(page + 1)) })
    );
    document.querySelector('#ew-sub').textContent = 'click a window to replay the samples on a map';
  }
})();
