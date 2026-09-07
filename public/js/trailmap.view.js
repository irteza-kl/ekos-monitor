/* The trail map panel: a map of where a set of heartbeats went, with the
   controls that make it answerable.

   This lived inside user.js, so it belonged to one page and one person. The
   Heartbeats page had no map at all, then a much thinner one - no Fixes
   control, no time window, no State filter, no merging, no replay - which is
   two maps of the same collection answering to different rules. It is one
   panel now, and both pages mount it.

   The page keeps what is genuinely the page's: fetching, and the time window
   (which scopes the page's other queries too, so the map and the table beside
   it can never disagree about how many heartbeats exist). The panel keeps the
   drawing, the toolbar, the preferences, the replay, and the accounting note
   that explains where every heartbeat went.

   Mount it with render(host, spec):

     title       heading for the card
     points      the trail, oldest first, [{at,lat,lng,accuracy,...}]
     clockIns    geofence validation calls to mark, or undefined for none
     sites       fences to draw
     current     the live device row, for the pulsing marker and guide line
     meta        { inRange, fetched, noFix, truncated, limit, ceiling,
                   from, to, travelledMetres } - everything the note needs
     window      { from, to } or null, the window the page is scoped to
     onWindow    (next|null) => void, the page re-fetches
     onReload    () => void, the page re-fetches with the new Fixes limit
     path        false when a path between these points would be a fiction
     replay      false when a replay would be
     reason      why, said out loud, when either is false

   A path and a replay are only honest for one device's stream. Two people's
   fixes joined by a line is a drawing of a journey nobody took, so the caller
   says whether these points are one stream and the panel drops the path, the
   replay and their toolbar chips when they are not. */
window.PMTrailMap = (function () {
  'use strict';
  const { el, fmt, esc } = PM;

  // The one live map on the page, and the frame the reader was last looking
  // at. Module-level because only one page is mounted at a time, the same way
  // PMMap keeps its register.
  let map = null;
  let mapView = null;
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

  /**
   * How many heartbeats to pull for the trail.
   *
   * This page asked for 800, hard-coded, and the server capped anything at
   * 5,000 - so on a device reporting once a second the map could not show a
   * whole shift no matter what you did, and never said why. It is a choice now,
   * remembered per browser. A day of one 1 Hz device is 86,400 heartbeats, so
   * the top of this list is a real answer to "all of them" rather than a
   * gesture; the map warns when a number this large makes it slow.
   */
  const FIX_LIMITS = [800, 2000, 5000, 20000, 50000, 100000];
  const DEFAULT_FIX_LIMIT = 5000;

  function fixLimit() {
    let saved = null;
    try {
      saved = Number(localStorage.getItem('pm.trail.limit'));
    } catch (err) {
      saved = null;
    }
    return FIX_LIMITS.includes(saved) ? saved : DEFAULT_FIX_LIMIT;
  }

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
    // Off by default: every heartbeat gets its own mark unless asked otherwise.
    try {
      prefs.merge = localStorage.getItem('pm.trail.merge') === '1';
    } catch (err) {
      prefs.merge = false;
    }
    prefs.limit = fixLimit();
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

  /* ---------------------------------------------------------------- window
     A time window scoped tighter than the page's filter bar.

     Narrowing the range is the one thing that always makes a trail complete:
     the Fixes limit takes the NEWEST n heartbeats, so a window small enough to
     hold fewer than n of them is never truncated. The filter bar can do this
     with a custom range, but it is at the top of the page, it reloads
     everything, and it has no idea what the map is short of - so the map now
     carries its own, seeded from what actually loaded, with Earlier/Later
     stepping so a dense day can be walked one complete window at a time.

     It refines the page filter rather than sitting beside it: the request is
     the same request, so every count on the page agrees with the map. That is
     worth being loud about, and the bar says so whenever a window is set. */

  const WINDOW_PRESETS = [
    { key: 15, label: '15 min' },
    { key: 60, label: '1 hour' },
    { key: 180, label: '3 hours' },
    { key: 360, label: '6 hours' },
    { key: 720, label: '12 hours' },
    { key: 1440, label: '24 hours' },
  ];

  /** `datetime-local` wants local wall-clock with no zone, to the minute. */
  function toLocalInput(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  function fromLocalInput(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }

  /** Move the window by its own length. */
  function stepMapWindow(windowNow, applyWindow, direction) {
    if (!windowNow) return;
    const from = new Date(windowNow.from).getTime();
    const to = new Date(windowNow.to).getTime();
    const span = Math.max(60000, to - from);
    applyWindow({
      from: new Date(from + direction * span).toISOString(),
      to: new Date(to + direction * span).toISOString(),
    });
  }

  function renderWindowBar(host, spec, opts) {
    const options = opts || {};
    const meta = spec.meta || {};
    const windowNow = spec.window || null;
    const applyWindow = (next) => spec.onWindow(next);
    host.innerHTML = '';
    const loadedFrom = meta.from;
    const loadedTo = meta.to;

    const fromInput = el('input', {
      type: 'datetime-local',
      value: windowNow ? toLocalInput(windowNow.from) : loadedFrom ? toLocalInput(loadedFrom) : '',
    });
    const toInput = el('input', {
      type: 'datetime-local',
      value: windowNow ? toLocalInput(windowNow.to) : loadedTo ? toLocalInput(loadedTo) : '',
    });

    const apply = () => {
      const from = fromLocalInput(fromInput.value);
      const to = fromLocalInput(toInput.value);
      if (!from || !to) {
        PM.toast('Give the window both a start and an end.', 'error');
        return;
      }
      if (new Date(from).getTime() >= new Date(to).getTime()) {
        PM.toast('The window has to start before it ends.', 'error');
        return;
      }
      applyWindow({ from, to });
    };

    // Anchored on the newest heartbeat that loaded, because that is where a
    // truncated trail is: "the last hour" of the range, not of the wall clock.
    const anchor = loadedTo ? new Date(loadedTo).getTime() : Date.now();
    const preset = (minutes) =>
      applyWindow({
        from: new Date(anchor - minutes * 60000).toISOString(),
        to: new Date(anchor).toISOString(),
      });

    host.append(
      el('span', { class: 'toolbar-field' }, [
        el('span', { text: 'Window' }),
        fromInput,
        el('span', { class: 'hint', text: '→' }),
        toInput,
        el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Apply', onclick: apply }),
      ]),
      el('span', { class: 'toolbar-sep' }),
      ...WINDOW_PRESETS.map((p) =>
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          text: p.label,
          title: 'The last ' + p.label + ' of the loaded data',
          onclick: () => preset(p.key),
        })
      ),
      el('span', { class: 'toolbar-sep' }),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: '◀ Earlier',
        title: 'Move the window back by its own length',
        disabled: windowNow ? null : 'disabled',
        onclick: () => stepMapWindow(windowNow, applyWindow, -1),
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: 'Later ▶',
        title: 'Move the window forward by its own length',
        disabled: windowNow ? null : 'disabled',
        onclick: () => stepMapWindow(windowNow, applyWindow, 1),
      }),
      el('div', { style: 'flex:1' })
    );

    // The one-click answer to a truncated trail: shrink the window to exactly
    // what came back, so the next load is complete, then walk backwards with
    // Earlier. It talks about the trail, so it is offered on the map only.
    if (options.narrow !== false && meta.truncated && loadedFrom && loadedTo) {
      host.append(
        el('button', {
          type: 'button',
          class: 'btn btn-sm btn-primary',
          text: '⤡ Narrow to what loaded',
          title: 'Set the window to the span the trail actually covers, so nothing is cut off',
          onclick: () => applyWindow({ from: loadedFrom, to: loadedTo }),
        })
      );
    }
    if (windowNow) {
      host.append(
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          text: '✕ Clear window',
          title: 'Go back to the page filter',
          onclick: () => applyWindow(null),
        })
      );
    }

    host.classList.toggle('is-active', !!windowNow);
  }

  /* ---------------------------------------------------------------- replay
     A trail says where someone went. It does not say when, how fast, or what
     the device was reporting at the time - for that you read a table beside a
     map and join the two by eye. Replay puts them together: a marker walks the
     trail while a readout shows the heartbeat it is standing on.

     PMMap.seekTimeline does the honest part (see maps.js): position is only
     interpolated across a normal reporting interval, and every value shown is
     read off a real heartbeat rather than blended between two. */
  let sim = null;

  const SPEEDS = [
    { key: 'auto', label: 'Auto (~30 s)' },
    { key: '1', label: 'Real time' },
    { key: '60', label: '1 min/s' },
    { key: '300', label: '5 min/s' },
    { key: '1800', label: '30 min/s' },
    { key: '7200', label: '2 h/s' },
  ];
  // The highlighted tail behind the marker, in fixes. Bounded on purpose: a
  // polyline that grows to the whole track has to be re-projected every frame,
  // which is what makes a replay of 50,000 points stutter.
  const TAIL_FIXES = 200;
  function stopSim() {
    if (!sim) return;
    if (sim.raf) cancelAnimationFrame(sim.raf);
    // Order matters: the reveal has to hand the shared layer objects back
    // before the playhead goes, or marks stay orphaned on a dead map.
    if (sim.reveal) sim.reveal.remove();
    if (sim.head) sim.head.remove();
    sim = null;
  }

  function buildSim(map, points, host, spec) {
    const timeline = PMMap.trailTimeline(points);
    const source = spec || {};
    host.innerHTML = '';
    if (timeline.points.length < 2 || timeline.durationMs <= 0) {
      host.append(
        el('div', {
          class: 'sim-empty',
          text:
            timeline.points.length < 2
              ? 'Replay needs at least two heartbeats with coordinates in this window.'
              : 'Every heartbeat in this window carries the same timestamp, so there is nothing to play back.',
        })
      );
      return;
    }

    // The replay walks the fixes the map actually drew. With Merge nearby on,
    // that is the merged set - so the marks appearing during playback are the
    // marks that were there before it started, never a second, denser trail.
    // Marks are a subsequence of the timeline (same objects, same order), so one
    // walk gives, for every fix, the last mark drawn at or before it. With Merge
    // nearby off they are the same list; with it on, several fixes map to the one
    // mark that stands for them.
    const markOf = new Map();
    (source.marks || []).forEach((m, i) => markOf.set(m.point, i));
    const orderAt = new Int32Array(timeline.points.length);
    {
      let mo = -1;
      for (let i = 0; i < timeline.points.length; i += 1) {
        const hit = markOf.get(timeline.points[i]);
        if (hit !== undefined) mo = hit;
        orderAt[i] = mo;
      }
    }
    const layerShow = (p) => ({ dots: p.dots, path: p.path, labels: p.labels, accuracy: p.accuracy, clockIns: p.clockIns });

    const scrub = el('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'sim-scrub' });
    const playBtn = el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: '▶ Play' });
    const readout = el('div', { class: 'sim-readout' });
    const speedSelect = el(
      'select',
      {},
      SPEEDS.map((s) => el('option', { value: s.key, text: s.label }))
    );
    const followBox = el('input', { type: 'checkbox', checked: 'checked' });
    const exitBtn = el('button', {
      type: 'button',
      class: 'btn btn-sm',
      text: '✕ Exit replay',
      title: 'Stop replaying and put the whole trail back on the map',
      hidden: 'hidden',
      onclick: () => exitReplay(),
    });

    host.append(
      el('div', { class: 'sim-controls' }, [
        playBtn,
        el('button', { type: 'button', class: 'btn btn-sm', text: '⏮', title: 'Back one heartbeat', onclick: () => step(-1) }),
        el('button', { type: 'button', class: 'btn btn-sm', text: '⏭', title: 'Forward one heartbeat', onclick: () => step(1) }),
        el('button', { type: 'button', class: 'btn btn-sm', text: '↺', title: 'Back to the start', onclick: () => restart() }),
        scrub,
        el('span', { class: 'toolbar-field' }, [el('span', { text: 'Speed' }), speedSelect]),
        el('label', { class: 'chip is-on' }, [followBox, document.createTextNode('Follow')]),
        exitBtn,
      ]),
      readout
    );

    sim = {
      timeline,
      map,
      tMs: timeline.startMs,
      playing: false,
      raf: null,
      last: 0,
      dragging: false,
      // Nothing follows the marker until the user actually drives the replay.
      // Painting the opening frame would otherwise pan straight off the frame
      // that rebuild() had just fitted, which reads as the map jumping on load.
      driven: false,
      // Replay mode: the map has been cleared back to the start and the trail is
      // being drawn as it plays. Distinct from `playing`, which is just whether
      // the clock is running - pausing halfway must not put the whole route back.
      replaying: false,
      lastIndex: -1,
      reveal: null,
      showLayers: (next) => {
        if (sim && sim.reveal) sim.reveal.show(next);
      },
      head: PMMap.playhead(map, { add: true }),
      scrub,
      playBtn,
      readout,
      speedSelect,
      followBox,
    };

    const timeCell = el('span', { class: 'sim-time' });
    const factsCell = el('span', { class: 'sim-facts' });
    readout.append(timeCell, factsCell);

    const factor = () => {
      const chosen = speedSelect.value;
      if (chosen === 'auto') return Math.max(1, timeline.durationMs / 30000);
      return Number(chosen) || 1;
    };

    function paint() {
      const at = PMMap.seekTimeline(timeline, sim.tMs);
      if (!at) return;
      const p = at.point;
      if (sim.replaying) {
        // The revealed trail behind the marker IS the route now, so the comet
        // tail would just draw a second brighter line along the same points.
        sim.reveal.set(orderAt[at.index], at.atMs, { lat: at.lat, lng: at.lng });
        sim.head.set(at, [], p.accuracy);
      } else {
        const from = Math.max(0, at.index - TAIL_FIXES);
        const tail = timeline.points.slice(from, at.index + 1).map((q) => [q.lat, q.lng]);
        tail.push([at.lat, at.lng]);
        sim.head.set(at, tail, p.accuracy);
      }

      if (!sim.dragging) {
        scrub.value = String(Math.round(((sim.tMs - timeline.startMs) / timeline.durationMs) * 1000));
      }

      // Only recentre once the marker has drifted out of the middle of the
      // view: panning every frame fights the user and never settles.
      if (sim.driven && followBox.checked && !map.getBounds().pad(-0.25).contains(L.latLng(at.lat, at.lng))) {
        map.panTo([at.lat, at.lng], { animate: true, duration: 0.4 });
      }

      // The clock moves every frame; the heartbeat behind it does not. Parsing
      // a row of badges sixty times a second for values that changed once is
      // most of what would make this stutter, so only the time is written per
      // frame and the rest is rebuilt when the replay actually reaches the
      // next heartbeat.
      timeCell.textContent = fmt.date(p.at);
      if (at.index === sim.lastIndex) return;
      sim.lastIndex = at.index;

      sim.head.setColor(PMMap.verdictColor(p.verdict, p.insideGeofence));
      const silence =
        at.next && !timeline.glide[at.index]
          ? (new Date(at.next.at).getTime() - new Date(p.at).getTime()) / 60000
          : null;
      factsCell.innerHTML =
        '<span class="sim-cell">heartbeat <b>' + fmt.int(at.index + 1) + '</b> of ' + fmt.int(timeline.points.length) + '</span>' +
        '<span class="sim-cell">' + PM.geofenceBadge(p.insideGeofence, p.verdict) + '</span>' +
        '<span class="sim-cell">' + PM.accuracyBadge(PM.accuracyBandOf(p.accuracy), p.accuracy) + '</span>' +
        (p.battery === null || p.battery === undefined ? '' : '<span class="sim-cell">' + PM.batteryBadge(p.battery) + '</span>') +
        '<span class="sim-cell">' + (p.clockedIn ? 'on the clock' : 'off the clock') + '</span>' +
        '<span class="sim-cell">travelled <b>' + fmt.metres(at.travelledMetres) + '</b></span>' +
        (silence
          ? '<span class="sim-cell sim-hold">⚠ no heartbeat for ' + fmt.duration(silence) + ' - holding here</span>'
          : '');
    }

    function seek(ms, repaint) {
      sim.tMs = Math.max(timeline.startMs, Math.min(ms, timeline.endMs));
      if (repaint !== false) paint();
    }

    /**
     * Hand the map over to the replay: clear the finished trail off it, and let
     * the route be drawn again from the beginning as the clock runs.
     *
     * The static layer groups come off rather than being hidden, because the
     * reveal shows the very same layer objects - one Leaflet layer cannot be in
     * two places at once, and leaving both on would draw the whole route over the
     * top of the one being played.
     */
    function enterReplay() {
      if (!sim || sim.replaying) return;
      const prefs = source.prefs || {};
      // Everything time-based comes off; the geofences stay. A fence is not
      // something that happened at a moment, it is the thing the replay is being
      // judged against, and a trail replaying inside an invisible fence is useless.
      const statics = (source.staticLayers && source.staticLayers()) || {};
      for (const key of ['dots', 'path', 'labels', 'accuracy', 'clockIns']) {
        const layer = statics[key];
        if (layer && map.hasLayer(layer)) map.removeLayer(layer);
      }
      sim.reveal = PMMap.progressiveTrail(map, {
        marks: source.marks || [],
        runs: source.runs || [],
        clockMarks: source.clockMarks || [],
        show: layerShow(prefs),
      });
      sim.reveal.group.addTo(map);
      sim.replaying = true;
      exitBtn.hidden = false;
      host.classList.add("is-replaying");
    }

    /** Wind right back: an empty map, ready to draw the trail again. */
    function restart() {
      pause();
      enterReplay();
      if (sim.reveal) sim.reveal.reset();
      sim.lastIndex = -1;
      seek(timeline.startMs);
    }

    /** Give the map back: the whole trail returns exactly as it was. */
    function exitReplay() {
      if (!sim) return;
      pause();
      if (sim.reveal) {
        sim.reveal.remove();
        sim.reveal = null;
      }
      sim.replaying = false;
      exitBtn.hidden = true;
      host.classList.remove("is-replaying");
      if (source.restore) source.restore();
      paint();
    }

    function step(by) {
      sim.driven = true;
      enterReplay();
      const at = PMMap.seekTimeline(timeline, sim.tMs);
      const next = Math.max(0, Math.min(at.index + by, timeline.points.length - 1));
      pause();
      seek(timeline.times[next]);
    }

    function frame(now) {
      if (!sim || !sim.playing) return;
      const dt = sim.last ? now - sim.last : 16;
      sim.last = now;
      sim.tMs += dt * factor();
      if (sim.tMs >= timeline.endMs) {
        sim.tMs = timeline.endMs;
        paint();
        pause();
        return;
      }
      paint();
      sim.raf = requestAnimationFrame(frame);
    }

    function play() {
      if (!sim || sim.playing) return;
      // Replaying from the end just sits there; start over instead.
      if (sim.tMs >= timeline.endMs) sim.tMs = timeline.startMs;
      sim.driven = true;
      enterReplay();
      sim.playing = true;
      sim.last = 0;
      playBtn.textContent = '❚❚ Pause';
      playBtn.classList.add('is-playing');
      sim.raf = requestAnimationFrame(frame);
    }

    function pause() {
      if (!sim) return;
      sim.playing = false;
      if (sim.raf) cancelAnimationFrame(sim.raf);
      sim.raf = null;
      playBtn.textContent = '▶ Play';
      playBtn.classList.remove('is-playing');
    }

    playBtn.addEventListener('click', () => (sim.playing ? pause() : play()));
    scrub.addEventListener('input', () => {
      sim.dragging = true;
      sim.driven = true;
      enterReplay();
      pause();
      seek(timeline.startMs + (timeline.durationMs * Number(scrub.value)) / 1000);
    });
    scrub.addEventListener('change', () => {
      sim.dragging = false;
    });
    followBox.addEventListener('change', () => {
      followBox.parentNode.classList.toggle('is-on', followBox.checked);
    });

    paint();
  }

  function render(host, spec) {
    const meta = spec.meta || {};
    const row = spec.current || null;
    const prefs = trailPrefs();
    // Held as elements rather than looked up by id. Two ids on one document
    // is what a page-scoped selector costs when a panel becomes reusable.
    const subEl = el('span', { class: 'sub' });
    const guideEl = el('span', { class: 'sub' });
    const noteEl = el('div', { class: 'trail-note', style: 'display:none' });

    // A path joins two fixes and says the device went from one to the other.
    // Across two different people that is a drawing of a journey nobody took,
    // so the caller decides, and the chips for what is switched off go with it
    // - a control that cannot do anything is worse than no control.
    const allowPath = spec.path !== false;
    const allowReplay = spec.replay !== false;
    const hiddenChips = new Set();
    if (!allowPath) hiddenChips.add('path');
    if (spec.clockIns === undefined) hiddenChips.add('clockIns');
    if (!(spec.sites || []).length) hiddenChips.add('fences');
    const toolbar = el('div', { class: 'map-toolbar' });
    const windowBar = el('div', { class: 'map-toolbar map-window' });
    const simBar = el('div', { class: 'sim-bar' });
    const mapHost = el('div', { class: 'map', style: 'height:' + (spec.height || '460px') });

    host.append(
      el('div', { class: 'card-head' }, [
        el('h2', { text: spec.title || 'Location & trail' }),
        subEl,
        el('div', { class: 'spacer' }),
        guideEl,
      ]),
      toolbar,
      windowBar,
      mapHost,
      simBar,
      noteEl,
      el('div', { html: PMMap.trailLegend() })
    );
    renderWindowBar(windowBar, spec, { narrow: spec.narrow !== false });

    // The replay owns a requestAnimationFrame loop and a marker on the old map.
    // This panel is rebuilt on every reload, so the previous one has to be shut
    // down here or it keeps animating against a map that no longer exists.
    stopSim();

    // Every reload of this page - a filter change, and every auto-refresh tick -
    // re-renders this panel, which throws the old map's container away. The old
    // L.Map object survived that: its window resize handler stayed attached to a
    // detached container, it stayed in PMMap.instances for retheme() to walk,
    // and the fresh map re-fitted, so anyone who had zoomed in to read a cluster
    // was thrown back out to the whole trail every refresh. Tear the old one
    // down properly, and hand the new one the view the user was looking at.
    if (map) {
      try {
        map.remove();
      } catch (err) {
        /* already gone with its container */
      }
      map = null;
    }
    map = PMMap.create(mapHost);
    const restoring = mapView !== null;
    if (restoring) map.setView(mapView.center, mapView.zoom);
    setTimeout(() => map.invalidateSize(), 60);

    // Layers are built once per data load and toggled by adding / removing.
    let built = null;
    let skippedFences = 0;

    const rebuild = (options) => {
      const refit = !(options && options.keepView === true);
      // Before anything else: a replay from the previous load owns layer objects
      // that are about to be replaced, and applyVisibility() steps aside while one
      // is running - so tearing it down later would leave the map with neither the
      // revealed trail nor the static one.
      stopSim();
      if (built) {
        for (const layer of Object.values(built.layers)) if (layer) map.removeLayer(layer);
        for (const extra of built.extras) if (extra && extra.group) extra.group.remove();
      }
      // Numbered once, over the whole track, before the state filter runs: a
      // sequence number names a heartbeat in the table below, so "Inside fence"
      // must not renumber the ones it leaves behind.
      const all = (spec.points || []).map((p, i) => (p.seq === undefined ? { ...p, seq: i + 1 } : p));
      const points = all.filter((p) => stateMatches(p, prefs.state));
      const trail = PMMap.trail(map, points, { add: false, thin: prefs.merge });
      const clock = PMMap.clockIns(map, spec.clockIns || [], { add: false });

      const fences = L.layerGroup();
      const extras = [];
      for (const site of spec.sites || []) {
        if (site.lat == null) continue;
        const circle = PMMap.siteCircle(map, site, { label: false });
        if (circle && circle.group) {
          circle.group.remove();
          fences.addLayer(circle.group);
        }
      }

      built = {
        layers: {
          dots: trail.layers.dots,
          path: allowPath ? trail.layers.path : null,
          labels: trail.layers.labels,
          accuracy: trail.layers.accuracy,
          clockIns: clock.group,
          fences,
        },
        extras,
        trail,
        points,
      };

      // The current fix and the guidance line always show - they are the answer
      // to "where is this person now", not a layer. There is no such answer on a
      // fleet-wide map, so a panel mounted without a current row simply has none.
      if (row && row.location) {
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

      // The heartbeats and the current fix decide the frame; fences join it only
      // if they are near enough to share one. A site 40 km away used to frame a
      // 40 km box and squash a whole shift's trail into a single pixel.
      const core = points.slice();
      if (row && row.location) core.push(row.location);
      const context = (spec.sites || [])
        .filter((s) => s.lat != null)
        // The radius comes along so a fence near enough to keep is framed to its
        // boundary rather than to its centre point.
        .map((s) => ({ lat: s.lat, lng: s.lng, radius: s.radiusIsAuthoritative ? s.radius : null }));
      // Keeping the user's view is only kind while there is still something in
      // it. Change the date range to another day and the trail moves somewhere
      // else entirely - restoring the old frame would hand back a blank map and
      // look exactly like the failure this whole change is about. So the view is
      // kept only if at least one heartbeat is actually inside it.
      let doFit = refit;
      if (!doFit) {
        const inView = map.getBounds();
        const visible = core.some(
          (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && inView.contains(L.latLng(p.lat, p.lng))
        );
        if (!visible) doFit = true;
      }
      // Only a refit recomputes which fences fit in the frame; a reload that
      // keeps the user's view keeps the last answer, so the note under the map
      // does not blink off while the fence is still off the edge.
      if (doFit) skippedFences = PMMap.fitWithContext(map, core, context).skipped;

      const stats = trail.stats;
      const gaps = stats.gapShort + stats.gapLong;
      const inRange = meta.inRange;
      subEl.textContent =
        // Plotted out of in-range, always, so this line can be reconciled with
        // the KPI tile above without reading the notes underneath.
        fmt.int(stats.points) +
        (inRange && inRange !== stats.points ? ' of ' + fmt.int(inRange) : '') +
        ' heartbeats' +
        (stats.merged ? ' · ' + fmt.int(stats.drawn) + ' marks' : '') +
        (prefs.state === 'all' ? '' : ' matching "' + (STATES.find((x) => x.key === prefs.state) || {}).label + '"') +
        ' · ' +
        (spec.sites || []).length +
        ' fence(s)' +
        (gaps ? ' · ' + gaps + ' reporting gap(s)' : '') +
        (stats.jump ? ' · ' + stats.jump + ' suspicious jump(s)' : '') +
        (meta.travelledMetres === null || meta.travelledMetres === undefined
          ? ''
          : ' · travelled ' + fmt.metres(meta.travelledMetres) + (meta.truncated ? ' over the plotted trail' : ''));
      guideEl.innerHTML = row && row.guide
        ? '<a href="' + row.guide.directionsUrl + '" target="_blank" rel="noopener">↗ Walking directions back to the site</a>'
        : '';
      renderTrailNote(stats, skippedFences);
      // The replay walks the same points the map is showing, so a change of
      // State filter or of window rebuilds it against the new set rather than
      // animating a trail that is no longer on screen.
      if (allowReplay) {
        buildSim(map, points, simBar, {
          marks: trail.marks,
          runs: trail.runs,
          clockMarks: clock.marks,
          prefs,
          // Read late: `built` is reassigned on every rebuild, so capturing the
          // groups here would hand the replay a previous load to switch off.
          staticLayers: () => (built ? built.layers : {}),
          restore: applyVisibility,
        });
      } else {
        // Named, not just absent. A replay control that is simply missing reads
        // as a feature this page does not have, rather than one these points
        // cannot support.
        simBar.innerHTML = '';
        simBar.append(
          el('div', {
            class: 'sim-empty',
            text:
              spec.reason ||
              'Replay walks one device through its own heartbeats, so it needs a single stream to play.',
          })
        );
      }
    };

    /**
     * Where every heartbeat went, said out loud.
     *
     * "Not all my heartbeats are showing" had four different causes and the map
     * reported none of them, so each one looked like the same bug. The chain
     * from the count above the map down to the marks on it is:
     *
     *   in range  ->  loaded (the Fixes limit)  ->  plottable (has coordinates)
     *             ->  matching (the State filter)  ->  drawn (Merge nearby)
     *
     * Every step that removes anything names itself here, with the control that
     * caused it, so the number on the map can always be reconciled with the KPI
     * tile above it.
     */
    const renderTrailNote = (stats, skippedFences) => {
      const notes = [];
      const total = meta.inRange;
      const loaded = meta.fetched;
      const plottable = (spec.points || []).length;
      const noFix = meta.noFix || 0;
      const hidden = plottable - stats.points;

      // 1. The Fixes limit: the newest N of the range, not the range.
      if (meta.truncated && total && loaded < total) {
        const atCeiling = meta.limit >= (meta.ceiling || Infinity);
        notes.push(
          '<b>Loaded the newest ' +
            fmt.int(loaded) +
            ' of ' +
            fmt.int(total) +
            ' heartbeats in range.</b> This device reports faster than the Fixes limit, so the map starts at ' +
            (meta.from ? fmt.date(meta.from) : 'the tail of the range') +
            ' rather than the beginning of the window. ' +
            (atCeiling
              ? 'That is the highest the limit goes - narrow the time range to reach earlier heartbeats.'
              : 'Raise <b>Fixes</b> above, or narrow the time range.')
        );
      }

      // 2. No coordinates: a real heartbeat that no map can place.
      if (noFix) {
        notes.push(
          fmt.int(noFix) +
            ' of the ' +
            fmt.int(loaded) +
            ' loaded heartbeat' +
            (loaded === 1 ? '' : 's') +
            ' arrived with no coordinates and cannot be placed on a map. They are in the heartbeat rows, and in the counts above.'
        );
      }

      // 3. The State filter - which is remembered per browser, so it can be on
      //    from a previous visit with nothing on screen to explain the gap.
      if (hidden > 0) {
        const label = (STATES.find((x) => x.key === prefs.state) || {}).label || prefs.state;
        notes.push(
          '<b>The State filter is hiding ' +
            fmt.int(hidden) +
            ' of ' +
            fmt.int(plottable) +
            ' plotted heartbeats.</b> Only those matching "' +
            esc(label) +
            '" are drawn. Set State back to "All heartbeats" to see the rest.'
        );
      }

      // 4. Merging - only ever on because someone ticked it.
      if (stats.merged) {
        notes.push(
          '<b>Merge nearby</b> is on: ' +
            fmt.int(stats.merged) +
            ' fix' +
            (stats.merged === 1 ? '' : 'es') +
            ' sat within their own GPS accuracy of the fix before and are folded into it, leaving ' +
            fmt.int(stats.drawn) +
            ' mark' +
            (stats.drawn === 1 ? '' : 's') +
            ' - click one for the count it stands for. Untick it to draw all ' +
            fmt.int(stats.points) +
            '. Either way all ' +
            fmt.int(stats.points) +
            ' are counted in the gap and jump figures above.'
        );
      }

      // Why there is no line between the marks. Without this the map just
      // looks like a trail that failed to draw.
      //
      // Only when the replay bar is not already saying it. One `reason`
      // covers both controls, and every caller so far switches them off
      // together, so printing it here as well stacked the same sentence
      // twice under the map. The bar is the better place for it - it is
      // where the missing control was - so this is the fallback for a
      // caller that allows the replay but not the path.
      if (!allowPath && allowReplay && spec.reason) {
        notes.push(esc(spec.reason));
      }

      // Not a heartbeat problem, but the same class of silent omission.
      if (skippedFences) {
        notes.push(
          fmt.int(skippedFences) +
            ' fence(s) are too far from this trail to frame with it and are off the map. They are still counted, and named in the heartbeat rows.'
        );
      }

      // Drawing every fix is the default, and on a dense reporter that is a lot
      // of canvas paths. Say so rather than just feeling slow.
      if (!stats.merged && stats.drawn > 15000) {
        notes.push(
          'Drawing ' +
            fmt.int(stats.drawn) +
            ' marks. Panning and zooming will be slow, and fixes this dense overlap into a blob - tick <b>Merge nearby</b> for a faster and more readable map without loading less.'
        );
      }

      const hostNote = noteEl;
      hostNote.innerHTML = notes.length ? notes.map((n) => '<div>' + n + '</div>').join('') : '';
      hostNote.style.display = notes.length ? '' : 'none';
    };

    // Bottom to top. Canvas layers are drawn - and hit-tested - in the order
    // they are added, and the last match wins a click, so the dots have to go
    // on last or a fence circle drawn over them eats every heartbeat click.
    const Z_ORDER = ['accuracy', 'fences', 'path', 'clockIns', 'labels', 'dots'];

    const applyVisibility = () => {
      if (!built) return;
      // While a replay is running it owns these layers - the very same objects,
      // revealed one at a time - so putting the finished trail back on the map
      // here would draw the whole route over the top of the one being played.
      // The toolbar still records the change; it lands when the replay exits.
      if (sim && sim.replaying) {
        sim.showLayers(prefs);
        return;
      }
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
      if (hiddenChips.has(layer.key)) continue;
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

    // Merging is a drawing decision, not a layer, so it gets its own chip -
    // off by default, because the map should hold one mark per heartbeat until
    // someone asks for the legible-but-fewer version.
    const mergeBox = el('input', { type: 'checkbox', checked: prefs.merge ? 'checked' : null });
    const mergeChip = el(
      'label',
      {
        class: 'chip' + (prefs.merge ? ' is-on' : ''),
        title: 'Fold fixes that sit within their own GPS accuracy of the previous one into it. Fewer marks, and the path and accuracy halos become visible under a stationary cluster.',
      },
      [mergeBox, document.createTextNode('Merge nearby')]
    );
    mergeBox.addEventListener('change', () => {
      prefs.merge = mergeBox.checked;
      saveTrailPref('merge', mergeBox.checked);
      mergeChip.classList.toggle('is-on', mergeBox.checked);
      // A different set of marks, same data - keep the frame the user is on.
      rebuild({ keepView: true });
    });
    toolbar.append(mergeChip);

    const stateSelect = el(
      'select',
      {
        onchange: (event) => {
          prefs.state = event.target.value;
          saveTrailPref('state', prefs.state);
          // A different subset of the trail is a different frame - refit.
          rebuild();
        },
      },
      STATES.map((st) => el('option', { value: st.key, text: st.label, selected: prefs.state === st.key ? 'selected' : null }))
    );

    // Changing how many heartbeats to pull is a new request, not a redraw.
    const limitSelect = el(
      'select',
      {
        title: 'How many of the most recent heartbeats in range to load for this map',
        onchange: (event) => {
          saveTrailPref('limit', event.target.value);
          spec.onReload();
        },
      },
      FIX_LIMITS.map((n) =>
        el('option', { value: String(n), text: fmt.int(n), selected: prefs.limit === n ? 'selected' : null })
      )
    );

    toolbar.append(
      el('div', { style: 'flex:1' }),
      el('span', { class: 'toolbar-field' }, [el('span', { text: 'Fixes' }), limitSelect]),
      el('span', { class: 'toolbar-field' + (prefs.state === 'all' ? '' : ' is-filtering') }, [
        el('span', { text: 'State' }),
        stateSelect,
      ]),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: '⤢ Fit',
        title: 'Frame the trail again',
        onclick: () => rebuild(),
      })
    );

    rebuild({ keepView: restoring });
    // Remembered from here on, so the next reload lands where the user left off.
    // A deliberate refit fires these too, which is right - that frame becomes
    // the one to come back to.
    map.on('moveend zoomend', () => {
      mapView = { center: map.getCenter(), zoom: map.getZoom() };
    });
  }

  /** Leaflet needs a nudge whenever its container was hidden while sizing. */
  function resize() {
    if (map) setTimeout(() => map.invalidateSize(), 40);
  }

  /**
   * Give up the map and the replay loop.
   *
   * A panel that is navigated away from without this leaves a
   * requestAnimationFrame loop running against a dead container and a map in
   * PMMap's register for retheme() to walk.
   */
  function destroy() {
    stopSim();
    if (map) {
      try {
        map.remove();
      } catch (err) {
        /* already gone with its container */
      }
      map = null;
    }
  }

  /** The frame the reader is on, so a page can put it back after a reload. */
  function view() {
    return mapView;
  }

  return {
    render,
    // The Heartbeats tab on a user page carries the same bar without the map.
    windowBar: renderWindowBar,
    resize,
    destroy,
    view,
    stopSim,
    fixLimit,
    stateMatches,
    TRAIL_LAYERS,
    STATES,
    FIX_LIMITS,
    WINDOW_PRESETS,
  };
})();
