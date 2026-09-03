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
    // A page that re-renders its map (every reload of the user page did) left
    // the previous instance in here for retheme() to walk and, worse, left its
    // window resize handler attached to a container that was no longer in the
    // document. Callers now call map.remove(); this is what keeps the register
    // honest when they do.
    map.on('unload', () => {
      const at = instances.indexOf(map);
      if (at !== -1) instances.splice(at, 1);
    });
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
  /**
   * A solid circle is a claim about a boundary, so it is only drawn when the
   * radius came off the geofence log. A site whose centre is estimated from
   * device fixes gets a dashed uncertainty ring at the spread of those fixes -
   * that is what is actually known, and it must not read as a fence.
   */
  function siteCircle(map, site, opts) {
    const options = opts || {};
    if (site.lat === null || site.lat === undefined) return null;
    const fence = !!(site.radiusIsAuthoritative && site.radius !== null && site.radius !== undefined);
    const estimate = site.centreEstimate || null;
    const color = options.color || (fence ? C.series[6] : C.muted);
    const layers = [];

    // Radius to draw: the fence, or the spread of the fixes the centre was
    // estimated from (floor 25 m so a tight cluster is still visible).
    const spread = estimate && estimate.spreadMetres ? Math.max(25, estimate.spreadMetres) : 40;
    const drawnRadius = fence ? site.radius : spread;

    const ring = L.circle([site.lat, site.lng], {
      radius: drawnRadius,
      color,
      weight: 1.5,
      opacity: 0.9,
      dashArray: fence ? null : '5 5',
      fillColor: color,
      fillOpacity: fence ? 0.07 : 0.04,
    }).bindPopup(() => sitePopup(site));
    layers.push(ring);

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
      const name = site.siteId != null ? 'Site ' + site.siteId : 'Fence';
      layers[1].bindTooltip(fence ? name : name + ' (est.)', {
        permanent: true,
        direction: 'top',
        offset: [0, -6],
        className: 'map-label',
      });
    }
    const group = L.layerGroup(layers).addTo(map);
    // `radiusMetres` and `extent` are what a caller needs to frame this fence.
    // Fitting to the centre point alone draws the circle and then zooms past
    // it: a 300 m fence around a device that never left the middle of it ends
    // up entirely outside the viewport, which reads as a fence that failed to
    // load rather than one that is off-screen.
    return {
      group,
      color,
      circle: ring,
      radiusMetres: drawnRadius,
      isFence: fence,
      extent: extentPoints({ lat: site.lat, lng: site.lng }, drawnRadius),
    };
  }

  /** North / south / east / west edge of a circle, for framing it. */
  function extentPoints(centre, metres) {
    if (!centre || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lng) || !Number.isFinite(metres)) return [];
    const dLat = metres / 111320;
    const cos = Math.cos((centre.lat * Math.PI) / 180);
    const dLng = Math.abs(cos) < 1e-9 ? dLat : metres / (111320 * cos);
    return [
      { lat: centre.lat + dLat, lng: centre.lng },
      { lat: centre.lat - dLat, lng: centre.lng },
      { lat: centre.lat, lng: centre.lng + dLng },
      { lat: centre.lat, lng: centre.lng - dLng },
    ];
  }

  function sitePopup(site) {
    const fence = site.radiusIsAuthoritative && site.radius != null;
    const estimate = site.centreEstimate || null;
    const centreNote = {
      recorded: 'from the geofence log',
      'fence-record': 'from a fence record',
      estimated: estimate ? 'estimated from ' + fmt.int(estimate.fixes) + ' on-site fixes' : 'estimated',
      weak: estimate ? 'rough estimate from ' + fmt.int(estimate.fixes) + ' fixes' : 'rough estimate',
      disputed: estimate
        ? 'disputed - ' + fmt.int(estimate.fixes) + ' of ' + fmt.int(estimate.fixesTotal) + ' fixes here, the rest elsewhere'
        : 'disputed',
      unknown: 'unknown',
    }[site.centreConfidence || (fence ? 'recorded' : 'unknown')];

    return popupCard({
      color: fence ? C.series[6] : C.muted,
      title: site.label || 'Site ' + site.siteId,
      sub: site.address || null,
      rows: [
        ['Site ID', site.siteId != null ? String(site.siteId) : null],
        ['Centre', '<span class="mp-note">' + centreNote + '</span>'],
        [
          'Radius',
          fence
            ? fmt.metres(site.radius) + (site.effectiveRadius ? '<span class="mp-note">max effective ' + fmt.metres(site.effectiveRadius) + '</span>' : '')
            : '<span class="mp-note">no fence on record' + (site.candidateFences && site.candidateFences.length ? ' - ' + site.candidateFences.length + ' nearby fence record(s)' : '') + '</span>',
        ],
        [
          'Moved',
          site.fenceMovedMetres
            ? fmt.metres(site.fenceMovedMetres) + '<span class="mp-note">since the previous fence</span>'
            : null,
        ],
        [
          'Also reported from',
          estimate && estimate.alternates && estimate.alternates.length
            ? fmt.metres(estimate.alternates[0].metresAway) +
              ' away<span class="mp-note">' + fmt.int(estimate.alternates[0].fixes) + ' fixes at another location</span>'
            : null,
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
   * Two fixes closer together than the GPS accuracy that produced them are not
   * two positions - they are one position sampled twice. This fleet has devices
   * reporting once a second, so a person standing still for ten minutes lands
   * 600 fixes inside a 5 m circle: 600 opaque dots stacked on each other, 599
   * sub-pixel path segments buried underneath them, and 600 accuracy halos at
   * 6% fill that cancel out into a flat grey disc. The path and the halos were
   * drawn - they were just invisible under the pile, which is why toggling them
   * off and on appeared to do nothing at all.
   *
   * So the drawing is thinned: a fix is kept when it is far enough from the
   * last kept one to be a distinguishable position, and always when it carries
   * something distance does not - the two ends of the trail, a change of fence
   * or clock state, and either side of a reporting gap or a suspicious jump.
   * Everything dropped is folded into the fix it sits on, whose popup says how
   * many and until when, so no heartbeat is silently discarded.
   *
   * `stats` is counted over every fix, not the kept ones: how well a device
   * reported is a fact about the data and must not move when the drawing does.
   */
  const THIN_FLOOR_M = 4;
  const THIN_CEILING_M = 30;

  /** How far a fix must be from the last kept one to be drawn separately. */
  function thinThreshold(point) {
    const acc = Number(point && point.accuracy);
    if (!Number.isFinite(acc)) return THIN_FLOOR_M;
    return Math.max(THIN_FLOOR_M, Math.min(THIN_CEILING_M, acc));
  }

  // A gap must survive being merged into a run of normal segments.
  const KIND_RANK = { normal: 0, gapShort: 1, gapLong: 2, jump: 3 };
  const worseKind = (a, b) => (KIND_RANK[b] > KIND_RANK[a] ? b : a);

  /**
   * The full trail, as separate layers the caller can toggle:
   *   path, dots, labels (sequence numbers), accuracy (halos)
   * Returns { layers, points, drawn, stats }.
   */
  function trail(map, points, opts) {
    const options = opts || {};
    const valid = (points || []).filter(
      (p) => p && p.lat !== null && p.lat !== undefined && p.lng !== null && p.lng !== undefined
    );
    const path = L.layerGroup();
    const dots = L.layerGroup();
    const labels = L.layerGroup();
    const accuracy = L.layerGroup();
    const stats = { gapShort: 0, gapLong: 0, jump: 0, normal: 0, points: valid.length, drawn: 0, merged: 0 };
    // Opt in, not out. Merging near-duplicate fixes makes a stationary cluster
    // legible, but it also means the map holds fewer marks than the person has
    // heartbeats - and "show me all my heartbeats" is the more common ask and
    // the safer default. The caller decides; drawing everything is what happens
    // if nobody says otherwise.
    const thin = options.thin === true;

    // ---- pass one: every segment, for the counts and for the kinds --------
    const kinds = new Array(valid.length).fill(null);
    for (let i = 1; i < valid.length; i += 1) {
      const seg = segmentKind(valid[i - 1], valid[i]);
      kinds[i] = seg;
      stats[seg.kind] += 1;
    }

    // ---- pass two: which fixes get drawn ---------------------------------
    // Each kept fix records the run of fixes it stands for and the worst
    // segment kind crossed to reach it from the previous kept fix.
    const kept = [];
    let anchor = null;
    let carried = 'normal';
    valid.forEach((p, index) => {
      const seg = kinds[index];
      const kind = seg ? seg.kind : 'normal';
      const isEdge = index === 0 || index === valid.length - 1;
      const notable = kind !== 'normal';
      // The fix *before* a gap has to be drawn too, or the dashed segment
      // starts from nowhere.
      const nextNotable = kinds[index + 1] ? kinds[index + 1].kind !== 'normal' : false;
      const stateChanged =
        anchor && (anchor.insideGeofence !== p.insideGeofence || anchor.clockedIn !== p.clockedIn);
      const far = !anchor || (geoDistance(anchor, p) || 0) >= thinThreshold(anchor);

      if (!thin || !anchor || isEdge || notable || nextNotable || stateChanged || far) {
        kept.push({ point: p, index, count: 1, kind: kept.length ? worseKind(carried, kind) : 'normal' });
        anchor = p;
        carried = 'normal';
      } else {
        // Folded into the last kept fix, and the kind it crossed is carried
        // forward so the next drawn segment still reports the gap.
        const last = kept[kept.length - 1];
        last.count += 1;
        last.until = p.at;
        carried = worseKind(carried, kind);
      }
    });
    stats.drawn = kept.length;
    stats.merged = valid.length - kept.length;

    // ---- the path, as runs rather than one polyline per pair -------------
    // A normal 800-fix trail used to be 799 separate canvas paths, each with
    // its popup HTML built up front. Consecutive segments of the same kind are
    // one polyline now, and every popup is a function the popup calls on open.
    let run = null;
    const runs = [];
    const flushRun = () => {
      if (!run || run.latlngs.length < 2) {
        run = null;
        return;
      }
      const active = run;
      const rule = SEGMENT_RULES[active.kind];
      const colour = segmentColour(active.kind, active.endPoint);
      const line = L.polyline(active.latlngs, {
        color: colour,
        weight: rule.weight,
        opacity: 0.85,
        dashArray: rule.dashArray,
      });
      line.bindPopup(() => {
        const first = active.startPoint;
        const last = active.endPoint;
        const minutes =
          first.at && last.at ? (new Date(last.at).getTime() - new Date(first.at).getTime()) / 60000 : null;
        let metres = 0;
        for (let i = 1; i < active.points.length; i += 1) {
          metres += geoDistance(active.points[i - 1], active.points[i]) || 0;
        }
        const kmh = minutes && minutes > 0 ? metres / 1000 / (minutes / 60) : null;
        const segments = active.latlngs.length - 1;
        return popupCard({
          color: colour,
          title: active.kind === 'normal' ? (segments > 1 ? 'Path · ' + segments + ' segments' : 'Path segment') : rule.label,
          sub: fmt.time(first.at) + ' → ' + fmt.time(last.at),
          rows: [
            ['Elapsed', minutes !== null ? fmt.duration(minutes) : null],
            ['Distance', fmt.metres(metres)],
            ['Implied speed', kmh !== null ? kmh.toFixed(0) + ' km/h' : null],
          ],
        });
      });
      path.addLayer(line);
      // Replay reveals the path run by run, so each one records the stretch of
      // `kept` it covers and the style it was drawn with. Sharing the runs rather
      // than re-deriving them is what keeps a played trail identical to the static
      // one - same breaks, same colours, same dashes.
      runs.push({
        kind: active.kind,
        fromOrder: active.fromOrder,
        toOrder: active.toOrder,
        color: colour,
        weight: rule.weight,
        dashArray: rule.dashArray,
        line,
      });
      run = null;
    };

    for (let i = 1; i < kept.length; i += 1) {
      const a = kept[i - 1];
      const b = kept[i];
      if (!run || run.kind !== b.kind) {
        flushRun();
        run = {
          kind: b.kind,
          latlngs: [[a.point.lat, a.point.lng]],
          points: [a.point],
          startPoint: a.point,
          endPoint: a.point,
          fromOrder: i - 1,
          toOrder: i - 1,
        };
      }
      run.latlngs.push([b.point.lat, b.point.lng]);
      run.points.push(b.point);
      run.endPoint = b.point;
      run.toOrder = i;
      // A gap or a jump stands alone - its popup is about those two fixes.
      if (b.kind !== 'normal') flushRun();
    }
    flushRun();

    // ---- dots, halos and sequence numbers, over the kept fixes only ------
    const labelEvery = kept.length > 40 ? Math.ceil(kept.length / 25) : 1;
    // One record per drawn mark, in draw order. The layer groups above show the
    // whole trail at once; `marks` is for showing it a heartbeat at a time, and
    // both hold the SAME layer objects - a replay that built its own would be
    // drawing a second, subtly different trail on top of the first.
    const marks = [];
    kept.forEach((entry, order) => {
      const p = entry.point;
      const isEdge = entry.index === 0 || entry.index === valid.length - 1;
      const colour = verdictColor(p.verdict, p.insideGeofence);
      // Sequence numbers name the heartbeat in the table, so they come from the
      // document's own ordinal when the caller supplied one - a state filter
      // must not renumber what is left.
      const seq = p.seq === undefined || p.seq === null ? entry.index + 1 : p.seq;

      let halo = null;
      if (p.accuracy) {
        halo = L.circle([p.lat, p.lng], {
          radius: p.accuracy,
          color: colour,
          weight: 1,
          opacity: 0.55,
          fillColor: colour,
          fillOpacity: 0.1,
          interactive: false,
        });
        accuracy.addLayer(halo);
      }

      const marker = L.circleMarker([p.lat, p.lng], {
        radius: isEdge ? 6 : 4,
        color: RING,
        weight: 1.5,
        fillColor: colour,
        fillOpacity: isEdge ? 1 : 0.85,
      });
      marker.bindPopup(() =>
        popupCard({
          color: colour,
          title:
            entry.index === 0
              ? 'First heartbeat'
              : entry.index === valid.length - 1
                ? 'Latest heartbeat'
                : 'Heartbeat ' + seq,
          sub: fmt.date(p.at),
          rows: [
            ['Position', fmt.coords(p)],
            ['Accuracy', fmt.accuracy(p.accuracy)],
            ['Fence', p.insideGeofence === true ? 'inside' : p.insideGeofence === false ? 'outside' : 'no flag'],
            ['Battery', p.battery !== undefined && p.battery !== null ? p.battery + '%' : null],
            ['Clock', p.clockedIn === undefined ? null : p.clockedIn ? 'on the clock' : 'off the clock'],
            [
              'Merged here',
              entry.count > 1
                ? entry.count -
                  1 +
                  ' further fix' +
                  (entry.count > 2 ? 'es' : '') +
                  ' within ' +
                  fmt.metres(thinThreshold(p)) +
                  (entry.until ? ', through ' + fmt.time(entry.until) : '')
                : null,
            ],
          ],
        })
      );
      dots.addLayer(marker);

      let label = null;
      if (isEdge || order % labelEvery === 0) {
        label = L.marker([p.lat, p.lng], {
          interactive: false,
          icon: L.divIcon({
            className: '',
            html: '<div class="map-seq" style="background:' + colour + '">' + seq + '</div>',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
        });
        labels.addLayer(label);
      }

      marks.push({ point: p, order, index: entry.index, colour, dot: marker, halo, label });
    });

    const layers = { path, dots, labels, accuracy };
    if (options.add !== false) {
      for (const [name, layer] of Object.entries(layers)) {
        if (options.visible && options.visible[name] === false) continue;
        layer.addTo(map);
      }
    }
    return {
      layers,
      points: valid,
      drawn: kept.map((k) => k.point),
      marks,
      runs,
      stats,
      group: L.layerGroup(Object.values(layers)),
    };
  }

  /**
   * Clock-in / geofence validation events, coloured by what the check decided:
   * inside, inside only thanks to the accuracy buffer, or outside.
   */
  function clockIns(map, logs, opts) {
    const options = opts || {};
    const group = L.layerGroup();
    // Ordered by when the check happened, so a replay can let them arrive as it
    // reaches them instead of showing every check from the first frame.
    const marks = [];
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
      const atMs = new Date(log.capturedAt).getTime();
      if (Number.isFinite(atMs)) marks.push({ atMs, marker, log });
    }
    marks.sort((a, b) => a.atMs - b.atMs);
    if (options.add !== false) group.addTo(map);
    return { group, marks };
  }

  /* ======================================================================
     Replay
     ----------------------------------------------------------------------
     A trail answers "where did they go". It does not answer "when, and how
     fast, and what was the device saying at the time" - for that you have to
     read a table next to a map and join the two by eye. So the same points can
     be played back: a timeline built once, then seeked to any instant.

     Two rules keep the replay honest, because a smooth animation is very good
     at implying knowledge that is not there:

     - Position is interpolated between two fixes only across a NORMAL segment.
       Across a reporting gap or a suspicious jump the marker holds still at the
       last known fix until the next one arrives, because we do not know where
       the device was in between and drawing it gliding across is a lie.
     - Everything reported at an instant - accuracy, fence state, battery - is
       the value from the fix at or before that instant, never blended. A device
       is inside the fence or outside it; there is no halfway.
     ====================================================================== */

  /**
   * The trail, revealed a heartbeat at a time.
   *
   * Replaying with the finished trail still on the map answers the wrong
   * question: the whole route is already drawn, so a marker sliding along it
   * shows only *where* someone is, never what had happened by then. Cleared
   * first and drawn as it plays, the map answers "what did we know at 14:32" -
   * which is the question a replay is for.
   *
   * The hard part is doing it without the per-frame cost growing with the
   * trail. Three things keep it flat:
   *
   * - Marks are the SAME layer objects the static trail built (`trail().marks`),
   *   so revealing one is an addLayer, never a rebuild. Leaflet's canvas
   *   renderer redraws only the bounds that changed, so adding one dot costs
   *   about one dot.
   * - A path run that is entirely behind the playhead is the SAME prebuilt
   *   polyline (`trail().runs`), added whole. No re-projection, and the played
   *   route keeps the static one's colours, breaks and dashes exactly.
   * - Only the run being walked is redrawn, and it is chunked: every CHUNK
   *   points the tail is frozen into its own polyline and never touched again.
   *   `setLatLngs` re-projects the entire line, so a single growing polyline is
   *   O(points) every frame - which is exactly what makes a long replay stutter.
   *
   * Cost per step is therefore bounded by CHUNK and by the number of runs, not
   * by the length of the trail, whether that is 500 heartbeats or 50,000.
   *
   * Because the layers are shared with the static trail, the caller must take
   * the static groups off the map before using this - the same object cannot be
   * in two places at once.
   */
  const CHUNK = 250;

  function progressiveTrail(map, spec) {
    const options = spec || {};
    const marks = options.marks || [];
    const runs = options.runs || [];
    const clockMarks = options.clockMarks || [];
    // A copy: the layer toolbar can be used mid-replay, and this has to track it
    // without writing back into the caller.
    const show = Object.assign({}, options.show || {});

    const dots = L.layerGroup();
    const halos = L.layerGroup();
    const labels = L.layerGroup();
    const clock = L.layerGroup();
    const path = L.layerGroup();
    const chunks = L.layerGroup(); // frozen chunks + the one live tail
    const group = L.layerGroup([halos, path, chunks, clock, labels, dots]);

    let shown = -1; // highest mark order revealed
    let clockShown = -1;
    let live = null;
    let liveRun = -1;
    let liveStart = -1;

    const styleOf = (run) => ({
      color: run.color,
      weight: run.weight,
      opacity: 0.85,
      dashArray: run.dashArray,
      interactive: false,
    });

    function dropLive() {
      chunks.clearLayers();
      live = null;
      liveRun = -1;
      liveStart = -1;
    }

    function revealMark(mark) {
      if (show.dots !== false) dots.addLayer(mark.dot);
      if (show.accuracy && mark.halo) halos.addLayer(mark.halo);
      if (show.labels && mark.label) labels.addLayer(mark.label);
    }

    function hideMark(mark) {
      dots.removeLayer(mark.dot);
      if (mark.halo) halos.removeLayer(mark.halo);
      if (mark.label) labels.removeLayer(mark.label);
    }

    /** The route as far as mark `order`, ending at `head` if given. */
    function paintPath(order, head) {
      if (show.path === false) return;
      // One pass over the runs settles both directions of travel: a run behind
      // the playhead is on, one ahead is off, and the first one straddling it
      // is the one being drawn.
      let current = -1;
      for (let r = 0; r < runs.length; r += 1) {
        const run = runs[r];
        if (run.toOrder <= order) {
          if (!path.hasLayer(run.line)) path.addLayer(run.line);
        } else {
          if (path.hasLayer(run.line)) path.removeLayer(run.line);
          if (current === -1 && run.fromOrder <= order) current = r;
        }
      }
      if (current === -1) {
        dropLive();
        return;
      }

      const run = runs[current];
      // A different run, or a seek back behind the frozen chunks, starts over.
      if (current !== liveRun || order < liveStart) {
        chunks.clearLayers();
        live = null;
        liveRun = current;
        liveStart = run.fromOrder;
      }
      while (order - liveStart >= CHUNK) {
        const stop = liveStart + CHUNK;
        const frozen = [];
        for (let i = liveStart; i <= stop; i += 1) frozen.push([marks[i].point.lat, marks[i].point.lng]);
        chunks.addLayer(L.polyline(frozen, styleOf(run)));
        liveStart = stop;
        live = null;
      }
      const tail = [];
      for (let i = liveStart; i <= order; i += 1) tail.push([marks[i].point.lat, marks[i].point.lng]);
      if (head) tail.push([head.lat, head.lng]);
      if (tail.length < 2) {
        if (live) chunks.removeLayer(live);
        live = null;
        return;
      }
      if (live) live.setLatLngs(tail);
      else {
        live = L.polyline(tail, styleOf(run));
        chunks.addLayer(live);
      }
    }

    return {
      group,
      /** Reveal up to mark `order` at instant `atMs`, `head` between two fixes. */
      set(order, atMs, head) {
        const target = Math.max(-1, Math.min(order, marks.length - 1));
        if (target < shown) for (let i = shown; i > target; i -= 1) hideMark(marks[i]);
        else for (let i = shown + 1; i <= target; i += 1) revealMark(marks[i]);
        shown = target;

        if (show.clockIns !== false) {
          // Clock-in checks are events in time too: they arrive when the replay
          // reaches them rather than sitting there from the first frame.
          while (clockShown >= 0 && clockMarks[clockShown].atMs > atMs) {
            clock.removeLayer(clockMarks[clockShown].marker);
            clockShown -= 1;
          }
          while (clockShown + 1 < clockMarks.length && clockMarks[clockShown + 1].atMs <= atMs) {
            clockShown += 1;
            clock.addLayer(clockMarks[clockShown].marker);
          }
        }

        paintPath(target, head);
      },
      /** Follow the layer toolbar while a replay is running. */
      show(next) {
        const was = { dots: show.dots, accuracy: show.accuracy, labels: show.labels };
        Object.assign(show, next || {});
        // Only walk the revealed marks for the kinds that actually changed. A
        // toolbar click that toggles labels has no business re-adding every dot.
        const moved = (k) => was[k] !== show[k];
        if (moved("dots") || moved("accuracy") || moved("labels")) {
          for (let i = 0; i <= shown; i += 1) {
            const m = marks[i];
            if (moved("dots")) {
              if (show.dots !== false) dots.addLayer(m.dot);
              else dots.removeLayer(m.dot);
            }
            if (m.halo && moved("accuracy")) {
              if (show.accuracy) halos.addLayer(m.halo);
              else halos.removeLayer(m.halo);
            }
            if (m.label && moved("labels")) {
              if (show.labels) labels.addLayer(m.label);
              else labels.removeLayer(m.label);
            }
          }
        }
        if (show.path === false) {
          path.clearLayers();
          dropLive();
        } else {
          paintPath(shown, null);
        }
        if (show.clockIns === false) {
          clock.clearLayers();
          clockShown = -1;
        }
      },
      /** Back to an empty map, ready to play from the beginning. */
      reset() {
        for (let i = 0; i <= shown; i += 1) hideMark(marks[i]);
        shown = -1;
        clock.clearLayers();
        clockShown = -1;
        path.clearLayers();
        dropLive();
      },
      remove() {
        this.reset();
        group.remove();
      },
    };
  }
  /** Milliseconds a replay will hold on a fix before a gap, so it reads as a pause. */
  const HOLD_MS = 0;

  /**
   * Pre-computes what a replay needs: timestamps, cumulative distance, and
   * whether each step may be interpolated across. O(n) once, so seeking is a
   * binary search rather than a walk.
   */
  function trailTimeline(points) {
    const valid = (points || []).filter(
      (p) =>
        p &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        p.at !== null &&
        p.at !== undefined &&
        Number.isFinite(new Date(p.at).getTime())
    );
    const times = [];
    const cumMetres = [];
    const glide = []; // glide[i] === may we interpolate from i to i+1
    let running = 0;
    for (let i = 0; i < valid.length; i += 1) {
      times.push(new Date(valid[i].at).getTime());
      if (i > 0) running += geoDistance(valid[i - 1], valid[i]) || 0;
      cumMetres.push(running);
    }
    for (let i = 0; i < valid.length - 1; i += 1) {
      glide.push(segmentKind(valid[i], valid[i + 1]).kind === 'normal');
    }
    return {
      points: valid,
      times,
      cumMetres,
      glide,
      startMs: times.length ? times[0] : null,
      endMs: times.length ? times[times.length - 1] : null,
      durationMs: times.length > 1 ? times[times.length - 1] - times[0] : 0,
      totalMetres: running,
    };
  }

  /** Index of the last fix at or before `whenMs`. -1 when `whenMs` predates the trail. */
  function indexAt(times, whenMs) {
    let lo = 0;
    let hi = times.length - 1;
    if (!times.length || whenMs < times[0]) return -1;
    if (whenMs >= times[hi]) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= whenMs) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Where the trail is at an instant.
   * Returns null for an empty timeline; otherwise
   * { index, point, next, lat, lng, interpolated, holding, travelledMetres, atMs }.
   */
  function seekTimeline(timeline, whenMs) {
    const { points, times, cumMetres, glide } = timeline;
    if (!points.length) return null;
    const clamped = Math.max(times[0], Math.min(whenMs, times[times.length - 1]));
    const i = Math.max(0, indexAt(times, clamped));
    const point = points[i];
    const next = i + 1 < points.length ? points[i + 1] : null;

    // On, or past, the last fix.
    if (!next) {
      return {
        index: i,
        point,
        next: null,
        lat: point.lat,
        lng: point.lng,
        interpolated: false,
        holding: false,
        travelledMetres: cumMetres[i],
        atMs: clamped,
      };
    }

    const span = times[i + 1] - times[i];
    const t = span > 0 ? (clamped - times[i]) / span : 0;
    if (!glide[i]) {
      // A gap or a jump: hold at the fix we actually have.
      return {
        index: i,
        point,
        next,
        lat: point.lat,
        lng: point.lng,
        interpolated: false,
        holding: t > 0,
        travelledMetres: cumMetres[i],
        atMs: clamped,
      };
    }
    return {
      index: i,
      point,
      next,
      lat: point.lat + (next.lat - point.lat) * t,
      lng: point.lng + (next.lng - point.lng) * t,
      interpolated: t > 0,
      holding: false,
      travelledMetres: cumMetres[i] + (cumMetres[i + 1] - cumMetres[i]) * t,
      atMs: clamped,
    };
  }

  /**
   * The replay overlay: the route already covered, and a marker on it. Kept
   * separate from the trail layers so playing does not disturb what the layer
   * toolbar is showing.
   */
  function playhead(map, opts) {
    const options = opts || {};
    const covered = L.polyline([], {
      color: options.color || C.series[0],
      weight: 4,
      opacity: 0.95,
      interactive: false,
    });
    const halo = L.circle([0, 0], {
      radius: 1,
      color: options.color || C.series[0],
      weight: 1,
      opacity: 0.6,
      fillColor: options.color || C.series[0],
      fillOpacity: 0.12,
      interactive: false,
    });
    const dot = L.marker([0, 0], {
      interactive: false,
      zIndexOffset: 1000,
      icon: L.divIcon({
        className: '',
        html: '<div class="map-marker pulse" style="background:' + (options.color || C.series[0]) + ';color:' + (options.color || C.series[0]) + '"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
    });
    const group = L.layerGroup([halo, covered, dot]);
    if (options.add !== false) group.addTo(map);

    return {
      group,
      covered,
      dot,
      /** Move the marker, its accuracy halo, and the covered route. */
      set(state, latlngs, accuracy) {
        dot.setLatLng([state.lat, state.lng]);
        halo.setLatLng([state.lat, state.lng]);
        halo.setRadius(Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 1);
        halo.setStyle({ opacity: Number.isFinite(accuracy) && accuracy > 0 ? 0.6 : 0 });
        covered.setLatLngs(latlngs);
      },
      setColor(color) {
        covered.setStyle({ color });
        halo.setStyle({ color, fillColor: color });
        const icon = dot.getElement();
        if (icon && icon.firstChild) {
          icon.firstChild.style.background = color;
          icon.firstChild.style.color = color;
        }
      },
      remove() {
        group.remove();
      },
    };
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

  /**
   * Fit to `points`, then include only the `context` points close enough to be
   * worth seeing next to them.
   *
   * The user page fitted the trail and every fence the person had ever touched
   * in one call. A site registered 40 km away - and this store has them, from
   * old snapshots and from fences with no site id - framed a 40 km box, in
   * which a whole shift's trail is one pixel. Nothing was wrong with the trail;
   * it was two orders of magnitude too small to see.
   *
   * Returns how many context points were left out, so the caller can say so
   * rather than quietly dropping a fence off the edge.
   */
  function fitWithContext(map, points, context, opts) {
    const options = opts || {};
    const core = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const extra = (context || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!core.length) {
      fit(map, extra, options);
      return { skipped: 0 };
    }

    const bounds = L.latLngBounds(core.map((p) => [p.lat, p.lng]));
    const centre = bounds.getCenter();
    // How far out is still "next to" the data: the span of the data itself, with
    // a floor so a stationary trail still shows the fence it is standing in.
    const span = centre.distanceTo(bounds.getNorthEast());
    const reach = Math.max(options.minReachMetres || 1500, span * (options.reachFactor || 4));

    let skipped = 0;
    const near = [];
    for (const p of extra) {
      if (centre.distanceTo(L.latLng(p.lat, p.lng)) > reach) {
        skipped += 1;
        continue;
      }
      // A context point with a radius is a circle, and framing it means framing
      // its edge - fitting to the centre leaves the boundary off-screen.
      near.push(p);
      if (Number.isFinite(p.radius)) near.push(...extentPoints(p, p.radius));
    }
    fit(map, core.concat(near), options);
    return { skipped };
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
    '<span><i class="ring" style="border-color:' + C.series[6] + '"></i>Geofence radius (on record)</span>' +
    '<span><i class="ring" style="border-color:' + C.muted + '"></i>Estimated centre - no fence on record</span>' +
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
    fitWithContext,
    trailTimeline,
    seekTimeline,
    playhead,
    progressiveTrail,
    extentPoints,
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
