/* ==========================================================================
   Shift trails as a reusable view: the table, the cells, and the row drawer.

   The Shift Trails page and the "Shift trails" tab on a user page show the same
   sealed documents, so they show them the same way - one table definition, one
   drawer, one set of badges. That is the lesson the exit windows view already
   learned here: the user page used to carry a thinner copy of that table which
   could not be opened, and the two drifted apart the moment either was edited.

   The page keeps what is genuinely page-level: the filter bar, the KPI tiles,
   the timeline chart, the banner and the pager.
   ========================================================================== */
window.PMShiftTrails = (function () {
  'use strict';

  const { el, fmt, api, esc } = PM;

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

  /**
   * A count in the table, wearing the same colour its entries wear in the
   * drawer.
   *
   * The badge class comes from ENTRY_KIND rather than being written out again
   * here, because it already had been: the table drew a restart in
   * `badge-serious` while the drawer drew it in `badge-warning`, and fixes had
   * no colour at all. Two lists of colours for one set of things drift the
   * moment either is edited, so there is one list and this reads it.
   *
   * Zero stays muted and unbadged. A badge is for something that happened, and
   * a column of coloured noughts buries the rows where something did.
   */
  function countCell(count, badgeClass, title) {
    if (!count) return '<span class="hint">0</span>';
    return (
      '<span class="badge ' + badgeClass + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + fmt.int(count) + '</span>'
    );
  }

  /** `services_disabled` -> `services disabled`, for a value we have no label for. */
  function humanise(value) {
    const words = String(value).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function siteLabel(siteId) {
    const sites = (PM.state.meta || {}).sites || [];
    const hit = sites.find((s) => s.siteId === siteId);
    return (hit ? PM.siteName(hit, siteId) : 'Site ' + siteId) + ' · #' + siteId;
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
      '<div class="person-sub">' + fmt.num(row.stats.positionedMinutes, 0) + ' of ' + fmt.num(row.stats.shiftMinutes, 0) + ' min had a fix</div>'
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

  /**
   * The table, wherever it is shown.
   *
   * `opts.empty` is the node to show when there is nothing - the two callers
   * have different things to say about an empty result, and "no rows" from a
   * filter bar is a different finding from "this person has sealed no shifts".
   * `opts.onOpen` exists only so a caller can decorate the row before the
   * drawer sees it; it defaults to opening the drawer as it stands.
   */
  function table(host, rows, opts) {
    const o = opts || {};
    host.innerHTML = '';
    if (!rows.length) {
      host.append(o.empty || el('div', { class: 'empty', text: 'No shift trails match these filters.' }));
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
            (o.onOpen || openDetail)(row);
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
            // Each count wears its entry kind's colour, read from ENTRY_KIND so
            // the table and the drawer cannot say different things about the
            // same entry. A shift with no fix at all is the exception: zero
            // fixes is not a quiet nought, it is the worst outcome there is.
            '<td class="num">' +
            (s.fixCount === 0
              ? '<span class="badge badge-critical" title="this shift sealed without a single position">none</span>'
              : countCell(s.fixCount, ENTRY_KIND.fix.badge)) + '</td>' +
            '<td class="num">' + countCell(s.runtimeStartCount, ENTRY_KIND.runtime_start.badge, ENTRY_KIND.runtime_start.title) +
            (s.runtimeStartsDisagree
              ? '<div class="person-sub" title="the app reported a different number of restarts than the runtime_start entries it sent">app said ' +
                fmt.int(row.reported.runtimeStarts) + '</div>'
              : '') + '</td>' +
            // Gaps carry their reason, absences their duration: the count alone
            // says how often, and what you actually want to know is why, or for
            // how long.
            '<td class="num">' + countCell(s.gapCount, ENTRY_KIND.gap.badge, 'the app was awake and could not get a position') +
            (s.gapReasons && s.gapReasons.length
              ? '<div class="person-sub">' + esc(s.gapReasons.map(humanise).join(', ')) + '</div>'
              : '') + '</td>' +
            // An absence is not an entry kind, so it has no ENTRY_KIND colour -
            // but it means the same thing to a reader as a gap does, only
            // worse, so it keeps the same red.
            '<td class="num">' + countCell(row.absenceCount, 'badge-critical', 'the app wrote nothing at all for a stretch') +
            (row.absentMinutes ? '<div class="person-sub">' + fmt.duration(row.absentMinutes) + '</div>' : '') + '</td>' +
            '<td class="num">' + (s.travelledMetres === null ? '--' : fmt.metres(s.travelledMetres)) +
            (s.impossibleSteps
              ? '<div class="person-sub"><span class="badge badge-warning" title="a fix landed ' +
                fmt.metres(s.discardedMetres) + ' away at a speed nothing on the ground reaches - left out of this total">' +
                s.impossibleSteps + ' bad fix</span></div>'
              : '') + '</td>' +
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
    return node;
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
                ['Positioned', fmt.int(s.positionedMinutes) + ' of ' + fmt.int(s.shiftMinutes) + ' wall-clock minutes contained a fix'],
                s.unpositionedMinutes ? ['Minutes with no fix', fmt.int(s.unpositionedMinutes)] : null,
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
                [
                  'Travelled',
                  s.travelledMetres === null
                    ? '--'
                    : fmt.metres(s.travelledMetres) + ' along the path' +
                      (s.impossibleSteps
                        ? '<div class="person-sub">' + s.impossibleSteps + ' step of ' + fmt.metres(s.discardedMetres) +
                          ' left out: a fix that far away at that speed is a bad reading, not a journey</div>'
                        : ''),
                ],
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

  return {
    table,
    openDetail,
    siteLabel,
    personCell,
    coverageCell,
    permissionCell,
    kindCell,
    countCell,
    humanise,
    ENTRY_KIND,
    PERMISSION_LABEL,
    PRECISION_LABEL,
  };
})();
