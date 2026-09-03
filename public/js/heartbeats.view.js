/* ==========================================================================
   Heartbeats as a reusable view: the table, the silence between rows, and the
   row drawer.

   Used by the Heartbeats page (every user) and by the Heartbeats tab on a user
   page (one user). One table definition, so the two cannot drift apart.

   The important idea here is that a *missing* heartbeat is data. A device that
   stops reporting looks identical to a quiet one unless the gap is drawn, so
   silences get their own row (single-user view) or their own column (mixed).
   ========================================================================== */
window.PMHeartbeats = (function () {
  'use strict';

  const { el, fmt, esc } = PM;

  // A heartbeat every ~30-60 s is the norm here, so ten minutes of silence is
  // already worth flagging and half an hour is a failure. Same thresholds the
  // trail map colours its path with.
  const GAP_MINUTES = 10;
  const GAP_CRITICAL_MINUTES = 30;

  /**
   * Why the device might have gone quiet, read off the last heartbeat before the
   * silence. These are the conditions that legitimately stop an app reporting;
   * anything else is called unexplained rather than guessed at.
   */
  function gapCause(before) {
    if (!before) return { label: '? unexplained', tone: 'warning' };
    if (before.isUserLoggedIn === false) return { label: 'logged out', tone: 'neutral' };
    if (before.clockedIn === false) return { label: 'clocked out', tone: 'neutral' };
    if (before.offline) return { label: 'device offline', tone: 'serious' };
    if (before.battery !== null && before.battery !== undefined && before.battery <= 15) {
      return { label: 'battery ' + before.battery + '%', tone: 'serious' };
    }
    if ((before.permissionsMissing || []).includes('LOCATION_BACKGROUND')) {
      return { label: 'background location denied', tone: 'serious' };
    }
    if (before.locationAlways === false) return { label: 'not "allow all the time"', tone: 'warning' };
    return { label: '? unexplained', tone: 'warning' };
  }

  /**
   * Silences in a newest-first list of heartbeats.
   *
   * Rows are grouped by user first, because consecutive rows in a mixed list
   * belong to different devices - the interval between them is not a gap in
   * anybody's reporting. `index` is the position of the row *after* the silence,
   * which is where the gap row is drawn.
   */
  function gaps(rows) {
    const previousByUser = new Map();
    const found = [];
    (rows || []).forEach((row, index) => {
      const key = row.userId === null || row.userId === undefined ? 'anonymous' : String(row.userId);
      const previous = previousByUser.get(key);
      previousByUser.set(key, { row, index });
      if (!previous || !row.capturedAt || !previous.row.capturedAt) return;
      // newest first: the earlier row in the list is the later timestamp
      const minutes = (new Date(previous.row.capturedAt).getTime() - new Date(row.capturedAt).getTime()) / 60000;
      if (minutes < GAP_MINUTES) return;
      found.push({
        index: previous.index,
        userId: row.userId,
        name: row.name,
        minutes,
        from: row.capturedAt,
        to: previous.row.capturedAt,
        before: row,
        critical: minutes >= GAP_CRITICAL_MINUTES,
      });
    });
    return found;
  }

  /** The gap row: what was lost, for how long, and the likely reason. */
  function gapRow(gap, columns, opts) {
    const options = opts || {};
    const cause = gapCause(gap.before);
    return el('tr', {
      class: 'hb-gap' + (gap.critical ? ' is-critical' : ''),
      html:
        '<td colspan="' + columns + '">' +
        '<span class="hb-gap-label">' + (gap.critical ? '⛔' : '⚠') + ' Heartbeat lost</span>' +
        (options.showUser ? '<span class="hb-gap-chip is-strong">' + esc(gap.name || 'user ' + gap.userId) + '</span>' : '') +
        '<span class="hb-gap-chip">' + esc(fmt.dayTime(gap.from)) + ' → ' + esc(fmt.dayTime(gap.to)) + '</span>' +
        '<span class="hb-gap-chip is-strong">Silent for ' + esc(fmt.duration(gap.minutes)) + '</span>' +
        '<span class="hb-gap-chip is-' + cause.tone + '">' + esc(cause.label) + '</span>',
    });
  }

  /** The banner above the table, so silence is visible without scrolling. */
  function gapNotice(list, rowCount) {
    if (!list.length) return null;
    const critical = list.filter((g) => g.critical).length;
    const silent = list.reduce((sum, g) => sum + g.minutes, 0);
    return el('div', {
      class: 'notice' + (critical ? ' is-critical' : ''),
      html:
        '<span>' + (critical ? '⛔' : '⚠') + '</span><span>' +
        '<b>' + list.length + ' heartbeat gap' + (list.length === 1 ? '' : 's') + ' on this page</b> · ' +
        critical + ' critical (≥' + GAP_CRITICAL_MINUTES + ' min) · total silent ' + fmt.duration(silent) +
        ' out of ' + rowCount + ' heartbeats shown. Gaps are measured per device between consecutive stored' +
        ' heartbeats, so one spanning a page boundary shows on the next page.' +
        '</span>',
    });
  }

  /**
   * The table. Options:
   *   showUser  - add a person column (the all-users page)
   *   gapRows   - draw silences as rows; off when the list mixes users, since a
   *               row between two people's heartbeats would be meaningless
   *   silence   - add a "silence before" column (useful when gapRows is off)
   *   onOpen    - called instead of the built-in drawer
   */
  function table(host, rows, opts) {
    const options = opts || {};
    const list = rows || [];
    host.innerHTML = '';
    // Banner, table and anything else here are separate blocks, so they get the
    // same air as any two sections rather than sitting flush against each other.
    host.classList.add('hb-stack');
    if (!list.length) {
      host.append(el('div', { class: 'empty', text: options.empty || 'No heartbeats in this time range.' }));
      return { gaps: [] };
    }

    const found = gaps(list);
    const notice = gapNotice(found, list.length);
    if (notice) host.append(notice);

    const heads = ['Time'];
    if (options.showUser) heads.push('User');
    heads.push('Device', 'App', 'Logged in', 'Clocked in', 'Geofence');
    if (options.silence) heads.push('Silence before');
    heads.push('Battery', 'Lat / lng', 'Accuracy');

    const numeric = new Set(['Battery', 'Accuracy', 'Silence before']);
    const t = el('table', { class: 'hb-table' });
    t.innerHTML =
      '<thead><tr>' +
      heads.map((h) => '<th' + (numeric.has(h) ? ' class="num"' : '') + '>' + h + '</th>').join('') +
      '</tr></thead>';

    // silence per row, so the mixed-user table can show it in a column
    const silenceByIndex = new Map(found.map((g) => [g.index, g]));
    const gapByIndex = options.gapRows === false ? new Map() : silenceByIndex;

    const body = el('tbody');
    list.forEach((row, index) => {
      const silence = silenceByIndex.get(index);
      const cells = [
        '<td>' + fmt.dayTime(row.capturedAt) + '<div class="person-sub">' + fmt.ago(row.capturedAt) + '</div></td>',
      ];
      if (options.showUser) {
        const href = '/user.html?userId=' + encodeURIComponent(row.userId === null ? 'anonymous' : row.userId);
        cells.push(
          '<td>' +
            (row.userId === null
              ? '<span class="badge badge-neutral">no session</span>'
              : '<a href="' + href + '">' + esc(row.name || 'user ' + row.userId) + '</a>') +
            '<div class="person-sub">' + esc(row.employeeRef || row.tenantName || '') + '</div></td>'
        );
      }
      cells.push(
        '<td><span class="badge badge-neutral">' + esc(row.deviceType || '?') + '</span></td>',
        '<td>v' + esc(row.appVersion || '?') +
          '<span class="person-sub" style="display:inline;margin-left:6px">· ' + esc(row.buildVersion || '?') + '</span></td>',
        '<td>' +
          (row.isUserLoggedIn
            ? '<span class="badge badge-good" title="user logged in">✓</span>'
            : '<span class="badge badge-warning" title="user logged out">✕ out</span>') +
          '</td>',
        '<td>' + (row.clockedIn ? '<span class="badge badge-info">IN</span>' : '<span class="badge badge-neutral">—</span>') + '</td>',
        '<td>' + PM.geofenceBadge(row.isInsideGeofence, row.computedVerdict, row.verdictReason) +
          (row.verdictDisagrees ? ' <span class="badge badge-critical" title="app flag and geometry disagree">⚑</span>' : '') +
          '</td>'
      );
      if (options.silence) {
        cells.push(
          '<td class="num">' +
            (silence
              ? '<span class="badge ' + (silence.critical ? 'badge-critical' : 'badge-warning') + '" title="' +
                esc(gapCause(silence.before).label) + '">' + esc(fmt.duration(silence.minutes)) + '</span>'
              : '<span class="hint">--</span>') +
            '</td>'
        );
      }
      cells.push(
        '<td class="num">' + PM.batteryBadge(row.battery) + '</td>',
        '<td class="mono">' +
          (row.location
            ? fmt.coords(row.location) + (row.jobSiteId != null ? '<div class="person-sub">site ' + row.jobSiteId + '</div>' : '')
            : '<span class="badge badge-neutral">no fix</span>') +
          '</td>',
        '<td class="num">' + PM.accuracyBadge(row.accuracyBand, row.accuracy) + '</td>'
      );

      body.append(
        el('tr', {
          class: 'clickable',
          title: 'Open this heartbeat',
          onclick: (event) => {
            if (event.target.closest('a')) return;
            if (options.onOpen) options.onOpen(row);
            else drawer(row);
          },
          html: cells.join(''),
        })
      );

      const gap = gapByIndex.get(index);
      if (gap) body.append(gapRow(gap, heads.length, { showUser: options.showUser }));
    });
    t.append(body);
    host.append(el('div', { class: 'table-block' }, [el('div', { class: 'table-scroll' }, [t])]));
    return { gaps: found };
  }

  /**
   * The one live drawer map. A drawer is reopened far more often than it is
   * closed - clicking a second row replaces the body outright - so the previous
   * map has to be torn down here as well as on close, or its window resize
   * handler stays bound to a container that is no longer in the document and
   * PMMap.instances grows for the life of the page.
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

  /**
   * Where this one heartbeat was, against the fence it was judged by.
   *
   * The Details tab says "24.86072, 67.00114 · 12 m · outside · 43 m from the
   * boundary". Those are the right numbers and they are nearly unreadable: no
   * one holds a coordinate pair in their head, and "43 m outside" means nothing
   * without knowing whether that is across a car park or across a motorway.
   * This is the same six values, placed.
   */
  function renderFixMap(panel, row) {
    if (!row.location) {
      panel.append(
        el('div', { class: 'empty', text: 'This heartbeat arrived with no coordinates, so there is nothing to place on a map.' })
      );
      return;
    }

    const mapHost = el('div', { class: 'map mini', style: 'height:320px' });
    panel.append(mapHost, el('div', { html: PMMap.legend() }));

    releaseDrawerMap();
    const map = PMMap.create(mapHost);
    drawerMap = map;
    // The drawer animates open; Leaflet measured the container mid-transition.
    setTimeout(() => map.invalidateSize(), 60);

    const frame = [];

    // `row.site` carries its own provenance (radiusIsAuthoritative and friends),
    // so siteCircle draws a real fence for a recorded one and a dashed estimate
    // ring for a centre we only inferred - which is the honest drawing, and the
    // trap two other callers of this fell into by spreading a bare `fence`.
    if (row.site && row.site.lat != null) {
      const drawn = PMMap.siteCircle(map, row.site);
      if (drawn) {
        frame.push({ lat: row.site.lat, lng: row.site.lng }, ...drawn.extent);
      }
    }

    PMMap.deviceMarker(map, row, { pulse: true, permanentLabel: true });
    frame.push(row.location);

    // The walk back to the fence, when this fix was outside it. Same line the
    // user page draws, so the two views of one heartbeat agree.
    if (row.fence && row.relation && !row.relation.inside) {
      PMMap.guideLine(map, row.location, row.fence, {
        text: fmt.metres(Math.abs(row.relation.distanceFromBoundary)) + ' outside · ' + (row.relation.compass || '') + ' of the centre',
      });
    }

    PMMap.fit(map, frame, { zoom: 17 });

    panel.append(
      el('div', { class: 'section-title', text: 'Against the fence' }),
      PM.kv([
        ['Verdict', PM.geofenceBadge(row.isInsideGeofence, row.computedVerdict, row.verdictReason)],
        ['Accuracy', PM.accuracyBadge(row.accuracyBand, row.accuracy)],
        [
          'Fence',
          row.fence
            ? fmt.coords(row.fence) + ' · radius ' + fmt.metres(row.fence.radius)
            : row.site && row.site.lat != null
              ? '<span class="hint">no fence on record - the ring is an estimated centre</span>'
              : '<span class="hint">no site on record for this heartbeat</span>',
        ],
        row.relation
          ? [
              'Distance to boundary',
              fmt.metres(Math.abs(row.relation.distanceFromBoundary)) +
                (row.relation.inside ? ' inside' : ' outside') +
                ' · ' + fmt.metres(row.relation.distanceFromCenter) + ' from the centre',
            ]
          : undefined,
        row.guide
          ? [
              'Walk back',
              '<a href="' + row.guide.directionsUrl + '" target="_blank" rel="noopener">Directions to the site ↗</a>',
            ]
          : undefined,
      ])
    );
  }
  /** Everything one heartbeat document knows, in a drawer. */
  function drawer(row) {
    const rel = row.relation;
    PM.openDrawer({
      title: 'Heartbeat ' + fmt.time(row.capturedAt),
      subtitle: fmt.date(row.capturedAt) + ' · ' + (row.name || 'device') + ' · document ' + row.id,
      tabs: [
        {
          id: 'fix',
          label: 'Fix & fence',
          render: (panel) => renderFixMap(panel, row),
        },
        {
          id: 'heartbeat',
          label: 'Details',
          render: (panel) =>
            panel.append(
              el('div', { class: 'section-title', text: 'Location' }),
              PM.kv([
                ['Captured at', fmt.date(row.capturedAt) + ' (' + fmt.ago(row.capturedAt) + ')'],
                ['Coordinates', row.location ? fmt.coords(row.location) : 'none reported'],
                ['Accuracy', PM.accuracyBadge(row.accuracyBand, row.accuracy)],
                ['Geofence (device flag)', PM.geofenceBadge(row.isInsideGeofence)],
                [
                  'Geofence (recomputed)',
                  row.computedVerdict
                    ? PM.geofenceBadge(null, row.computedVerdict, row.verdictReason) +
                      (row.verdictReason ? ' <span class="hint">' + esc(row.verdictReason) + '</span>' : '')
                    : 'no fence on record',
                ],
                rel
                  ? [
                      'Distance to boundary',
                      fmt.metres(Math.abs(rel.distanceFromBoundary)) +
                        (rel.inside ? ' inside' : ' outside') +
                        ' · ' + fmt.metres(rel.distanceFromCenter) + ' from the centre · bearing ' + rel.bearing + '° ' + rel.compass,
                    ]
                  : undefined,
                ['Site', row.jobSiteId != null ? 'Site ' + row.jobSiteId + (row.site && row.site.address ? ' · ' + esc(row.site.address) : '') : 'unmapped'],
                ['Geofence entered', fmt.dateIn(row.geofenceIn, row.timezone)],
                ['Geofence left', fmt.dateIn(row.geofenceOut, row.timezone)],
              ]),
              el('div', { class: 'section-title', text: 'Person' }),
              PM.kv([
                ['Name', row.name || '--'],
                ['User id', row.userId === null ? 'no session (userId null)' : String(row.userId)],
                ['Employee reference', row.employeeRef || '--'],
                ['Tenant', row.tenantName ? row.tenantName + (row.tenantId ? ' (' + row.tenantId + ')' : '') : '--'],
              ]),
              el('div', { class: 'section-title', text: 'Device & session' }),
              PM.kv([
                ['Clock', row.clockedIn ? 'on the clock' : 'off the clock'],
                ['Battery', PM.batteryBadge(row.battery)],
                ['Connectivity', row.isConnected ? 'connected' : 'disconnected'],
                ['Reachable', fmt.bool(row.isReachable)],
                ['Session', (row.sessionLoggedIn ? 'session active' : 'session inactive') + ' · ' + (row.isUserLoggedIn ? 'logged in' : 'logged out')],
                ['Platform', (row.deviceType || '?') + ' · app ' + (row.appVersion || '?') + ' build ' + (row.buildVersion || '?')],
                ['Device time', row.deviceTime || '--'],
                ['Clock drift vs server', row.clockDriftSeconds === null ? '--' : row.clockDriftSeconds + ' s'],
                ['Permissions granted', (row.permissionsEnabled || []).join(', ') || 'none'],
                ['Permissions missing', (row.permissionsMissing || []).join(', ') || 'none'],
                ['Document id', row.id],
              ])
            ),
        },
      ],
    });
  }

  return {
    table,
    drawer,
    gaps,
    gapRow,
    gapCause,
    gapNotice,
    GAP_MINUTES,
    GAP_CRITICAL_MINUTES,
  };
})();
