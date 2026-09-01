/* One user, one page.
   Above: a hero header, KPI tiles, and the person / device / state / shift
   detail cards. Below: everything else in tabs - location & trail, history,
   geofence validation calls, exit windows, raw document. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  const params = new URLSearchParams(location.search);
  const userId = params.get('userId') || 'anonymous';

  let detail = null;
  let tabs = null;
  let heartbeatPage = 1;
  let map = null;
  let mapLayers = [];

  PM.boot(
    'user.html',
    async ({ root }) => {
      PM.buildFilterBar(
        [
          { kind: 'daterange' },
          {
            kind: 'multi',
            key: 'accuracyBand',
            label: 'Accuracy band',
            options: PM.optionsFrom(PM.state.meta.accuracyBands || [], 'key', 'label'),
          },
          { kind: 'tri', key: 'clockedIn', label: 'Clocked in', yes: 'On the clock', no: 'Off the clock' },
          { kind: 'tri', key: 'insideGeofence', label: 'Inside fence', yes: 'Inside', no: 'Outside', nullable: true },
        ],
        // userId is this page's identity, not a filter chip to clear.
        { hideChips: ['userId'] }
      );

      root.append(
        el('div', { class: 'crumb' }, [el('a', { href: '/users.html', text: '← All users & devices' })]),
        el('div', { class: 'hero', id: 'hero' }),
        el('div', { class: 'tiles tiles-4', id: 'user-tiles' }),
        el('div', { id: 'user-notices' }),
        el('div', { class: 'detail-grid' }, [
          card('Person', 'identity-card'),
          card('Device', 'device-card'),
          card('Right now', 'state-card'),
          card('Shift & verification', 'shift-card'),
        ]),
        el('div', { class: 'tab-card', id: 'tab-host' })
      );

      tabs = PM.pageTabs(
        document.querySelector('#tab-host'),
        [
          { id: 'location', label: 'Location & trail', padded: false, render: renderLocationTab, onShow: resizeMap },
          { id: 'history', label: 'History', render: renderHistoryTab },
          { id: 'heartbeats', label: 'Heartbeats', render: renderHeartbeatsTab },
          { id: 'calls', label: 'Geofence validation calls', render: renderCallsTab },
          { id: 'exit-windows', label: 'Exit windows', render: renderExitWindowsTab },
          { id: 'raw', label: 'Raw document', render: renderRawTab },
        ],
        // Nothing to render until the first load() resolves.
        { defer: true, skeleton: 'block' }
      );

      await load();
      window.addEventListener('pm:filters', load);
      window.addEventListener('pm:refresh', load);
    },
    { activeFile: 'users.html', title: 'User' }
  );

  function card(title, id) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: title })]),
      el('div', { class: 'card-body', id }),
    ]);
  }

  async function load() {
    PM.showSkeleton({
      '#hero': 'text:2',
      '#user-tiles': 'tiles:8',
      '#identity-card': 'kv:8',
      '#device-card': 'kv:8',
      '#state-card': 'kv:6',
      '#shift-card': 'kv:6',
    });
    try {
      detail = await api('/api/users/' + encodeURIComponent(userId) + '?historyLimit=800&' + queryString());
    } catch (err) {
      renderLoadFailure(err);
      return;
    }

    const row = detail.current;
    const stats = detail.stats || {};
    heartbeatPage = 1; // a new time range means the old page numbers are moot
    PM.setTitle(row.name || (row.userId === null ? 'Unidentified device' : 'User ' + row.userId));
    PM.setSubtitle(
      [
        row.employeeRef,
        row.tenantName,
        row.userId === null ? 'no session id' : 'user ' + row.userId,
        fmt.int(stats.snapshots) + ' heartbeats in range',
      ]
        .filter(Boolean)
        .join(' · ')
    );

    renderHero(row);
    renderTiles(stats);
    renderNotices(row);
    renderIdentity(row);
    renderDevice(row);
    renderState(row);
    renderShift(row);

    tabs.setCount('history', (detail.track || []).length);
    tabs.setCount('heartbeats', stats.snapshots);
    tabs.setCount('calls', (detail.logs || []).length);
    tabs.setCount('exit-windows', (detail.exitWindows || []).length);
    tabs.invalidate();
    PM.markLoaded();
  }

  // ------------------------------------------------------------------- above
  function renderHero(row) {
    const host = document.querySelector('#hero');
    host.innerHTML = '';
    const badges = el('div', { class: 'hero-badges' });
    badges.innerHTML =
      (row.accountStatus
        ? '<span class="badge ' +
          (String(row.accountStatus).toUpperCase() === 'ACTIVE' ? 'badge-good' : 'badge-warning') +
          '">' +
          esc(row.accountStatus) +
          '</span>'
        : '') +
      (row.clockedIn
        ? '<span class="badge badge-good">● On the clock</span>'
        : '<span class="badge badge-neutral">○ Off the clock</span>') +
      PM.geofenceBadge(row.isInsideGeofence, row.computedVerdict, row.verdictReason) +
      PM.accuracyBadge(row.accuracyBand, row.accuracy) +
      PM.batteryBadge(row.battery) +
      '<span class="badge badge-neutral">' + esc(row.deviceType || 'device ?') + ' · v' + esc(row.appVersion || '?') + '</span>' +
      (row.offline ? '<span class="badge badge-critical">offline</span>' : '') +
      (row.verdictDisagrees ? '<span class="badge badge-critical">⚑ verdict mismatch</span>' : '');

    host.append(
      el('div', { class: 'hero-avatar', text: fmt.initials(row.name) }),
      el('div', { class: 'hero-main' }, [
        el('div', { class: 'hero-name', text: row.name || 'Unidentified device' }),
        el('div', {
          class: 'hero-sub',
          text:
            [row.employeeRef, row.tenantName, row.role, row.jobSiteId != null ? 'site ' + row.jobSiteId : 'unmapped site']
              .filter(Boolean)
              .join(' · ') || 'no session data',
        }),
      ]),
      el('div', { style: 'margin-left:auto;min-width:0' }, [
        badges,
        el('div', { class: 'hero-seen', text: 'last snapshot ' + fmt.ago(row.capturedAt) + ' · ' + fmt.date(row.capturedAt) }),
      ])
    );
  }

  function tile(label, value, note, tone) {
    return el('div', { class: 'tile ' + (tone ? 'is-' + tone : '') }, [
      el('div', { class: 'tile-label', text: label }),
      el('div', { class: 'tile-value', text: value }),
      el('div', { class: 'tile-note', text: note }),
    ]);
  }

  function renderTiles(stats) {
    const host = document.querySelector('#user-tiles');
    host.innerHTML = '';
    const flagged = (stats.inside || 0) + (stats.outside || 0);
    const battery =
      (stats.minBattery === null || stats.minBattery === undefined ? '?' : stats.minBattery) +
      '-' +
      (stats.maxBattery === null || stats.maxBattery === undefined ? '?' : stats.maxBattery) +
      '%';
    host.append(
      tile('Heartbeats in range', fmt.int(stats.snapshots), 'since ' + fmt.dayTime(stats.firstSeenAt)),
      tile(
        'Inside fence',
        fmt.int(stats.inside),
        flagged ? fmt.pct((100 * (stats.inside || 0)) / flagged) + ' of flagged heartbeats' : 'no fence flags'
      ),
      tile(
        'Outside fence',
        fmt.int(stats.outside),
        flagged ? fmt.pct((100 * (stats.outside || 0)) / flagged) + ' of flagged heartbeats' : 'no fence flags',
        stats.outside ? 'critical' : undefined
      ),
      tile(
        'Avg accuracy',
        fmt.accuracy(stats.avgAccuracy),
        'best ' + fmt.accuracy(stats.bestAccuracy) + ' · worst ' + fmt.accuracy(stats.worstAccuracy),
        stats.avgAccuracy > 50 ? 'warning' : undefined
      ),
      tile('Distance travelled', fmt.metres(stats.travelledMetres), 'summed between heartbeats'),
      tile('Battery range', battery, 'across the window', stats.minBattery !== null && stats.minBattery <= 10 ? 'warning' : undefined),
      tile('Offline pings', fmt.int(stats.offline), 'heartbeats with no connectivity', stats.offline ? 'serious' : undefined),
      tile(
        'Sites visited',
        fmt.int((stats.siteIds || []).length),
        (stats.siteIds || []).length ? 'sites ' + stats.siteIds.join(', ') : 'none mapped'
      )
    );
  }

  function renderNotices(row) {
    const host = document.querySelector('#user-notices');
    host.innerHTML = '';
    const notes = [];
    if (row.verdictDisagrees) {
      notes.push(
        '<b>The app flag and the geometry disagree.</b> The device reports ' +
          (row.isInsideGeofence ? 'inside' : 'outside') +
          ' while the stored fence puts it ' +
          esc(row.computedVerdict) +
          '.'
      );
    }
    if (row.computedVerdict === 'unknown') {
      // Capitalise the reason: it is a sentence fragment from the geo helper.
      const reason = esc(row.verdictReason || '');
      notes.push(
        '<b>The latest heartbeat cannot decide the fence.</b> ' +
          (reason ? reason.charAt(0).toUpperCase() + reason.slice(1) + ' - ' : '') +
          'treat inside/outside for this user as unresolved.'
      );
    }
    if ((row.permissionsMissing || []).includes('LOCATION_BACKGROUND')) {
      notes.push('<b>Background location is denied.</b> Geofence events will be missed while the app is not in the foreground.');
    }
    if (row.battery !== null && row.battery <= 15) {
      notes.push('<b>Battery is at ' + row.battery + '%.</b> Expect the heartbeat to stop soon.');
    }
    for (const text of notes) {
      host.append(el('div', { class: 'notice', html: '<span>⚠</span><span>' + text + '</span>' }));
    }
  }

  function renderIdentity(row) {
    const host = document.querySelector('#identity-card');
    host.innerHTML = '';
    host.append(
      PM.kv([
        ['Full name', row.name || '--'],
        ['Email', row.email ? '<a href="mailto:' + esc(row.email) + '">' + esc(row.email) + '</a>' : '--'],
        ['Phone', row.phone || '--'],
        ['Employee reference', row.employeeRef || '--'],
        ['Role', [row.role, row.accountType].filter(Boolean).join(' · ') || '--'],
        ['Tenant', row.tenantName ? esc(row.tenantName) + (row.tenantCode ? ' (code ' + esc(row.tenantCode) + ')' : '') : '--'],
        ['User id', row.userId === null ? 'none - reports without a session' : String(row.userId)],
        ['Subscription', row.subscription || '--'],
        [
          'Tenant rules',
          row.tenantSettings
            ? [
                row.tenantSettings.geoFenceClockOutEnabled ? 'geofence clock-out on' : 'geofence clock-out off',
                row.tenantSettings.enableFacialRecognition ? 'face verification on' : 'face verification off',
                row.tenantSettings.facialVerificationInterval
                  ? 'every ' + fmt.duration(row.tenantSettings.facialVerificationInterval / 60)
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : '--',
        ],
      ])
    );
  }

  /** batteryOptimizationPermission is a tri-state, so say what it means. */
  function batteryOptimisation(value) {
    if (value === null || value === undefined) return '';
    return value ? ' · exempt from battery optimisation' : ' · subject to battery optimisation';
  }

  function renderDevice(row) {
    const host = document.querySelector('#device-card');
    host.innerHTML = '';
    const perms = el('div', { class: 'chips', style: 'margin-top:10px' });
    for (const p of row.permissionsEnabled || []) {
      perms.append(el('span', { class: 'chip', html: '<span class="badge badge-good">✓</span>' + esc(p) }));
    }
    for (const p of row.permissionsMissing || []) {
      perms.append(el('span', { class: 'chip', html: '<span class="badge badge-critical">✕</span>' + esc(p) }));
    }
    host.append(
      PM.kv([
        ['Platform', (row.deviceType || '?') + ' · app ' + (row.appVersion || '?') + ' build ' + (row.buildVersion || '?')],
        ['Battery', PM.batteryBadge(row.battery) + batteryOptimisation(row.batteryOptimizationPermission)],
        [
          'Connectivity',
          (row.isConnected
            ? '<span class="badge badge-good">connected</span>'
            : '<span class="badge badge-critical">disconnected</span>') +
            ' ' +
            (row.isReachable
              ? '<span class="badge badge-neutral">reachable</span>'
              : '<span class="badge badge-warning">unreachable</span>'),
        ],
        [
          'Session',
          (row.sessionLoggedIn ? 'session active' : 'session inactive') +
            ' · ' +
            (row.isUserLoggedIn ? 'user logged in' : 'user logged out'),
        ],
        [
          'Timezone',
          (row.timezone || '?') +
            (row.timezoneOffsetMinutes === null
              ? ''
              : ' (UTC' + (row.timezoneOffsetMinutes >= 0 ? '+' : '') + row.timezoneOffsetMinutes / 60 + ')'),
        ],
        ['Device clock', row.deviceTime || '--'],
        ['Clock drift vs server', row.clockDriftSeconds === null ? '--' : row.clockDriftSeconds + ' s'],
        [
          'Always-on location',
          row.locationAlways
            ? '<span class="badge badge-good">allowed</span>'
            : '<span class="badge badge-warning">not allowed</span>',
        ],
      ]),
      el('div', { class: 'section-title', style: 'margin-top:14px', text: 'Permissions' }),
      perms
    );
  }

  function renderState(row) {
    const host = document.querySelector('#state-card');
    host.innerHTML = '';
    const rel = row.relation;
    host.append(
      PM.kv([
        [
          'Clock',
          row.clockedIn
            ? '<span class="badge badge-good">● on the clock</span>'
            : '<span class="badge badge-neutral">○ off the clock</span>',
        ],
        ['Geofence (device flag)', PM.geofenceBadge(row.isInsideGeofence)],
        [
          'Geofence (recomputed)',
          row.computedVerdict
            ? PM.geofenceBadge(null, row.computedVerdict, row.verdictReason) +
              (row.verdictReason ? ' <span class="hint">' + esc(row.verdictReason) + '</span>' : '')
            : 'no fence on record for this site',
        ],
        [
          'Site',
          row.jobSiteId != null
            ? 'Site ' + row.jobSiteId + (row.site && row.site.address ? ' · ' + esc(row.site.address) : '')
            : 'unmapped',
        ],
        ['Fix', fmt.coords(row.location) + ' · ' + PM.accuracyBadge(row.accuracyBand, row.accuracy)],
        rel
          ? [
              'Distance to boundary',
              fmt.metres(Math.abs(rel.distanceFromBoundary)) +
                (rel.inside ? ' inside' : ' outside') +
                ' · bearing ' +
                rel.bearing +
                '° ' +
                rel.compass,
            ]
          : undefined,
        row.guide
          ? [
              'Guide back',
              '<a href="' +
                row.guide.directionsUrl +
                '" target="_blank" rel="noopener">walking directions ↗</a> (' +
                fmt.metres(row.guide.distanceMetres) +
                ' ' +
                (row.guide.compass || '') +
                ')',
            ]
          : undefined,
        ['Geofence entered', fmt.date(row.geofenceIn)],
        ['Geofence left', fmt.date(row.geofenceOut)],
        ['Last snapshot', fmt.date(row.capturedAt) + ' (' + fmt.ago(row.capturedAt) + ')'],
      ])
    );
  }

  function renderShift(row) {
    const host = document.querySelector('#shift-card');
    host.innerHTML = '';
    const te = row.timeEntry;
    const fv = row.facialVerification || {};
    host.append(
      PM.kv([
        ['Time entry', te ? '#' + te.id + ' · ' + (te.status || '?') + (te.date ? ' · ' + te.date : '') : 'none open'],
        ['Clock in', te ? fmt.date(te.clockIn) + (te.clockInNetworkStatus ? ' (' + te.clockInNetworkStatus + ')' : '') : '--'],
        ['Clock out', te ? fmt.date(te.clockOut) + (te.clockOutNetworkStatus ? ' (' + te.clockOutNetworkStatus + ')' : '') : '--'],
        ['Geofence clock in', te ? fmt.date(te.geoFenceClockIn) : '--'],
        ['Geofence clock out', te ? fmt.date(te.geoFenceClockOut) : '--'],
        ['Site area', te && te.siteAreaId != null ? 'Site area ' + te.siteAreaId : '--'],
        [
          'Face verification',
          fv.enabled
            ? (fv.completed || 0) +
              ' of ' +
              (fv.required || 0) +
              ' done' +
              (fv.intervalSeconds ? ' · every ' + fmt.duration(fv.intervalSeconds / 60) : '') +
              (fv.pending ? ' <span class="badge badge-warning">pending</span>' : '')
            : 'disabled for this tenant',
        ],
        ['Total duration', te && te.totalDuration ? String(te.totalDuration) : '--'],
      ])
    );
  }

  // -------------------------------------------------------------------- tabs
  // Which trail layers are on. Remembered per browser, like the map base layer.
  const TRAIL_LAYERS = [
    { key: 'dots', label: 'Heartbeats', on: true },
    { key: 'clockIns', label: 'Clock-ins', on: true },
    { key: 'path', label: 'Path', on: true },
    { key: 'labels', label: 'Sequence #', on: false },
    { key: 'accuracy', label: 'Accuracy', on: false },
    { key: 'fences', label: 'Geofences', on: true },
  ];
  const STATES = [
    { key: 'all', label: 'All heartbeats' },
    { key: 'inside', label: 'Inside fence' },
    { key: 'outside', label: 'Outside fence' },
    { key: 'noflag', label: 'No fence flag' },
    { key: 'poor', label: 'Poor accuracy (>50 m)' },
  ];

  function trailPrefs() {
    const prefs = {};
    for (const layer of TRAIL_LAYERS) {
      let saved = null;
      try {
        saved = localStorage.getItem('pm.trail.' + layer.key);
      } catch (err) {
        saved = null;
      }
      prefs[layer.key] = saved === null ? layer.on : saved === '1';
    }
    try {
      prefs.state = localStorage.getItem('pm.trail.state') || 'all';
    } catch (err) {
      prefs.state = 'all';
    }
    return prefs;
  }

  function saveTrailPref(key, value) {
    try {
      localStorage.setItem('pm.trail.' + key, typeof value === 'boolean' ? (value ? '1' : '0') : value);
    } catch (err) {
      /* preferences just will not persist */
    }
  }

  function stateMatches(point, state) {
    if (state === 'inside') return point.insideGeofence === true;
    if (state === 'outside') return point.insideGeofence === false;
    if (state === 'noflag') return point.insideGeofence === null || point.insideGeofence === undefined;
    if (state === 'poor') return point.accuracy !== null && point.accuracy > 50;
    return true;
  }

  function renderLocationTab(host) {
    const row = detail.current;
    const prefs = trailPrefs();
    const toolbar = el('div', { class: 'map-toolbar' });
    const mapHost = el('div', { class: 'map', id: 'user-map', style: 'height:460px' });

    host.append(
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Location & trail' }),
        el('span', { class: 'sub', id: 'trail-sub' }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'sub', id: 'guide-link' }),
      ]),
      toolbar,
      mapHost,
      el('div', { html: PMMap.trailLegend() })
    );

    map = PMMap.create(mapHost);
    setTimeout(() => map.invalidateSize(), 60);

    // Layers are built once per data load and toggled by adding / removing.
    let built = null;

    const rebuild = () => {
      if (built) {
        for (const layer of Object.values(built.layers)) if (layer) map.removeLayer(layer);
        for (const extra of built.extras) if (extra && extra.group) extra.group.remove();
      }
      const points = (detail.track || []).filter((p) => stateMatches(p, prefs.state));
      const trail = PMMap.trail(map, points, { add: false });
      const clock = PMMap.clockIns(map, detail.logs || [], { add: false });

      const fences = L.layerGroup();
      const extras = [];
      for (const site of detail.sites || []) {
        if (site.lat == null) continue;
        const circle = PMMap.siteCircle(map, site, { label: false });
        if (circle && circle.group) {
          circle.group.remove();
          fences.addLayer(circle.group);
        }
      }

      built = {
        layers: { dots: trail.layers.dots, path: trail.layers.path, labels: trail.layers.labels, accuracy: trail.layers.accuracy, clockIns: clock.group, fences },
        extras,
        trail,
        points,
      };

      // The current fix and the guidance line always show - they are the answer
      // to "where is this person now", not a layer.
      if (row.location) {
        const marker = PMMap.deviceMarker(map, row, { pulse: true, permanentLabel: true });
        if (marker) built.extras.push(marker);
        if (row.guide && row.fence) {
          built.extras.push(
            PMMap.guideLine(map, row.location, row.fence, {
              text: fmt.metres(row.guide.distanceMetres) + ' ' + (row.guide.compass || '') + ' of the fence centre',
            })
          );
        }
      }

      applyVisibility();

      const fitPoints = points.slice();
      for (const site of detail.sites || []) if (site.lat != null) fitPoints.push({ lat: site.lat, lng: site.lng });
      if (row.location) fitPoints.push(row.location);
      PMMap.fit(map, fitPoints);

      const stats = trail.stats;
      const gaps = stats.gapShort + stats.gapLong;
      document.querySelector('#trail-sub').textContent =
        points.length +
        ' heartbeats' +
        (prefs.state === 'all' ? '' : ' matching "' + (STATES.find((x) => x.key === prefs.state) || {}).label + '"') +
        ' · ' +
        (detail.sites || []).length +
        ' fence(s)' +
        (gaps ? ' · ' + gaps + ' reporting gap(s)' : '') +
        (stats.jump ? ' · ' + stats.jump + ' suspicious jump(s)' : '') +
        ' · travelled ' +
        fmt.metres((detail.stats || {}).travelledMetres);
      document.querySelector('#guide-link').innerHTML = row.guide
        ? '<a href="' + row.guide.directionsUrl + '" target="_blank" rel="noopener">↗ Walking directions back to the site</a>'
        : '';
    };

    // Bottom to top. Canvas layers are drawn - and hit-tested - in the order
    // they are added, and the last match wins a click, so the dots have to go
    // on last or a fence circle drawn over them eats every heartbeat click.
    const Z_ORDER = ['accuracy', 'fences', 'path', 'clockIns', 'labels', 'dots'];

    const applyVisibility = () => {
      if (!built) return;
      // Take everything off first, so re-adding restores the stack order even
      // when a single toggle changed.
      for (const layer of Object.values(built.layers)) {
        if (layer && map.hasLayer(layer)) map.removeLayer(layer);
      }
      for (const key of Z_ORDER) {
        const layer = built.layers[key];
        if (layer && prefs[key]) layer.addTo(map);
      }
    };

    // ---- toolbar --------------------------------------------------------
    for (const layer of TRAIL_LAYERS) {
      const box = el('input', { type: 'checkbox', checked: prefs[layer.key] ? 'checked' : null });
      const chip = el('label', { class: 'chip' + (prefs[layer.key] ? ' is-on' : '') }, [box, document.createTextNode(layer.label)]);
      box.addEventListener('change', () => {
        prefs[layer.key] = box.checked;
        saveTrailPref(layer.key, box.checked);
        chip.classList.toggle('is-on', box.checked);
        applyVisibility();
      });
      toolbar.append(chip);
    }

    const stateSelect = el(
      'select',
      {
        onchange: (event) => {
          prefs.state = event.target.value;
          saveTrailPref('state', prefs.state);
          rebuild();
        },
      },
      STATES.map((st) => el('option', { value: st.key, text: st.label, selected: prefs.state === st.key ? 'selected' : null }))
    );
    toolbar.append(
      el('div', { style: 'flex:1' }),
      el('span', { class: 'toolbar-field' }, [el('span', { text: 'State' }), stateSelect])
    );

    rebuild();
  }

  /** Leaflet needs a nudge whenever its container was hidden while sizing. */
  function resizeMap() {
    if (map) setTimeout(() => map.invalidateSize(), 40);
  }

  function chartBlock(title, subtitle, canvasId, extra) {
    return el('div', {}, [
      el('div', { style: 'display:flex;align-items:baseline;gap:10px;margin-bottom:6px' }, [
        el('div', { style: 'font-size:13.5px;font-weight:600', text: title }),
        el('span', { class: 'hint', text: subtitle }),
      ]),
      el('div', { class: 'chart-wrap short' }, [el('canvas', { id: canvasId })]),
      ...(extra || []),
    ]);
  }

  function renderHistoryTab(host) {
    const track = detail.track || [];
    if (!track.length) {
      host.append(el('div', { class: 'empty', text: 'No heartbeats with coordinates in this time range.' }));
      return;
    }
    host.append(
      el('div', { class: 'stack' }, [
        chartBlock('GPS accuracy per heartbeat', 'metres · lower is better', 'chart-acc'),
        chartBlock('Battery per heartbeat', 'per cent', 'chart-batt'),
        chartBlock('Geofence state per heartbeat', 'what the device reported in each heartbeat', 'chart-geo', [
          el('div', {
            html: PMChart.legend([
              { color: C.in, label: 'Inside fence' },
              { color: C.out, label: 'Outside fence' },
              { color: C.unknown, label: 'No fence flag' },
            ]),
          }),
        ]),
      ])
    );

    const labels = track.map((p) => fmt.dayTime(p.at));
    PMChart.lineTime(document.querySelector('#chart-acc'), {
      labels,
      yTitle: 'metres',
      series: [{ label: 'GPS accuracy', data: track.map((p) => p.accuracy), color: C.series[0] }],
    });
    PMChart.lineTime(document.querySelector('#chart-batt'), {
      labels,
      yTitle: 'battery %',
      series: [{ label: 'Battery', data: track.map((p) => p.battery), color: C.series[3] }],
    });
    PMChart.stackedTime(document.querySelector('#chart-geo'), {
      labels,
      yTitle: 'heartbeats',
      datasets: [
        { label: 'Inside', data: track.map((p) => (p.insideGeofence === true ? 1 : 0)), color: C.in },
        { label: 'Outside', data: track.map((p) => (p.insideGeofence === false ? 1 : 0)), color: C.out },
        { label: 'No flag', data: track.map((p) => (p.insideGeofence === null ? 1 : 0)), color: C.unknown },
      ],
    });
  }

  /**
   * Heartbeats: one row per stored ekosClientState document, straight from
   * /api/snapshots so each row carries the recomputed geofence verdict and the
   * distance to the boundary - not just what the app claimed. Paged, because a
   * busy device writes thousands per day.
   */
  async function renderHeartbeatsTab(host) {
    host.append(
      el('div', { class: 'tab-block' }, [
        tabHeader(
          'Every stored heartbeat for this user, newest first - one document per device ping',
          el('button', {
            class: 'btn btn-sm',
            text: '↓ CSV',
            onclick: () => window.open('/api/snapshots.csv?' + queryString({ userId, limit: 2000 }), '_blank'),
          })
        ),
        el('div', { class: 'chips', id: 'hb-summary' }),
        el('div', { id: 'hb-table' }, [el('div', { class: 'empty', text: 'loading heartbeats…' })]),
        el('div', { class: 'pager', id: 'hb-pager' }),
      ])
    );
    await loadHeartbeats();
  }

  async function loadHeartbeats() {
    PM.showSkeleton({ '#hb-table': 'table:12x8' }, { force: true });
    const table = document.querySelector('#hb-table');
    if (!table) return;
    let data;
    try {
      data = await api('/api/snapshots?' + queryString({ userId, limit: 100, page: heartbeatPage }));
    } catch (err) {
      table.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
      return;
    }
    const rows = data.rows || [];
    tabs.setCount('heartbeats', data.total);

    const summary = document.querySelector('#hb-summary');
    const noFix = rows.filter((r) => !r.location).length;
    const mismatches = rows.filter((r) => r.verdictDisagrees).length;
    const uncertain = rows.filter((r) => r.computedVerdict === 'unknown').length;
    const offline = rows.filter((r) => r.offline).length;
    summary.innerHTML =
      '<span class="chip"><b>' + fmt.int(data.total) + '</b>&nbsp;heartbeats in range</span>' +
      '<span class="chip"><b>' + noFix + '</b>&nbsp;without coordinates on this page</span>' +
      '<span class="chip"><b>' + uncertain + '</b>&nbsp;uncertain verdict</span>' +
      '<span class="chip"><b>' + mismatches + '</b>&nbsp;app/geometry mismatch</span>' +
      '<span class="chip"><b>' + offline + '</b>&nbsp;offline</span>';

    table.innerHTML = '';
    if (!rows.length) {
      table.append(el('div', { class: 'empty', text: 'No heartbeats in this time range.' }));
      document.querySelector('#hb-pager').innerHTML = '';
      return;
    }

    // Same table, same gap rows and same drawer as the Heartbeats page - this
    // is that page filtered to one person.
    PMHeartbeats.table(table, rows, { gapRows: true, onOpen: openHeartbeat });
    const pager = document.querySelector('#hb-pager');
    pager.innerHTML = '';
    pager.append(
      el('span', { text: 'Showing ' + rows.length + ' of ' + fmt.int(data.total) + ' · page ' + heartbeatPage }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm',
        text: '← Newer',
        disabled: heartbeatPage <= 1 ? 'disabled' : null,
        onclick: () => {
          heartbeatPage -= 1;
          loadHeartbeats();
        },
      }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Older →',
        disabled: heartbeatPage * 100 >= data.total ? 'disabled' : null,
        onclick: () => {
          heartbeatPage += 1;
          loadHeartbeats();
        },
      })
    );
  }

  /** One heartbeat, expanded - the fields that do not fit the table. */
  function openHeartbeat(row) {
    // The row may not carry the person (this page already knows them), so fill
    // the name in for the drawer subtitle.
    PMHeartbeats.drawer({ ...row, name: row.name || (detail.current && detail.current.name) || null });
  }
  function tabHeader(text, action) {
    return el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap' }, [
      el('span', { class: 'hint', text }),
      el('div', { style: 'flex:1' }),
      action || null,
    ]);
  }

  function renderCallsTab(host) {
    const logs = detail.logs || [];
    const block = el('div', { class: 'tab-block' });
    host.append(block);
    block.append(
      tabHeader(
        logs.length + ' most recent validation calls for this user',
        el('a', {
          class: 'btn btn-sm',
          href: '/checks.html?userId=' + encodeURIComponent(userId),
          target: '_blank',
          rel: 'noopener',
          text: 'Open in Geofence Checks ↗',
        })
      )
    );
    if (!logs.length) {
      block.append(el('div', { class: 'empty', text: 'No geofence validation calls recorded for this user.' }));
      return;
    }

    const failed = logs.filter((l) => l.actualIsWithinRadius === false).length;
    const grace = logs.filter((l) => l.graceApplied).length;
    const uncertain = logs.filter((l) => l.verdict === 'unknown').length;
    const clockOuts = logs.filter((l) => l.triggeredClockOut).length;
    block.append(
      el('div', { class: 'chips' }, [
        el('span', { class: 'chip', html: '<b>' + logs.length + '</b>&nbsp;calls' }),
        el('span', { class: 'chip', html: '<b>' + failed + '</b>&nbsp;failed the raw geometry' }),
        el('span', { class: 'chip', html: '<b>' + grace + '</b>&nbsp;passed only on accuracy padding' }),
        el('span', { class: 'chip', html: '<b>' + uncertain + '</b>&nbsp;uncertain' }),
        el('span', { class: 'chip', html: '<b>' + clockOuts + '</b>&nbsp;auto clock-outs' }),
      ])
    );

    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>When</th><th>Site</th><th class="num">Accuracy</th><th class="num">From boundary</th>' +
      '<th>Reported</th><th>Geometry</th><th>Recomputed</th><th>Outcome</th></tr></thead>';
    const body = el('tbody');
    for (const log of logs) {
      body.append(
        el('tr', {
          html:
            '<td>' + fmt.dayTime(log.capturedAt) + '<div class="person-sub">' + fmt.ago(log.capturedAt) + '</div></td>' +
            '<td>' +
            (log.siteId != null ? 'Site ' + log.siteId : '<span class="badge badge-neutral">unmapped</span>') +
            '<div class="person-sub" title="' + esc(log.siteAddress || '') + '">' + esc(log.siteAddress || '') + '</div></td>' +
            '<td class="num">' + PM.accuracyBadge(log.accuracyBand, log.accuracy) + '</td>' +
            '<td class="num">' +
            (log.relation ? (log.relation.inside ? '−' : '+') + fmt.metres(Math.abs(log.relation.distanceFromBoundary)) : '--') +
            '</td>' +
            '<td>' +
            (log.isWithinRadius ? '<span class="badge badge-good">within</span>' : '<span class="badge badge-critical">outside</span>') +
            '</td>' +
            '<td>' +
            (log.actualIsWithinRadius
              ? '<span class="badge badge-good">within</span>'
              : '<span class="badge badge-critical">outside</span>') +
            (log.graceApplied ? '<div class="person-sub">grace +' + fmt.metres(log.radiusPadding) + '</div>' : '') +
            '</td>' +
            '<td>' + PM.geofenceBadge(null, log.verdict, log.verdictReason) + '</td>' +
            '<td>' +
            (log.triggeredClockOut
              ? '<span class="badge badge-serious">auto clock-out</span>'
              : log.outsideCount
                ? '<span class="badge badge-warning">streak ' + log.outsideCount + '</span>'
                : '<span class="badge badge-neutral">no action</span>') +
            '</td>',
        })
      );
    }
    table.append(body);
    block.append(el('div', { class: 'table-block' }, [el('div', { class: 'table-scroll' }, [table])]));
  }

  /**
   * The same table and the same drawer as the Exit Windows page - this tab is
   * that page, filtered to one person, so it renders through the shared view
   * instead of a thinner copy that could not be opened.
   */
  function renderExitWindowsTab(host) {
    const windows = detail.exitWindows || [];
    const anon = ((PM.state.meta || {}).exitWindows || {}).anonymousWindows || 0;

    host.append(
      tabHeader(
        windows.length + ' exit window(s) matched to this user · click one to replay its samples',
        el('a', { class: 'btn btn-sm', href: '/exit-windows.html', text: 'All exit windows' })
      )
    );

    const empty = el('div', { class: 'empty' }, [
      el('div', { text: 'No exit windows matched this user.' }),
      anon
        ? el('div', { class: 'hint', style: 'margin-top:8px;max-width:600px;margin-left:auto;margin-right:auto' }, [
            document.createTextNode(
              'The ' +
                anon +
                ' exit windows in this database carry userId: null, so they are matched to people by comparing each ' +
                'window’s GPS samples against the heartbeat stream. None of them matched this user in this time range. '
            ),
            el('a', { href: '/exit-windows.html', text: 'See all windows' }),
          ])
        : null,
    ]);

    const body = el('div');
    host.append(body);
    PMExitWindows.table(body, windows, { empty });
  }
  /**
   * The load failed. A user who simply has not reported inside the selected
   * range is not an error, so that case says so and offers the wider ranges
   * rather than leaving a dead end.
   */
  function renderLoadFailure(err) {
    const info = (err && err.payload) || {};
    const host = document.querySelector('#hero');
    host.innerHTML = '';
    const box = el('div', { class: 'empty', style: 'width:100%' });
    if (info.outOfRange) {
      box.append(
        el('div', { text: 'No heartbeats from this user in the selected range.' }),
        el('div', {
          class: 'hint',
          style: 'margin-top:6px',
          text: info.lastSeenAt ? 'Last seen ' + fmt.date(info.lastSeenAt) + ' (' + fmt.ago(info.lastSeenAt) + ').' : '',
        }),
        el('div', { style: 'margin-top:12px;display:flex;gap:8px;justify-content:center' }, [
          el('button', { class: 'btn btn-sm', text: 'Last 24 hours', onclick: () => PM.setFilter('range', '24h') }),
          el('button', { class: 'btn btn-sm', text: 'Last 7 days', onclick: () => PM.setFilter('range', '7d') }),
          el('button', { class: 'btn btn-sm', text: 'All time', onclick: () => PM.setFilter('range', 'all') }),
        ])
      );
      PM.setSubtitle('quiet in this range');
    } else {
      box.append(el('div', { text: err.message }));
      PM.setSubtitle('could not load this user');
    }
    host.append(box);
  }

  function renderRawTab(host) {
    host.append(
      tabHeader(
        'Newest snapshot for this user, exactly as stored in MongoDB',
        el('button', { class: 'btn btn-sm', text: '⧉ Copy JSON', onclick: copyJson })
      ),
      el('pre', { class: 'json', style: 'max-height:600px', html: PM.jsonHighlight(detail.raw) })
    );
  }

  function copyJson() {
    if (!detail) return;
    navigator.clipboard
      .writeText(JSON.stringify(detail.raw, null, 2))
      .then(() => PM.toast('Raw document copied', 'ok'))
      .catch(() => PM.toast('Could not copy', 'error'));
  }
})();
