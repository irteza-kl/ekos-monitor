/* Live Map: full-bleed situational view - devices, fences, trails, guidance. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let map = null;
  let layers = [];
  let devices = [];
  let sites = [];
  let selected = null;

  const opts = {
    fences: localStorage.getItem('pm.map.fences') !== '0',
    halos: localStorage.getItem('pm.map.halos') !== '0',
    labels: localStorage.getItem('pm.map.labels') === '1',
    trails: localStorage.getItem('pm.map.trails') === '1',
  };

  PM.boot('map.html', async ({ root, meta }) => {
    PM.buildFilterBar(() => [
      { kind: 'daterange' },
      { kind: 'multi', key: 'tenantId', label: 'Tenant', options: PM.optionsFrom(meta.tenants || [], 'id', 'name', 'snapshots') },
      { kind: 'multi', key: 'userId', label: 'User', options: PM.optionsFrom(meta.users || [], 'id', 'name', 'snapshots') },
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: PM.optionsFrom(meta.jobSiteIds || [], 'id', 'id', 'snapshots') },
      { kind: 'multi', key: 'deviceType', label: 'Device', options: PM.optionsFrom(meta.deviceTypes || [], 'key', 'key', 'count') },
      { kind: 'tri', key: 'clockedIn', label: 'Clocked in', yes: 'On the clock', no: 'Off the clock' },
      { kind: 'tri', key: 'insideGeofence', label: 'Inside fence', yes: 'Inside', no: 'Outside', nullable: true },
      { kind: 'number', key: 'accuracyMax', label: 'Accuracy <= m' },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'name, ref, email' },
    ]);

    root.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Situational map' }),
          el('span', { class: 'sub', id: 'map-sub' }),
          el('div', { class: 'spacer' }),
          toggle('fences', 'Fences'),
          toggle('halos', 'Accuracy halos'),
          toggle('labels', 'Name labels'),
          toggle('trails', 'Trails (last 200 fixes)'),
          el('button', { class: 'btn btn-sm', text: '⤢ Fit all', onclick: fitAll }),
        ]),
        el('div', { class: 'card-body tight' }, [
          el('div', { style: 'display:grid;grid-template-columns:1fr 320px' }, [
            el('div', { class: 'map tall', id: 'live-map' }),
            el('div', {
              id: 'device-list',
              style: 'border-left:1px solid var(--border);overflow:auto;max-height:calc(100vh - 260px)',
            }),
          ]),
        ]),
        el('div', { html: PMMap.legend() }),
      ])
    );

    map = PMMap.create(document.querySelector('#live-map'));
    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  function toggle(key, label) {
    const id = 'toggle-' + key;
    const wrap = el('label', {
      class: 'chip',
      style: 'cursor:pointer',
      for: id,
    });
    const box = el('input', {
      type: 'checkbox',
      id,
      checked: opts[key] ? 'checked' : null,
      onchange: (e) => {
        opts[key] = e.target.checked;
        localStorage.setItem('pm.map.' + key, e.target.checked ? '1' : '0');
        draw();
      },
    });
    wrap.append(box, document.createTextNode(label));
    return wrap;
  }

  async function load() {
    PM.showSkeleton({
      '#live-map': 'map',
      '#device-list': 'list:6',
    });
    const [users, siteData] = await Promise.all([
      api('/api/users?' + queryString() + '&limit=200'),
      api('/api/sites?' + queryString()),
    ]);
    devices = users.rows || [];
    sites = (siteData.rows || []).filter((s) => s.plottable);
    draw();
    PM.setSubtitle(devices.filter((d) => d.location).length + ' devices with a fix · ' + sites.length + ' plottable sites');
    PM.markLoaded();
  }

  async function draw() {
    PMMap.clear(layers);
    layers = [];

    if (opts.fences) for (const site of sites) layers.push(PMMap.siteCircle(map, site));

    for (const row of devices) {
      if (!row.location) continue;
      const clone = opts.halos ? row : { ...row, location: { ...row.location, accuracy: null } };
      layers.push(
        PMMap.deviceMarker(map, clone, {
          pulse: row.ageMinutes !== null && row.ageMinutes < 5,
          permanentLabel: opts.labels,
          onClick: () => select(row),
        })
      );
      if (row.guide && row.fence) {
        layers.push(
          PMMap.guideLine(map, row.location, row.fence, {
            text: fmt.metres(row.guide.distanceMetres) + ' ' + (row.guide.compass || '') + ' of fence',
          })
        );
      }
    }

    if (opts.trails) {
      const targets = devices.filter((d) => d.location).slice(0, 8);
      const tracks = await Promise.all(
        targets.map((d) =>
          api('/api/users/' + (d.userId === null ? 'anonymous' : d.userId) + '/track?limit=200&' + queryString()).catch(() => null)
        )
      );
      for (const track of tracks) if (track) layers.push(PMMap.track(map, track.points, { dots: false, weight: 2 }));
    }

    renderList();
    document.querySelector('#map-sub').textContent =
      devices.filter((d) => d.location).length +
      ' devices · ' +
      (opts.fences ? sites.length + ' fences' : 'fences hidden') +
      (opts.trails ? ' · trails on' : '');
    if (!selected) fitAll();
  }

  function fitAll() {
    const points = devices.filter((d) => d.location).map((d) => d.location);
    if (opts.fences) for (const s of sites) points.push({ lat: s.lat, lng: s.lng });
    PMMap.fit(map, points);
  }

  function select(row) {
    selected = row;
    if (row.location) map.setView([row.location.lat, row.location.lng], 17, { animate: true });
    renderList();
  }

  function renderList() {
    const host = document.querySelector('#device-list');
    host.innerHTML = '';
    host.append(
      el('div', {
        class: 'card-head',
        style: 'border-bottom:1px solid var(--border)',
        html: '<h2>Devices</h2><span class="sub">' + devices.length + ' in view</span>',
      })
    );
    if (!devices.length) {
      host.append(el('div', { class: 'empty', text: 'Nothing matches these filters.' }));
      return;
    }
    for (const row of devices) {
      const isSelected = selected && selected.userId === row.userId;
      const item = el('div', {
        style:
          'padding:11px 13px;border-bottom:1px solid var(--grid);cursor:pointer;' +
          (isSelected ? 'background:var(--surface-3)' : ''),
        onclick: () => select(row),
        html:
          '<div style="display:flex;align-items:center;gap:8px">' +
          '<span class="map-marker" style="position:static;background:' +
          PMMap.verdictColor(row.computedVerdict, row.isInsideGeofence) +
          '"></span>' +
          '<b style="font-size:13px">' +
          esc(row.name || 'Unidentified device') +
          '</b></div>' +
          '<div class="person-sub" style="margin-top:3px">' +
          esc(row.tenantName || 'no tenant') +
          ' · ' +
          esc(row.deviceType || '?') +
          ' · ' +
          (row.battery === null ? '?' : row.battery + '%') +
          '</div>' +
          '<div style="margin-top:6px;display:flex;gap:5px;flex-wrap:wrap">' +
          PM.geofenceBadge(row.isInsideGeofence, row.computedVerdict, row.verdictReason) +
          PM.accuracyBadge(row.accuracyBand, row.accuracy) +
          (row.clockedIn ? '<span class="badge badge-info">on clock</span>' : '') +
          '</div>' +
          (row.location ? '<div class="person-sub" style="margin-top:5px">' + fmt.coords(row.location) + ' · ' + fmt.ago(row.capturedAt) + '</div>' : '<div class="person-sub" style="margin-top:5px">no fix</div>') +
          '<div style="margin-top:6px"><a href="/user.html?userId=' + (row.userId === null ? 'anonymous' : row.userId) + '" target="_blank" rel="noopener">Open user page ↗</a></div>' +
          (row.guide
            ? '<div class="person-sub" style="margin-top:4px;color:' +
              C.warning +
              '">' +
              fmt.metres(row.guide.distanceMetres) +
              ' ' +
              (row.guide.compass || '') +
              ' outside · <a href="' +
              row.guide.directionsUrl +
              '" target="_blank" rel="noopener">directions ↗</a></div>'
            : ''),
      });
      host.append(item);
    }
  }
})();
