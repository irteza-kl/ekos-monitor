/* ==========================================================================
   Exit windows as a reusable view: the table, the badges, and the row drawer.

   The Exit Windows page and the "Exit windows" tab on a user page show the same
   documents, so they show them the same way - one table definition, one drawer,
   one set of badges. Two renderings of the same thing drift apart; the user page
   used to carry a thinner nine-column copy that could not be opened.

   The page keeps what is genuinely page-level: filters, KPI tiles, charts and
   the pager.
   ========================================================================== */
window.PMExitWindows = (function () {
  'use strict';

  const { el, fmt, api, esc } = PM;
  const C = PM.colors;

  const RESOLUTION_LABELS = {
    closed_clockout: 'Auto clock-out',
    closed_returned: 'Returned inside',
    closed_manual: 'Closed manually',
    expired_no_signal: 'Expired, no signal',
    needs_review: 'Needs review',
    null: 'Still open',
  };

  const CONFIDENCE_LABEL = {
    certain: 'exact',
    high: 'high confidence',
    likely: 'likely',
    ambiguous: 'ambiguous',
    none: 'no match',
  };

  /** Any resolution the app invents later still reads sensibly. */
  function resolutionLabel(key) {
    if (key === null || key === undefined) return RESOLUTION_LABELS.null;
    if (RESOLUTION_LABELS[key]) return RESOLUTION_LABELS[key];
    const words = String(key).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function statusBadge(row) {
    if (row.status === 'open') return '<span class="badge badge-warning">◐ Open</span>';
    if (row.status === 'expired') return '<span class="badge badge-serious">⧗ Expired</span>';
    if (row.resolution === 'needs_review') return '<span class="badge badge-warning">⚑ Needs review</span>';
    if (row.resolution === 'closed_clockout') return '<span class="badge badge-critical">▲ Auto clock-out</span>';
    if (row.resolution === 'closed_returned') return '<span class="badge badge-good">● Returned</span>';
    return '<span class="badge badge-neutral">✓ ' + esc(resolutionLabel(row.resolution)) + '</span>';
  }

  /**
   * Who this window belongs to. The documents carry userId: null, so the link is
   * either exact (the document named someone) or inferred from heartbeats - and
   * the badge always says which, with the evidence in its tooltip.
   */
  function attributionCell(row) {
    const a = row.attribution;
    if (!a || a.method === 'none' || (a.userId === null && a.method !== 'userId')) {
      const candidates = a && a.candidates && a.candidates.length ? a.candidates : null;
      if (candidates) {
        // person-sub is a single ellipsised line, so the full list goes in the
        // tooltip too - otherwise the names past the first are unrecoverable.
        const names = candidates.map((c) => c.name || 'user ' + c.userId).join(', ');
        return (
          '<span class="badge badge-warning" title="' + esc(a.note || '') + '">≈ ' + candidates.length + ' candidates</span>' +
          '<div class="person-sub" title="' + esc(names) + '">' + esc(names) + '</div>'
        );
      }
      return (
        '<span class="badge badge-neutral" title="' + esc((a && a.note) || 'the document carries userId: null') + '">no match</span>'
      );
    }

    const exact = a.method === 'userId';
    const cls = exact ? 'badge-good' : a.confidence === 'high' ? 'badge-info' : 'badge-warning';
    const label = exact ? 'exact' : '≈ ' + (CONFIDENCE_LABEL[a.confidence] || a.confidence);
    const href = '/user.html?userId=' + encodeURIComponent(a.userId);
    return (
      '<a href="' + href + '">' + esc(a.name || 'user ' + a.userId) + '</a>' +
      '<div class="person-sub"><span class="badge ' + cls + '" title="' + esc(a.note || '') + '">' + label + '</span></div>'
    );
  }

  function methodLabel(method) {
    if (method === 'userId') return 'exact - the document named a user';
    if (method === 'sample-match') return 'inferred - window samples matched this user’s heartbeats';
    if (method === 'fence-presence') return 'inferred - this user was at the fence during the window';
    return 'none';
  }

  function segment(value, total, color) {
    const pct = total ? (100 * value) / total : 0;
    return '<span style="height:5px;border-radius:2px;background:' + color + ';width:' + pct.toFixed(1) + '%;min-width:' + (value ? 3 : 0) + 'px"></span>';
  }

  // ------------------------------------------------------------------ table --
  /**
   * The windows table. `host` is emptied first. Options:
   *   empty  - what to say when there is nothing (a string or a node)
   *   onOpen - called after a row opens its drawer (the page uses none)
   */
  function table(host, rows, opts) {
    const options = opts || {};
    host.innerHTML = '';
    if (!(rows || []).length) {
      if (options.empty && options.empty.nodeType) host.append(options.empty);
      else host.append(el('div', { class: 'empty', text: options.empty || 'No exit windows match these filters.' }));
      return;
    }

    const node = el('table');
    node.innerHTML =
      '<thead><tr><th>Window</th><th>User</th><th>Site</th><th>Opened by</th><th>Outcome</th>' +
      '<th class="num">Duration</th><th>Samples (in/out/uncertain)</th><th class="num">Furthest out</th>' +
      '<th class="num">Avg accuracy</th><th>Device</th><th>Opened</th></tr></thead>';
    const body = el('tbody');
    for (const row of rows) {
      const v = row.stats.verdicts;
      const totalSamples = row.stats.sampleCount || 1;
      body.append(
        el('tr', {
          class: 'clickable',
          title: 'Open this window',
          onclick: (event) => {
            // The matched user is a real link out of here.
            if (event.target.closest('a')) return;
            openDetail(row);
            if (options.onOpen) options.onOpen(row);
          },
          html:
            '<td class="mono">' + esc(row.id) + '<div class="person-sub">seq ' + row.seq + ' · rev ' + row.rev + '</div></td>' +
            '<td>' + attributionCell(row) + '</td>' +
            '<td>' +
            (row.site
              ? 'Site ' + row.site.siteId +
                ' <span class="badge badge-info" title="matched by fence centre, ±' + row.site.matchDistance + ' m - the document has no site id">≈</span>'
              : '<span class="badge badge-neutral" title="no known site has this fence centre and radius">unmapped fence</span>') +
            '<div class="person-sub" title="' + esc(row.siteAddress || '') + '">' +
            esc(row.siteAddress || (row.fence ? fmt.coords(row.fence) + ' · r ' + fmt.metres(row.fence.radius) : '')) +
            '</div></td>' +
            '<td><span class="badge badge-neutral">' + esc(row.openedBy || '?') + '</span></td>' +
            '<td>' + statusBadge(row) + '</td>' +
            '<td class="num">' + fmt.duration(row.stats.durationMinutes) + '</td>' +
            '<td><span style="font-variant-numeric:tabular-nums">' + v.in + ' / ' + v.out + ' / ' + v.unknown + '</span>' +
            '<div style="display:flex;gap:2px;margin-top:4px">' +
            segment(v.in, totalSamples, C.in) + segment(v.out, totalSamples, C.out) + segment(v.unknown, totalSamples, C.warning) +
            '</div></td>' +
            '<td class="num">' + fmt.metres(row.stats.maxDistanceFromBoundary) + '</td>' +
            '<td class="num">' + fmt.accuracy(row.stats.avgAccuracy) + '</td>' +
            '<td>' + esc(row.deviceType || '?') + '<div class="person-sub">' +
            (row.battery === null ? '' : 'battery ' + row.battery + '%') + (row.offline ? ' · offline' : '') + '</div></td>' +
            '<td>' + fmt.dayTime(row.openedAt) + '<div class="person-sub">' + fmt.ago(row.openedAt) + '</div></td>',
        })
      );
    }
    node.append(body);
    host.append(el('div', { class: 'table-scroll' }, [node]));
  }

  // ----------------------------------------------------------------- drawer --
  function openDetail(row) {
    PM.openDrawer({
      title: 'Exit window ' + row.id,
      subtitle:
        (row.employeeRef ? row.employeeRef + ' · ' : '') +
        (row.userId === null ? 'no session (userId null)' : 'user ' + row.userId) +
        ' · ' + (row.jobSiteId != null ? 'site ' + row.jobSiteId : 'unmapped') +
        ' · opened ' + fmt.date(row.openedAt),
      tabs: [
        { id: 'replay', label: 'Replay', render: (host) => renderReplay(host, row) },
        { id: 'evidence', label: 'Evidence', render: (host) => renderEvidence(host, row) },
        { id: 'samples', label: 'Samples (' + row.stats.sampleCount + ')', render: (host) => renderSamples(host, row) },
        { id: 'raw', label: 'Raw document', render: (host) => renderRaw(host, row) },
      ],
    });
  }

  function renderReplay(host, row) {
    const mapHost = el('div', { class: 'map mini', style: 'height:330px' });
    host.append(
      el('div', { class: 'section-title', text: 'Where the device went while the window was open' }),
      mapHost,
      el('div', { html: PMMap.legend() })
    );
    const map = PMMap.create(mapHost);
    setTimeout(() => map.invalidateSize(), 60);

    const points = [];
    if (row.fence) {
      // The window document carries the fence the device was actually judged
      // against - centre and radius both. That is a boundary on record, so it
      // has to be declared as one: siteCircle only draws a real fence when
      // `radiusIsAuthoritative` is set, and this object was built by spreading
      // row.fence, which has no such field. The result was a dashed grey 40 m
      // "estimated centre" ring drawn where a 200 m fence belonged - the site
      // name and address resolved fine, so the geofence looked simply missing.
      // A radius from the window itself is on record. Without one there is no
      // boundary to claim, and the dashed estimate ring is the honest drawing.
      const onRecord = row.fence.radius !== null && row.fence.radius !== undefined;
      const siteId = row.jobSiteId != null ? row.jobSiteId : row.site ? row.site.siteId : null;
      const site = {
        ...(row.site || {}),
        lat: row.fence.lat,
        lng: row.fence.lng,
        radius: row.fence.radius,
        siteId,
        address: row.siteAddress || (row.site ? row.site.address : null),
        label: siteId != null ? 'Site ' + siteId : 'Unmapped fence',
        radiusIsAuthoritative: onRecord,
        hasFence: onRecord,
        fenceOnRecord: onRecord,
        // The centre came off the window document with the radius, so it is
        // recorded whatever the site registry inferred for its own row.
        centreConfidence: onRecord ? 'recorded' : 'unknown',
        centreEstimate: null,
        centreIsEstimate: false,
      };
      const drawn = PMMap.siteCircle(map, site);
      // Frame the fence, not just its centre: every sample in one of these
      // windows sits within a few hundred metres of it, so fitting to the
      // centre point alone zoomed straight past the boundary and left the
      // circle outside the viewport.
      if (drawn) points.push({ lat: row.fence.lat, lng: row.fence.lng }, ...drawn.extent);
      else points.push({ lat: row.fence.lat, lng: row.fence.lng });
    }
    const trail = PMMap.track(map, row.samples);
    if (trail) for (const p of trail.points) points.push(p);

    const last = row.lastSample;
    if (last && row.fence && last.distanceFromBoundary > 0) {
      PMMap.guideLine(map, { lat: last.lat, lng: last.lng }, row.fence, {
        text: fmt.metres(last.distanceFromBoundary) + ' outside · back ' + (last.compass || ''),
      });
    }
    PMMap.fit(map, points);

    host.append(
      el('div', { class: 'section-title', text: 'Guidance' }),
      PM.kv([
        ['Last known fix', last ? fmt.coords(last) + ' · ' + fmt.accuracy(last.accuracy) : '--'],
        ['Distance from boundary', last ? fmt.metres(last.distanceFromBoundary) + (last.distanceFromBoundary > 0 ? ' outside' : ' inside') : '--'],
        ['Direction from fence', last && last.compass ? last.bearing + '° ' + last.compass : '--'],
        ['Total drift', fmt.metres(row.stats.driftMetres)],
        [
          'Walk back',
          last && row.fence
            ? '<a href="https://www.google.com/maps/dir/?api=1&origin=' +
              last.lat + ',' + last.lng +
              '&destination=' + row.fence.lat + ',' + row.fence.lng +
              '&travelmode=walking" target="_blank" rel="noopener">Directions from the last fix to the site ↗</a>'
            : '--',
        ],
      ])
    );
  }

  function renderEvidence(host, row) {
    host.append(
      el('div', { class: 'section-title', text: 'Distance from the fence boundary, sample by sample' }),
      el('div', { class: 'chart-wrap' }, [el('canvas', { id: 'ew-dist' })]),
      el('div', {
        class: 'hint',
        text: 'Above zero is outside the fence. The dashed line is the boundary itself.',
      }),
      el('div', { class: 'section-title', text: 'Reported GPS accuracy per sample' }),
      el('div', { class: 'chart-wrap short' }, [el('canvas', { id: 'ew-acc' })]),
      el('div', { class: 'section-title', text: 'Attribution' }),
      PM.kv([
        ['Document userId', row.userId === null ? 'null - written without a session' : String(row.userId)],
        ['Matched to', row.attribution && row.attribution.userId !== null ? attributionCell(row) : 'nobody'],
        ['Method', row.attribution ? methodLabel(row.attribution.method) : '--'],
        ['Confidence', row.attribution ? CONFIDENCE_LABEL[row.attribution.confidence] || row.attribution.confidence : '--'],
        ['Evidence', row.attribution ? esc(row.attribution.note || '--') : '--'],
        row.attribution && row.attribution.candidates && row.attribution.candidates.length > 1
          ? [
              'Other candidates',
              row.attribution.candidates
                .slice(1)
                .map(
                  (c) =>
                    esc(c.name || 'user ' + c.userId) +
                    ' (' +
                    (c.matchedSamples !== undefined
                      ? c.matchedSamples + ' samples, ' + c.medianDistanceMetres + ' m'
                      : c.matchedMinutes + ' min, ' + c.minDistanceMetres + ' m') +
                    ')'
                )
                .join('<br>'),
            ]
          : undefined,
      ]),
      el('div', { class: 'section-title', text: 'Window facts' }),
      PM.kv([
        ['Status', statusBadge(row)],
        ['Resolution', resolutionLabel(row.resolution)],
        ['Opened by', row.openedBy || '--'],
        ['Opened at', fmt.date(row.openedAt)],
        ['Expires at', fmt.date(row.expiresAt) + (row.expired ? ' (already past)' : '')],
        ['Resolved at', fmt.date(row.resolvedAt)],
        ['Duration', fmt.duration(row.stats.durationMinutes)],
        ['Shift key', row.shiftKey || '--'],
        ['Samples', row.stats.sampleCount + ' (' + row.stats.verdicts.in + ' in / ' + row.stats.verdicts.out + ' out / ' + row.stats.verdicts.unknown + ' uncertain)'],
        ['Consecutive outside at the end', String(row.stats.consecutiveOut)],
        ['Accuracy', 'best ' + fmt.accuracy(row.stats.minAccuracy) + ' · avg ' + fmt.accuracy(row.stats.avgAccuracy) + ' · worst ' + fmt.accuracy(row.stats.maxAccuracy)],
        ['Furthest past the boundary', fmt.metres(row.stats.maxDistanceFromBoundary)],
        row.stats.disagreements
          ? ['⚑ Verdict disagreements', row.stats.disagreements + ' stored sample verdict(s) differ from the recomputed geometry']
          : undefined,
        ['Fence', row.fence ? fmt.coords(row.fence) + ' · radius ' + fmt.metres(row.fence.radius) : '--'],
        [
          'Site',
          row.site
            ? 'Site ' + row.site.siteId + ' - matched by fence centre (±' + row.site.matchDistance + ' m). The document itself carries no site id.'
            : 'No known site has this fence centre and radius, so this window is shown against its raw fence.',
        ],
        ['Site address', row.siteAddress || '--'],
      ]),
      el('div', { class: 'section-title', text: 'Device diagnostics' }),
      PM.kv([
        ['Platform', (row.deviceType || '?') + ' · app ' + (row.appVersion || '?') + ' build ' + (row.buildVersion || '?')],
        ['Device id', row.deviceId || '--'],
        ['Battery', row.battery === null ? '--' : row.battery + '%'],
        ['Location permission', row.permissionStatus || '--'],
        ['Location services', fmt.bool(row.servicesEnabled)],
        ['Connectivity', row.offline ? 'offline while the window was open' : 'online'],
        ['Timezone', (row.timezone || '?') + ' (' + (row.timezoneOffsetMinutes === null ? '?' : row.timezoneOffsetMinutes) + ' min)'],
        ['Pushed to server', fmt.date(row.pushedAt)],
      ])
    );

    const labels = row.samples.map((s) => fmt.time(s.at));
    PMChart.lineTime(document.querySelector('#ew-dist'), {
      labels,
      yTitle: 'metres from boundary',
      beginAtZero: false,
      series: [
        { label: 'Distance from boundary', data: row.samples.map((s) => s.distanceFromBoundary), color: C.series[0] },
        { label: 'Boundary', data: row.samples.map(() => 0), color: C.ink2, dashed: true },
      ],
    });
    PMChart.lineTime(document.querySelector('#ew-acc'), {
      labels,
      yTitle: 'accuracy (m)',
      series: [{ label: 'Accuracy', data: row.samples.map((s) => s.accuracy), color: C.series[3] }],
    });
  }

  function renderSamples(host, row) {
    const node = el('table');
    node.innerHTML =
      '<thead><tr><th>#</th><th>Time</th><th>Coordinates</th><th class="num">Accuracy</th><th class="num">From boundary</th><th>Direction</th><th>Verdict</th></tr></thead>';
    const body = el('tbody');
    row.samples.forEach((s, index) => {
      body.append(
        el('tr', {
          html:
            '<td class="num">' + (index + 1) + '</td>' +
            '<td>' + fmt.time(s.at) + '</td>' +
            '<td class="mono">' + fmt.coords(s) + '</td>' +
            '<td class="num">' + PM.accuracyBadge(s.accuracyBand, s.accuracy) + '</td>' +
            '<td class="num">' + fmt.metres(s.distanceFromBoundary) + '</td>' +
            '<td>' + (s.compass ? s.bearing + '° ' + s.compass : '--') + '</td>' +
            '<td>' + PM.geofenceBadge(null, s.verdict) +
            (s.verdictDisagrees ? ' <span class="badge badge-critical" title="stored verdict differs from recomputed">⚑</span>' : '') +
            '</td>',
        })
      );
    });
    node.append(body);
    host.append(el('div', { class: 'table-scroll' }, [node]));
  }

  function renderRaw(host, row) {
    const pre = el('pre', { class: 'json', text: 'loading...' });
    host.append(pre);
    api('/api/exit-windows/' + encodeURIComponent(row.id))
      .then((data) => {
        pre.innerHTML = PM.jsonHighlight(data.raw);
      })
      .catch((err) => {
        pre.textContent = err.message;
      });
  }

  return {
    table,
    openDetail,
    statusBadge,
    attributionCell,
    resolutionLabel,
    methodLabel,
    CONFIDENCE_LABEL,
  };
})();
