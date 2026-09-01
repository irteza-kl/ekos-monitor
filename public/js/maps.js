/* ==========================================================================
   Leaflet helpers. Leaflet itself is vendored (public/vendor/leaflet.js) - the
   only network call a map makes is for raster tiles, which need no key or
   account. Point BASEMAPS below at an internal tile server if even that must go.
   ========================================================================== */
window.PMMap = (function () {
  'use strict';

  const C = window.PM.colors;
  const fmt = window.PM.fmt;
  const esc = window.PM.esc;

  // Every mark sits directly on the pale canvas, so its ring is white in both
  // themes - a dark ring from the app surface would vanish into the roads.
  const RING = '#ffffff';

  /**
   * One base map per theme, deliberately quiet: a canvas of roads, land and
   * water with no points of interest - no shops, no clinics, no restaurant pins.
   * The map is a backdrop for our own markers, so anything it draws that is not
   * a road or a shoreline is noise competing with the data.
   *
   * Dark mode gets Esri’s dark canvas, which is *drawn* dark - the same
   * cartography, rendered for a dark ground. That is not the same thing as
   * inverting the light one, which is what this used to do and what made the
   * streets and labels hard to read.
   *
   * Place names ride in a separate transparent layer on top, which is why they
   * stay crisp while the canvas underneath stays flat.
   *
   * All four layers are keyless and account-free - no API key, no watermark
   * (CARTO Positron and Dark Matter, the other obvious choices, stamp "API KEY
   * REQUIRED" across every tile unless you pay for one). The canvas stops at
   * zoom 16, so Leaflet upscales it for 17 and 18 - slightly soft, still
   * legible - and the map refuses to zoom past 18 rather than show a smeared
   * basemap or Esri’s "map data not yet available" placeholder.
   */
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  // Zoom as far as Leaflet will go. The canvas itself is only rendered to zoom
  // 16, so past that Leaflet upscales those tiles (maxNativeZoom): street names
  // go soft and eventually the basemap is just colour, while the overlays -
  // markers, fences, accuracy circles, trails - stay vector-sharp all the way
  // down. Beyond ~19 the basemap is context, not detail; the data is the point.
  const MAX_ZOOM = 21;
  const ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ';
  const BASEMAPS = {
    light: {
      base: ESRI + 'World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      labels: ESRI + 'World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    },
    dark: {
      base: ESRI + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      labels: ESRI + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    },
  };
  const TILE_OPTS = { maxZoom: MAX_ZOOM, maxNativeZoom: 16 };

  /** Which basemap the page is currently asking for. */
  function themeKey() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return 'dark';
    if (attr === 'light') return 'light';
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    return mq && mq.matches ? 'dark' : 'light';
  }

  // Live map instances, newest last. Nothing in the app depends on this - it's
  // a handle for debugging and for the headless checks.
  const instances = [];

  function create(target, options) {
    const map = L.map(target, {
      maxZoom: MAX_ZOOM,
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
      worldCopyJump: true,
      ...(options || {}),
    });

    const set = BASEMAPS[themeKey()];
    const base = L.tileLayer(set.base, { ...TILE_OPTS, attribution: ATTRIBUTION, zIndex: 1 }).addTo(map);
    // Labels sit above the canvas but still below every overlay pane, so a
    // marker or a fence always wins against a street name.
    const labels = L.tileLayer(set.labels, { ...TILE_OPTS, zIndex: 2 }).addTo(map);
    map.__pmBasemap = { base, labels };

    // A scale bar: every question on this map is a distance question, and
    // "is that dot outside the fence" is unanswerable without one.
    L.control.scale({ imperial: false, maxWidth: 130, position: 'bottomleft' }).addTo(map);

    map.setView([20, 0], 2);
    instances.push(map);
    return map;
  }

  /**
   * Popups are small data cards: a titled head, then aligned label/value rows.
   * A run of `label: value<br>` lines is what this used to be, and it reads
   * badly - nothing separates the identity of the thing from its facts, and no
   * two values line up. Values may carry markup; the caller escapes those.
   */
  function popupCard(spec) {
    const rows = (spec.rows || [])
      .filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '')
      .map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>')
      .join('');
    return (
      '<div class="mp">' +
      '<div class="mp-head">' +
      '<div class="mp-title">' +
      (spec.color ? '<i class="mp-dot" style="background:' + spec.color + '"></i>' : '') +
      '<span>' + esc(spec.title || '') + '</span>' +
      '</div>' +
      (spec.sub ? '<div class="mp-sub">' + esc(spec.sub) + '</div>' : '') +
      '</div>' +
      (rows ? '<dl class="mp-rows">' + rows + '</dl>' : '') +
      (spec.foot ? '<div class="mp-foot">' + spec.foot + '</div>' : '') +
      '</div>'
    );
  }

  /** Colour for a geofence verdict - matched to the badge colours. */
  function verdictColor(verdict, insideFlag) {
    if (verdict === 'unknown') return C.warning;
    if (verdict === 'in') return C.in;
    if (verdict === 'out') return C.out;
    if (insideFlag === true) return C.in;
    if (insideFlag === false) return C.out;
    return C.unknown;
  }

  /** A person/device marker: dot, accuracy halo, popup, optional pulse. */
  function deviceMarker(map, row, opts) {
    const options = opts || {};
    if (!row.location) return null;
    const color = verdictColor(row.computedVerdict, row.isInsideGeofence);
    const layers = [];

    if (row.location.accuracy) {
      layers.push(
        L.circle([row.location.lat, row.location.lng], {
          radius: row.location.accuracy,
          color,
          weight: 1,
          opacity: 0.55,
          fillColor: color,
          fillOpacity: 0.1,
          interactive: false,
        })
      );
    }

    const icon = L.divIcon({
      className: '',
      html:
        '<div class="map-marker' +
        (options.pulse ? ' pulse' : '') +
        '" style="background:' +
        color +
        ';color:' +
        color +
        ';position:relative"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    const marker = L.marker([row.location.lat, row.location.lng], { icon, title: row.name || 'device' });
    marker.bindPopup(devicePopup(row), { maxWidth: 340, minWidth: 210 });
    if (options.onClick) marker.on('click', () => options.onClick(row));
    layers.push(marker);

    if (options.label !== false) {
      // Hover by default: permanent labels collide as soon as two devices are
      // near each other. Pages that need always-on names pass permanentLabel.
      marker.bindTooltip(row.name || 'User ' + row.userId, {
        permanent: !!options.permanentLabel,
        direction: 'right',
        offset: [10, 0],
        className: 'map-label',
      });
    }

    const group = L.layerGroup(layers).addTo(map);
    return { group, marker, color };
  }

  function devicePopup(row) {
    const rel = row.relation;
    return popupCard({
      color: verdictColor(row.computedVerdict, row.isInsideGeofence),
      title: row.name || 'Unidentified device',
      sub: [row.employeeRef, row.tenantName].filter(Boolean).join(' · '),
      rows: [
        ['Fix', fmt.coords(row.location) + ' · ' + fmt.accuracy(row.accuracy)],
        [
          'State',
          (row.clockedIn ? 'clocked in' : 'clocked out') +
            ' · ' +
            (row.isInsideGeofence === true ? 'inside fence' : row.isInsideGeofence === false ? 'outside fence' : 'no fence flag'),
        ],
        [
          'Recomputed',
          row.computedVerdict
            ? '<b>' + esc(row.computedVerdict) + '</b>' + (row.verdictReason ? '<span class="mp-note">' + esc(row.verdictReason) + '</span>' : '')
            : null,
        ],
        ['Boundary', rel ? fmt.metres(rel.distanceFromBoundary) + (rel.inside ? ' inside' : ' outside') + ' · ' + rel.compass : null],
        [
          'Site',
          row.jobSiteId != null
            ? row.jobSiteId + (row.site && row.site.address ? '<span class="mp-note">' + esc(row.site.address) + '</span>' : '')
            : 'unmapped',
        ],
        ['Device', esc(row.deviceType || '?') + ' · battery ' + (row.battery === null ? '?' : row.battery + '%') + (row.offline ? ' · offline' : '')],
        ['Seen', fmt.ago(row.capturedAt)],
      ],
      foot: row.guide
        ? '<a href="' + row.guide.directionsUrl + '" target="_blank" rel="noopener">↗ Directions back to the site</a>'
        : null,
    });
  }

  /** Geofence circle plus a centre pin. Dashed when the radius is unknown. */
  function siteCircle(map, site, opts) {
    const options = opts || {};
    if (site.lat === null || site.lat === undefined) return null;
    const known = site.radius !== null && site.radius !== undefined;
    const color = options.color || (known ? C.series[6] : C.muted);
    const layers = [];

    layers.push(
      L.circle([site.lat, site.lng], {
        radius: known ? site.radius : 60,
        color,
        weight: 1.5,
        opacity: 0.9,
        dashArray: known ? null : '5 5',
        fillColor: color,
        fillOpacity: 0.07,
      }).bindPopup(sitePopup(site))
    );

    // The centre pin is decoration - the circle around it carries the popup.
    // Left interactive it would win the canvas hit test (last drawn wins) and
    // swallow clicks meant for the heartbeats underneath it.
    layers.push(
      L.circleMarker([site.lat, site.lng], {
        radius: 4,
        color: RING,
        weight: 1.5,
        fillColor: color,
        fillOpacity: 1,
        interactive: false,
      })
    );

    if (options.label !== false) {
      layers[1].bindTooltip(site.siteId != null ? 'Site ' + site.siteId : 'Fence', {
        permanent: true,
        direction: 'top',
        offset: [0, -6],
        className: 'map-label',
      });
    }
    const group = L.layerGroup(layers).addTo(map);
    return { group, color };
  }

  function sitePopup(site) {
    return popupCard({
      color: site.radius != null ? C.series[6] : C.muted,
      title: site.label || 'Site ' + site.siteId,
      sub: site.address || null,
      rows: [
        ['Site ID', site.siteId != null ? String(site.siteId) : null],
        [
          'Radius',
          site.radius != null
            ? fmt.metres(site.radius) + (site.effectiveRadius ? '<span class="mp-note">max effective ' + fmt.metres(site.effectiveRadius) + '</span>' : '')
            : '<span class="mp-note">not on record - centre derived from device fixes</span>',
        ],
        ['Checks', site.validations ? fmt.int(site.validations) + ' · outside ' + fmt.int(site.outsideEvents || 0) : null],
        ['On site now', site.occupancy ? site.occupancy.total + ' (' + site.occupancy.inside + ' inside)' : null],
      ],
      foot: site.mapsUrl ? '<a href="' + site.mapsUrl + '" target="_blank" rel="noopener">↗ Open in Maps</a>' : null,
    });
  }

  /**
   * How a gap between two consecutive fixes is drawn. A trail is only as
   * trustworthy as its sampling: a 40-minute hole or a 200 km/h jump between
   * fixes is a data-quality fact, not a route, so it is drawn differently
   * instead of being smoothed over.
   */
  const SEGMENT_RULES = {
    normal: { label: 'Path', weight: 2.5, dashArray: null },
    gapShort: { label: 'Gap 10-30 min', weight: 2.5, dashArray: '7 5' },
    gapLong: { label: 'Gap 30 min+', weight: 2.5, dashArray: '3 7' },
    jump: { label: 'Suspicious jump (>150 km/h)', weight: 3.5, dashArray: null },
  };
  const JUMP_KMH = 150;

  function segmentKind(a, b) {
    const minutes = a.at && b.at ? (new Date(b.at).getTime() - new Date(a.at).getTime()) / 60000 : null;
    const metres = geoDistance(a, b);
    const kmh = minutes && minutes > 0 && metres !== null ? metres / 1000 / (minutes / 60) : null;
    if (kmh !== null && kmh > JUMP_KMH) return { kind: 'jump', minutes, metres, kmh };
    if (minutes !== null && minutes >= 30) return { kind: 'gapLong', minutes, metres, kmh };
    if (minutes !== null && minutes >= 10) return { kind: 'gapShort', minutes, metres, kmh };
    return { kind: 'normal', minutes, metres, kmh };
  }

  function segmentColour(kind, state) {
    if (kind === 'jump') return C.series[6];
    if (kind === 'gapLong') return C.critical;
    if (kind === 'gapShort') return C.warning;
    return verdictColor(state && state.verdict, state && state.insideGeofence);
  }

  /** Straight-line distance between two trail points, metres. */
  function geoDistance(a, b) {
    if (!a || !b || a.lat === null || b.lat === null) return null;
    const R = 6371008.8;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * The full trail, as separate layers the caller can toggle:
   *   path, dots, labels (sequence numbers), accuracy (halos)
   * Returns { layers, points, stats }.
   */
  function trail(map, points, opts) {
    const options = opts || {};
    const valid = (points || []).filter((p) => p && p.lat !== null && p.lat !== undefined);
    const path = L.layerGroup();
    const dots = L.layerGroup();
    const labels = L.layerGroup();
    const accuracy = L.layerGroup();
    const stats = { gapShort: 0, gapLong: 0, jump: 0, normal: 0, points: valid.length };

    for (let i = 1; i < valid.length; i += 1) {
      const a = valid[i - 1];
      const b = valid[i];
      const seg = segmentKind(a, b);
      stats[seg.kind] += 1;
      const rule = SEGMENT_RULES[seg.kind];
      const line = L.polyline(
        [
          [a.lat, a.lng],
          [b.lat, b.lng],
        ],
        {
          color: segmentColour(seg.kind, b),
          weight: rule.weight,
          opacity: 0.85,
          dashArray: rule.dashArray,
        }
      );
      line.bindPopup(
        popupCard({
          color: segmentColour(seg.kind, b),
          title: seg.kind === 'normal' ? 'Path segment' : rule.label,
          sub: fmt.time(a.at) + ' → ' + fmt.time(b.at),
          rows: [
            ['Elapsed', seg.minutes !== null ? fmt.duration(seg.minutes) : null],
            ['Distance', seg.metres !== null ? fmt.metres(seg.metres) : null],
            ['Implied speed', seg.kmh !== null ? seg.kmh.toFixed(0) + ' km/h' : null],
          ],
        })
      );
      path.addLayer(line);
    }

    const labelEvery = valid.length > 40 ? Math.ceil(valid.length / 25) : 1;
    valid.forEach((p, index) => {
      const isEdge = index === 0 || index === valid.length - 1;
      const colour = verdictColor(p.verdict, p.insideGeofence);

      if (p.accuracy) {
        accuracy.addLayer(
          L.circle([p.lat, p.lng], {
            radius: p.accuracy,
            color: colour,
            weight: 1,
            opacity: 0.35,
            fillColor: colour,
            fillOpacity: 0.06,
            interactive: false,
          })
        );
      }

      const marker = L.circleMarker([p.lat, p.lng], {
        radius: isEdge ? 6 : 4,
        color: RING,
        weight: 1.5,
        fillColor: colour,
        fillOpacity: isEdge ? 1 : 0.85,
      });
      marker.bindPopup(
        popupCard({
          color: colour,
          title: index === 0 ? 'First heartbeat' : index === valid.length - 1 ? 'Latest heartbeat' : 'Heartbeat ' + (index + 1),
          sub: fmt.date(p.at),
          rows: [
            ['Position', fmt.coords(p)],
            ['Accuracy', fmt.accuracy(p.accuracy)],
            ['Fence', p.insideGeofence === true ? 'inside' : p.insideGeofence === false ? 'outside' : 'no flag'],
            ['Battery', p.battery !== undefined && p.battery !== null ? p.battery + '%' : null],
            ['Clock', p.clockedIn === undefined ? null : p.clockedIn ? 'on the clock' : 'off the clock'],
          ],
        })
      );
      dots.addLayer(marker);

      if (isEdge || index % labelEvery === 0) {
        labels.addLayer(
          L.marker([p.lat, p.lng], {
            interactive: false,
            icon: L.divIcon({
              className: '',
              html: '<div class="map-seq" style="background:' + colour + '">' + (index + 1) + '</div>',
              iconSize: [22, 22],
              iconAnchor: [11, 11],
            }),
          })
        );
      }
    });

    const layers = { path, dots, labels, accuracy };
    if (options.add !== false) {
      for (const [name, layer] of Object.entries(layers)) {
        if (options.visible && options.visible[name] === false) continue;
        layer.addTo(map);
      }
    }
    return { layers, points: valid, stats, group: L.layerGroup(Object.values(layers)) };
  }

  /**
   * Clock-in / geofence validation events, coloured by what the check decided:
   * inside, inside only thanks to the accuracy buffer, or outside.
   */
  function clockIns(map, logs, opts) {
    const options = opts || {};
    const group = L.layerGroup();
    for (const log of logs || []) {
      if (!log.location) continue;
      const colour = log.actualIsWithinRadius === false ? C.critical : log.graceApplied ? C.warning : C.good;
      const marker = L.circleMarker([log.location.lat, log.location.lng], {
        radius: 7,
        color: RING,
        weight: 2,
        fillColor: colour,
        fillOpacity: 1,
      });
      marker.bindPopup(
        popupCard({
          color: colour,
          title: 'Clock-in check',
          sub: fmt.date(log.capturedAt),
          rows: [
            ['Position', fmt.coords(log.location)],
            ['Accuracy', fmt.accuracy(log.accuracy)],
            ['Site', log.siteId != null ? 'Site ' + log.siteId : 'unmapped'],
            ['Reported', log.isWithinRadius ? 'within the radius' : 'outside the radius'],
            ['Geometry', log.actualIsWithinRadius ? 'within the radius' : 'outside the radius'],
            ['Buffer', log.graceApplied ? 'passed only on the accuracy buffer (+' + fmt.metres(log.radiusPadding) + ')' : null],
            ['Effect', log.triggeredClockOut ? 'triggered an automatic clock-out' : null],
          ],
        })
      );
      group.addLayer(marker);
    }
    if (options.add !== false) group.addTo(map);
    return { group };
  }

  /** Legend for the trail view, matching the segment and marker rules above. */
  function trailLegend() {
    const line = (color, dash) =>
      '<i class="line" style="border-top:' + (dash ? '2px dashed ' : '2px solid ') + color + '"></i>';
    return (
      '<div class="map-legend">' +
      '<b class="map-legend-title">Legend</b>' +
      '<span><i style="background:' + C.in + '"></i>Heartbeat inside fence</span>' +
      '<span><i style="background:' + C.out + '"></i>Heartbeat outside fence</span>' +
      '<span><i style="background:' + C.warning + '"></i>Uncertain (accuracy overlaps boundary)</span>' +
      '<span><i style="background:' + C.good + '"></i>Clock-in (inside)</span>' +
      '<span><i style="background:' + C.warning + '"></i>Clock-in (via accuracy buffer)</span>' +
      '<span><i style="background:' + C.critical + '"></i>Clock-in (outside)</span>' +
      '<span>' + line(C.in) + 'Path</span>' +
      '<span>' + line(C.warning, true) + 'Gap 10-30 min</span>' +
      '<span>' + line(C.critical, true) + 'Gap 30 min+</span>' +
      '<span>' + line(C.series[6]) + 'Suspicious jump (>150 km/h)</span>' +
      '<span><i class="ring" style="border-color:' + C.series[6] + '"></i>Geofence radius</span>' +
      '</div>'
    );
  }

  /**
   * Breadcrumb trail. Segments are coloured by the state at that point so a
   * walk out of a fence is visible without reading the tooltip.
   */
  function track(map, points, opts) {
    const options = opts || {};
    const layers = [];
    const valid = (points || []).filter((p) => p.lat !== null && p.lat !== undefined);
    if (valid.length < 1) return null;

    for (let i = 1; i < valid.length; i += 1) {
      const a = valid[i - 1];
      const b = valid[i];
      const state = b.verdict || (b.insideGeofence === true ? 'in' : b.insideGeofence === false ? 'out' : null);
      layers.push(
        L.polyline(
          [
            [a.lat, a.lng],
            [b.lat, b.lng],
          ],
          {
            color: verdictColor(state, b.insideGeofence),
            weight: options.weight || 2.5,
            opacity: 0.75,
          }
        )
      );
    }

    if (options.dots !== false) {
      valid.forEach((p, index) => {
        const isEdge = index === 0 || index === valid.length - 1;
        const color = verdictColor(p.verdict, p.insideGeofence);
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: isEdge ? 5.5 : 3.5,
          color: RING,
          weight: 1.5,
          fillColor: color,
          fillOpacity: isEdge ? 1 : 0.85,
        });
        marker.bindPopup(
          popupCard({
            color,
            title: index === 0 ? 'First fix' : index === valid.length - 1 ? 'Latest fix' : 'Fix ' + (index + 1),
            sub: fmt.date(p.at),
            rows: [
              ['Position', fmt.coords(p)],
              ['Accuracy', fmt.accuracy(p.accuracy)],
              [
                'Boundary',
                p.distanceFromBoundary !== undefined && p.distanceFromBoundary !== null
                  ? fmt.metres(p.distanceFromBoundary) + (p.distanceFromBoundary > 0 ? ' outside' : ' inside')
                  : null,
              ],
              ['Verdict', p.verdict ? '<b>' + esc(p.verdict) + '</b>' : null],
              ['Battery', p.battery !== undefined && p.battery !== null ? p.battery + '%' : null],
            ],
          })
        );
        layers.push(marker);
      });
    }

    const group = L.layerGroup(layers).addTo(map);
    return { group, points: valid };
  }

  /**
   * The "guide me back" overlay: a dashed line from the device to the fence
   * centre, labelled with distance and compass bearing.
   */
  function guideLine(map, from, to, info) {
    if (!from || !to) return null;
    const line = L.polyline(
      [
        [from.lat, from.lng],
        [to.lat, to.lng],
      ],
      { color: C.warning, weight: 2, opacity: 0.85, dashArray: '6 5' }
    );
    const mid = [(from.lat + to.lat) / 2, (from.lng + to.lng) / 2];
    const label = L.marker(mid, {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html:
          '<div class="map-label" style="border-color:' +
          C.warning +
          '">' +
          (info && info.text ? window.PM.esc(info.text) : '') +
          '</div>',
        iconSize: [0, 0],
      }),
    });
    const group = L.layerGroup([line, label]).addTo(map);
    return { group };
  }

  function fit(map, points, opts) {
    const valid = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!valid.length) return;
    if (valid.length === 1) {
      map.setView([valid[0].lat, valid[0].lng], (opts && opts.zoom) || 17);
      return;
    }
    map.fitBounds(
      valid.map((p) => [p.lat, p.lng]),
      // Fitting frames the data; it deliberately stops short of MAX_ZOOM so a
      // tight cluster keeps some context. Zooming in by hand goes all the way.
      { padding: [36, 36], maxZoom: (opts && opts.maxZoom) || 18 }
    );
  }

  function clear(layers) {
    for (const layer of layers || []) if (layer && layer.group) layer.group.remove();
  }

  /**
   * Follow the theme without rebuilding anything: swapping the two tile URLs
   * leaves every marker, fence, trail and the current view exactly where they
   * are, which a rebuild would not.
   */
  function retheme() {
    const set = BASEMAPS[themeKey()];
    // Maps whose container has been thrown away (drawers) are dropped here.
    for (let i = instances.length - 1; i >= 0; i -= 1) {
      const map = instances[i];
      if (!map.__pmBasemap || !document.body.contains(map.getContainer())) {
        instances.splice(i, 1);
        continue;
      }
      const pair = map.__pmBasemap;
      if (pair.base._url !== set.base) pair.base.setUrl(set.base);
      if (pair.labels._url !== set.labels) pair.labels.setUrl(set.labels);
    }
  }

  window.addEventListener('pm:theme', retheme);
  if (window.matchMedia) {
    // "System" theme: the OS can change under us with no click to listen for.
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
    } catch (err) {
      /* older engines: the switcher still works */
    }
  }

  const legend = () =>
    '<div class="map-legend">' +
    '<b class="map-legend-title">Legend</b>' +
    '<span><i style="background:' + C.in + '"></i>Inside fence</span>' +
    '<span><i style="background:' + C.out + '"></i>Outside fence</span>' +
    '<span><i style="background:' + C.warning + '"></i>Uncertain (accuracy overlaps boundary)</span>' +
    '<span><i style="background:' + C.unknown + '"></i>No fence on record</span>' +
    '<span><i class="ring" style="border-color:' + C.series[6] + '"></i>Geofence radius</span>' +
    '<span><i class="ring" style="border-style:solid;border-color:' + C.muted + '"></i>GPS accuracy halo</span>' +
    '</div>';

  return {
    create,
    instances,
    deviceMarker,
    siteCircle,
    track,
    trail,
    clockIns,
    trailLegend,
    guideLine,
    fit,
    clear,
    legend,
    verdictColor,
    devicePopup,
    popupCard,
    sitePopup,
    BASEMAPS,
    retheme,
    SEGMENT_RULES,
  };
})();
