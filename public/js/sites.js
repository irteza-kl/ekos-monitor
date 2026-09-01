/* Geofence Sites: the fence registry, live occupancy and per-site health. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let map = null;
  let layers = [];
  let sites = [];

  PM.boot('sites.html', async ({ root, meta }) => {
    PM.buildFilterBar([
      { kind: 'daterange' },
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: PM.optionsFrom(meta.jobSiteIds || [], 'id', 'id', 'snapshots') },
      { kind: 'multi', key: 'tenantId', label: 'Tenant', options: PM.optionsFrom(meta.tenants || [], 'id', 'name', 'snapshots') },
      { kind: 'tri', key: 'clockedIn', label: 'Occupants clocked in', yes: 'On the clock', no: 'Off the clock' },
    ]);

    root.append(
      el('div', { class: 'tiles', id: 'site-tiles' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Fence map' }),
          el('span', { class: 'sub', id: 'map-sub' }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm', text: '↓ CSV', onclick: () => window.open('/api/sites.csv', '_blank') }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'map', id: 'sites-map' })]),
        el('div', { html: PMMap.legend() }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Sites' }),
          el('span', { class: 'sub', text: 'click a site to zoom and see who is on it' }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'sites-table' })]),
      ])
    );

    map = PMMap.create(document.querySelector('#sites-map'));
    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  async function load() {
    const data = await api('/api/sites?' + queryString());
    sites = data.rows || [];
    renderTiles(data);
    renderMap();
    renderTable();
    PM.setSubtitle(sites.length + ' sites · ' + data.withFence + ' with a stored radius');
    PM.markLoaded();
  }

  function renderTiles(data) {
    const host = document.querySelector('#site-tiles');
    host.innerHTML = '';
    const tile = (label, value, note, tone) =>
      el('div', { class: 'tile ' + (tone ? 'is-' + tone : '') }, [
        el('div', { class: 'tile-label', text: label }),
        el('div', { class: 'tile-value', text: value }),
        el('div', { class: 'tile-note', text: note }),
      ]);
    const occupied = sites.filter((s) => s.occupancy.total > 0);
    const outside = sites.reduce((a, s) => a + s.occupancy.outside, 0);
    const noFence = sites.filter((s) => !s.hasFence);
    const breaches = sites.reduce((a, s) => a + (s.outsideEvents || 0), 0);
    host.append(
      tile('Sites seen', fmt.int(sites.length), data.plottable + ' can be plotted'),
      tile('Occupied now', fmt.int(occupied.length), sites.reduce((a, s) => a + s.occupancy.total, 0) + ' people on site'),
      tile('People outside their fence', fmt.int(outside), 'from the newest snapshot each', outside ? 'critical' : undefined),
      tile('Missing a radius', fmt.int(noFence.length), 'centre derived from device fixes', noFence.length ? 'warning' : undefined),
      tile('Boundary failures logged', fmt.int(breaches), 'validation calls that failed the geometry', breaches ? 'warning' : undefined),
      tile('Auto clock-outs', fmt.int(sites.reduce((a, s) => a + (s.clockOutEvents || 0), 0)), 'triggered at these sites')
    );
  }

  function renderMap() {
    PMMap.clear(layers);
    layers = [];
    const points = [];
    for (const site of sites) {
      if (!site.plottable) continue;
      layers.push(PMMap.siteCircle(map, site));
      points.push({ lat: site.lat, lng: site.lng });
      for (const person of site.present) {
        if (!person.location) continue;
        layers.push(
          PMMap.deviceMarker(
            map,
            {
              name: person.name,
              location: person.location,
              accuracy: person.location.accuracy,
              computedVerdict: person.verdict,
              verdictReason: person.verdictReason,
              isInsideGeofence: person.insideGeofence,
              relation: person.relation,
              clockedIn: person.clockedIn,
              capturedAt: person.capturedAt,
              jobSiteId: site.siteId,
              battery: person.battery,
              site,
            },
            { pulse: person.ageMinutes !== null && person.ageMinutes < 5 }
          )
        );
        points.push(person.location);
      }
    }
    PMMap.fit(map, points);
    document.querySelector('#map-sub').textContent =
      sites.filter((s) => s.plottable).length + ' plotted · dashed circles are sites with no stored radius';
  }

  function renderTable() {
    const host = document.querySelector('#sites-table');
    host.innerHTML = '';
    if (!sites.length) {
      host.append(el('div', { class: 'empty', text: 'No sites found in this range.' }));
      return;
    }
    const maxChecks = Math.max(1, ...sites.map((s) => s.validations || 0));
    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>Site</th><th>Coordinates</th><th class="num">Radius</th><th>On site now</th><th class="num">Checks</th><th class="num">Failed</th><th class="num">Grace</th><th class="num">Auto clock-outs</th><th class="num">Avg accuracy</th><th>Last activity</th></tr></thead>';
    const body = el('tbody');
    for (const site of sites) {
      body.append(
        el('tr', {
          class: 'clickable',
          onclick: () => openSite(site),
          html:
            '<td><b>' + (site.siteId != null ? 'Site ' + site.siteId : 'Fence') + '</b>' +
            '<div class="person-sub" title="' + esc(site.address || '') + '">' +
            esc(site.address || 'no address on record') + '</div></td>' +
            '<td class="mono">' + (site.plottable ? fmt.coords(site) : '--') +
            '<div class="person-sub">' + (site.source === 'geofence-log' ? 'from geofence log' : 'derived from fixes') + '</div></td>' +
            '<td class="num">' + (site.radius != null ? fmt.metres(site.radius) : '<span class="badge badge-warning">unknown</span>') + '</td>' +
            '<td>' + occupancyCell(site) + '</td>' +
            '<td class="num">' + fmt.int(site.validations || 0) + ' ' + PM.meter(site.validations || 0, maxChecks, C.series[6]) + '</td>' +
            '<td class="num">' + (site.outsideEvents ? '<span class="badge badge-critical">' + site.outsideEvents + '</span>' : '0') + '</td>' +
            '<td class="num">' + (site.graceEvents ? '<span class="badge badge-warning">' + site.graceEvents + '</span>' : '0') + '</td>' +
            '<td class="num">' + fmt.int(site.clockOutEvents || 0) + '</td>' +
            '<td class="num">' + fmt.accuracy(site.avgAccuracy !== null && site.avgAccuracy !== undefined ? site.avgAccuracy : site.snapshotAvgAccuracy) + '</td>' +
            '<td>' + fmt.ago(site.lastSeenAt || site.lastValidationAt) + '</td>',
        })
      );
    }
    table.append(body);
    host.append(table);
  }

  function occupancyCell(site) {
    const o = site.occupancy;
    if (!o.total) return '<span class="badge badge-neutral">empty</span>';
    const parts = [];
    if (o.inside) parts.push('<span class="badge badge-good">' + o.inside + ' inside</span>');
    if (o.outside) parts.push('<span class="badge badge-critical">' + o.outside + ' outside</span>');
    if (o.unknown) parts.push('<span class="badge badge-neutral">' + o.unknown + ' unflagged</span>');
    return parts.join(' ');
  }

  function openSite(site) {
    PM.openDrawer({
      title: site.siteId != null ? 'Site ' + site.siteId : 'Unmapped fence',
      subtitle: site.address || 'no address on record',
      tabs: [
        {
          id: 'map',
          label: 'Fence & occupants',
          render: (host) => {
            const mapHost = el('div', { class: 'map mini', style: 'height:320px' });
            host.append(mapHost, el('div', { html: PMMap.legend() }));
            const m = PMMap.create(mapHost);
            setTimeout(() => m.invalidateSize(), 60);
            const points = [];
            if (site.plottable) {
              PMMap.siteCircle(m, site, { label: false });
              points.push({ lat: site.lat, lng: site.lng });
            }
            for (const person of site.present) {
              if (!person.location) continue;
              PMMap.deviceMarker(
                m,
                {
                  name: person.name,
                  location: person.location,
                  accuracy: person.location.accuracy,
                  computedVerdict: person.verdict,
                  isInsideGeofence: person.insideGeofence,
                  relation: person.relation,
                  clockedIn: person.clockedIn,
                  capturedAt: person.capturedAt,
                  battery: person.battery,
                  jobSiteId: site.siteId,
                },
                { permanentLabel: true }
              );
              points.push(person.location);
            }
            PMMap.fit(m, points, { zoom: 17 });

            host.append(
              el('div', { class: 'section-title', text: 'Who is here' }),
              site.present.length
                ? el('div', { class: 'table-scroll' }, [presentTable(site)])
                : el('div', { class: 'empty', text: 'Nobody is currently clocked into this site.' })
            );
          },
        },
        {
          id: 'facts',
          label: 'Fence record',
          render: (host) =>
            host.append(
              PM.kv([
                ['Site ID', site.siteId === null ? 'n/a' : String(site.siteId)],
                ['Coordinate source', site.source === 'geofence-log' ? 'geofence validation log (authoritative)' : 'derived from device fixes'],
                ['Centre', site.plottable ? fmt.coords(site) : 'unknown'],
                ['Radius', site.radius != null ? fmt.metres(site.radius) : 'not on record'],
                ['Largest effective radius used', site.effectiveRadius != null ? fmt.metres(site.effectiveRadius) : '--'],
                ['Address', site.address || '--'],
                ['City / country', [site.city, site.country].filter(Boolean).join(', ') || '--'],
                ['Fence last updated', site.updatedAt ? fmt.date(site.updatedAt) : '--'],
                ['Validation calls', fmt.int(site.validations)],
                ['Failed the geometry', fmt.int(site.outsideEvents) + (site.breachRate !== null ? ' (' + fmt.pct(site.breachRate) + ')' : '')],
                ['Saved by accuracy grace', fmt.int(site.graceEvents)],
                ['Auto clock-outs', fmt.int(site.clockOutEvents)],
                ['Snapshots', fmt.int(site.snapshots) + ' (' + fmt.int(site.insideSnapshots) + ' inside / ' + fmt.int(site.outsideSnapshots) + ' outside)'],
                ['Distinct users', fmt.int(site.users)],
                ['Avg accuracy on site', fmt.accuracy(site.avgAccuracy)],
                ['Worst accuracy on site', fmt.accuracy(site.worstAccuracy)],
                ['Open in maps', site.mapsUrl ? '<a href="' + site.mapsUrl + '" target="_blank" rel="noopener">View this fence centre ↗</a>' : '--'],
              ])
            ),
        },
      ],
    });
  }

  function presentTable(site) {
    const table = el('table');
    table.innerHTML = '<thead><tr><th>Person</th><th>State</th><th class="num">From boundary</th><th class="num">Accuracy</th><th>Seen</th><th>Guide</th></tr></thead>';
    const body = el('tbody');
    for (const p of site.present) {
      const guide =
        p.relation && !p.relation.inside && site.plottable
          ? '<a href="https://www.google.com/maps/dir/?api=1&origin=' +
            p.location.lat + ',' + p.location.lng +
            '&destination=' + site.lat + ',' + site.lng +
            '&travelmode=walking" target="_blank" rel="noopener">directions ↗</a>'
          : '--';
      body.append(
        el('tr', {
          html:
            '<td>' + esc(p.name || 'user ' + p.userId) + '<div class="person-sub">' + (p.clockedIn ? 'on the clock' : 'off the clock') + '</div></td>' +
            '<td>' + PM.geofenceBadge(p.insideGeofence, p.verdict, p.verdictReason) + '</td>' +
            '<td class="num">' + (p.relation ? (p.relation.inside ? '−' : '+') + fmt.metres(Math.abs(p.relation.distanceFromBoundary)) : '--') + '</td>' +
            '<td class="num">' + fmt.accuracy(p.accuracy) + '</td>' +
            '<td>' + fmt.ago(p.capturedAt) + '</td>' +
            '<td>' + guide + '</td>',
        })
      );
    }
    table.append(body);
    return table;
  }
})();
