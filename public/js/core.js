/* ==========================================================================
   Phantom Monitor - shared front-end runtime.
   Owns: session check, shell + nav, the filter bar (URL-synced), formatting,
   the detail drawer, auto-refresh, toasts. Pages register an init function and
   read filter state from PM.filters.
   ========================================================================== */
window.PM = (function () {
  'use strict';

  const PAGES = [
    { file: 'index.html', title: 'Overview', icon: '◧', group: 'Monitoring' },
    { file: 'map.html', title: 'Live Map', icon: '◎', group: 'Monitoring' },
    { file: 'users.html', title: 'Users & Devices', icon: '☰', group: 'Monitoring' },
    { file: 'heartbeats.html', title: 'Heartbeats', icon: '∿', group: 'Monitoring', countKey: 'snapshots' },
    { file: 'checks.html', title: 'Geofence Checks', icon: '⛨', group: 'Geofencing', countKey: 'clockInLogs' },
    { file: 'exit-windows.html', title: 'Exit Windows', icon: '⇥', group: 'Geofencing' },
    { file: 'sites.html', title: 'Geofence Sites', icon: '⬡', group: 'Geofencing' },
    { file: 'explorer.html', title: 'Query Explorer', icon: '⌨', group: 'Data' },
  ];

  const THEME_KEY = 'pm.theme';
  const THEMES = [
    { key: 'light', label: '☀ Light' },
    { key: 'dark', label: '☾ Dark' },
    { key: 'system', label: '◑ System' },
  ];

  const state = {
    meta: null,
    authRequired: false,
    theme: 'light',
    activeFile: null,
    page: null,
    filterSpec: [],
    // Set when a page passes a builder, so the bar can be redrawn once the
    // dropdown contents arrive.
    filterBuilder: null,
    hideChips: [],
    filters: {},
    refreshMs: Number(localStorage.getItem('pm.refresh') || 0),
    refreshTimer: null,
    lastLoadedAt: null,
    // Set when a refresh fails, so the page can say the figures are old.
    staleSince: null,
  };

  // ------------------------------------------------------------------ theme
  // One live object, mutated in place: charts.js and maps.js hold a reference to
  // it, so switching theme repaints them without a page reload.
  const colors = {
    series: [],
    in: '',
    out: '',
    unknown: '',
    good: '',
    warning: '',
    serious: '',
    critical: '',
    grid: '',
    baseline: '',
    surface2: '',
    border: '',
    ink: '',
    ink2: '',
    muted: '',
    surface: '',
  };

  /** The stylesheet is the single source of truth for colour. */
  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    colors.series = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v('--series-' + i));
    colors.in = v('--geo-in');
    colors.out = v('--geo-out');
    colors.unknown = v('--geo-unknown');
    colors.good = v('--good');
    colors.warning = v('--warning');
    colors.serious = v('--serious');
    colors.critical = v('--critical');
    colors.grid = v('--grid');
    colors.baseline = v('--baseline');
    colors.ink = v('--ink');
    colors.ink2 = v('--ink-2');
    colors.muted = v('--ink-muted');
    colors.surface = v('--surface');
    colors.surface2 = v('--surface-2');
    colors.border = v('--border-strong');
    return colors;
  }

  function storedTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return THEMES.some((t) => t.key === saved) ? saved : 'light';
    } catch (err) {
      return 'light';
    }
  }

  function applyTheme(theme, options) {
    state.theme = theme;
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (err) {
      /* private mode: the choice just will not persist */
    }
    readColors();
    if (window.PMChart && window.PMChart.applyTheme) window.PMChart.applyTheme();
    renderThemeSwitch();
    if (!options || options.repaint !== false) {
      // Charts and map markers carry baked-in colours, so redraw them.
      emit('pm:theme');
      emit('pm:refresh');
    }
  }

  function renderThemeSwitch() {
    const host = document.querySelector('#theme-switch');
    if (!host) return;
    host.innerHTML = '';
    for (const theme of THEMES) {
      host.append(
        el('button', {
          class: state.theme === theme.key ? 'active' : '',
          text: theme.label,
          title: theme.key === 'system' ? 'Follow the operating system setting' : theme.label + ' theme',
          onclick: () => applyTheme(theme.key),
        })
      );
    }
  }

  // ------------------------------------------------------------------ utils
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  const esc = (s) =>
    String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  // ------------------------------------------------------------ formatting
  const fmt = {
    num(v, digits) {
      if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '--';
      return Number(v).toLocaleString(undefined, {
        minimumFractionDigits: digits || 0,
        maximumFractionDigits: digits === undefined ? 0 : digits,
      });
    },
    int(v) {
      return fmt.num(v, 0);
    },
    metres(v) {
      if (v === null || v === undefined) return '--';
      const n = Number(v);
      if (Math.abs(n) >= 1000) return (n / 1000).toFixed(2) + ' km';
      return n.toFixed(Math.abs(n) < 10 ? 1 : 0) + ' m';
    },
    accuracy(v) {
      return v === null || v === undefined ? '--' : '±' + Number(v).toFixed(Number(v) < 10 ? 1 : 0) + ' m';
    },
    pct(v, digits) {
      return v === null || v === undefined ? '--' : Number(v).toFixed(digits === undefined ? 1 : digits) + '%';
    },
    coords(loc) {
      if (!loc || loc.lat === null || loc.lat === undefined) return '--';
      return Number(loc.lat).toFixed(5) + ', ' + Number(loc.lng).toFixed(5);
    },
    date(v) {
      if (!v) return '--';
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
    },
    time(v) {
      if (!v) return '--';
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? '--' : d.toLocaleTimeString(undefined, { hour12: false });
    },
    dayTime(v) {
      if (!v) return '--';
      const d = new Date(v);
      return Number.isNaN(d.getTime())
        ? '--'
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    },
    /**
     * A moment in the WORKER'S timezone, with the zone named.
     *
     * Every other formatter here renders in the viewer’s browser timezone,
     * which is right for "how long ago" and wrong for "when did this happen".
     * This fleet spans America/Bogota, America/Chicago and Asia/Karachi, and
     * over nine tenths of the heartbeats come from people ten or eleven hours
     * away from a viewer in Karachi - so a gap shown as 03:37 actually happened
     * at 17:37 the previous afternoon where the person was standing. Shifts,
     * overnight and end-of-day are unreadable without this.
     *
     * The zone is always named, because a bare local time is a different kind
     * of wrong: it looks authoritative and cannot be checked.
     */
    dateIn(v, timezone) {
      if (!v) return '--';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '--';
      if (!timezone) return fmt.date(v);
      try {
        // Spelt out component by component on purpose: dateStyle/timeStyle
        // cannot be combined with timeZoneName - that throws - and the throw
        // used to land in the catch below, quietly rendering the VIEWER'S time
        // under a function whose whole job is not to.
        return d.toLocaleString(undefined, {
          timeZone: timezone,
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZoneName: 'short',
        });
      } catch (err) {
        // An unknown zone name from the device: fall back rather than break.
        return fmt.date(v);
      }
    },

    /**
     * `dayTime` in the worker’s timezone, zone named: "Sep 3, 14:32 PKT".
     *
     * A table column narrow enough for a date and a time, but rendered where
     * the work happened. Labelling a viewer-local time with the device’s zone
     * is worse than either on its own - it reads as authoritative and is off
     * by the offset between them, which across this fleet is up to ten hours.
     */
    dayTimeIn(v, timezone) {
      if (!v) return '--';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '--';
      if (!timezone) return fmt.dayTime(v);
      try {
        return d.toLocaleString(undefined, {
          timeZone: timezone,
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZoneName: 'short',
        });
      } catch (err) {
        // An unknown zone from the device: the viewer’s reading, unlabelled,
        // rather than a wrong label.
        return fmt.dayTime(v);
      }
    },

    /** Clock time in the worker’s timezone, zone named. */
    timeIn(v, timezone) {
      if (!v) return '--';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '--';
      if (!timezone) return fmt.time(v);
      try {
        return d.toLocaleTimeString(undefined, {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZoneName: 'short',
        });
      } catch (err) {
        return fmt.time(v);
      }
    },

    /**
     * Both readings of the same instant, for a title attribute: the worker’s
     * local time and the viewer’s, so neither has to be taken on trust.
     */
    bothZones(v, timezone) {
      if (!v) return '';
      const mine = fmt.date(v);
      if (!timezone) return mine + ' (your time)';
      return fmt.dateIn(v, timezone) + ' where they are' + String.fromCharCode(10) + mine + ' your time';
    },

    /** Short zone label for a column heading or a chip: "PKT", "-05". */
    zoneLabel(timezone) {
      if (!timezone) return '';
      try {
        const parts = new Intl.DateTimeFormat(undefined, {
          timeZone: timezone,
          timeZoneName: 'short',
        }).formatToParts(new Date());
        const hit = parts.find((x) => x.type === 'timeZoneName');
        return hit ? hit.value : timezone;
      } catch (err) {
        return timezone;
      }
    },

    /**
     * A measured span, in whole units: "45s", "42 min", "2h 49m", "1d 4h".
     *
     * fmt.duration puts one decimal on anything under ten minutes, so a row of
     * spans came out as "2h 49m" beside "6.7 min" - the same quantity written two
     * ways in adjacent tiles. This is for columns of measured time, where they
     * have to be readable against each other at a glance.
     */
    span(ms) {
      if (ms === null || ms === undefined) return '--';
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return seconds + 's';
      const minutes = Math.round(ms / 60000);
      if (minutes < 90) return minutes + ' min';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
      return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
    },

    ago(v) {
      if (!v) return '--';
      const mins = (Date.now() - new Date(v).getTime()) / 60000;
      return fmt.duration(mins) + ' ago';
    },
    duration(minutes) {
      if (minutes === null || minutes === undefined) return '--';
      const m = Number(minutes);
      if (m < 1) return Math.max(0, Math.round(m * 60)) + 's';
      if (m < 60) return m.toFixed(m < 10 ? 1 : 0) + ' min';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + Math.round(m % 60) + 'm';
      return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    },
    bool(v, yes, no) {
      if (v === null || v === undefined) return '--';
      return v ? yes || 'Yes' : no || 'No';
    },
    initials(name) {
      if (!name) return '?';
      return name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase();
    },
  };

  // ----------------------------------------------------------------- badges
  /** Geofence state badge - colour plus an always-present text label. */
  function geofenceBadge(inside, verdict, reason) {
    if (verdict === 'unknown') {
      return '<span class="badge badge-warning" title="' + esc(reason || '') + '">◐ Uncertain</span>';
    }
    // An explicit verdict wins; the device flag is the fallback.
    if (verdict === 'in' || (verdict === undefined && inside === true) || (verdict === null && inside === true)) {
      return '<span class="badge badge-good">● Inside</span>';
    }
    if (verdict === 'out' || (verdict === undefined && inside === false) || (verdict === null && inside === false)) {
      return '<span class="badge badge-critical">▲ Outside</span>';
    }
    return '<span class="badge badge-neutral">○ No fence</span>';
  }

  /**
   * The band a metre reading falls into.
   *
   * Rows that come from the server carry their own `accuracyBand`, but the
   * user page's trail deliberately does not - it is thousands of points and the
   * band is derivable, so shipping it was megabytes of something the client can
   * work out. The thresholds come from `/api/meta`, which is generated from
   * `server/lib/geo.js`, so this stays in step with the filter dropdown and the
   * server's own banding. The literals are the same list, for the moment before
   * meta arrives.
   */
  const FALLBACK_BANDS = [
    { key: 'excellent', max: 10 },
    { key: 'good', max: 25 },
    { key: 'fair', max: 50 },
    { key: 'poor', max: 100 },
    { key: 'unusable', max: null },
  ];

  function accuracyBandOf(accuracy) {
    const n = Number(accuracy);
    if (!Number.isFinite(n)) return 'unknown';
    const bands = (state.meta && state.meta.accuracyBands) || null;
    const list = bands && bands.length ? bands.filter((b) => b.key !== 'unknown') : FALLBACK_BANDS;
    for (const band of list) {
      if (band.max === null || band.max === undefined || n < band.max) return band.key;
    }
    return 'unusable';
  }

  function accuracyBadge(band, accuracy) {
    const map = {
      excellent: ['badge-good', 'Excellent'],
      good: ['badge-info', 'Good'],
      fair: ['badge-warning', 'Fair'],
      poor: ['badge-serious', 'Poor'],
      unusable: ['badge-critical', 'Unusable'],
      unknown: ['badge-neutral', 'No fix'],
    };
    const [cls, label] = map[band] || map.unknown;
    const suffix = accuracy === null || accuracy === undefined ? '' : ' ' + fmt.accuracy(accuracy);
    return '<span class="badge ' + cls + '">' + label + suffix + '</span>';
  }

  function batteryBadge(pct) {
    if (pct === null || pct === undefined) return '<span class="badge badge-neutral">Battery n/a</span>';
    const cls = pct <= 10 ? 'badge-critical' : pct <= 20 ? 'badge-warning' : 'badge-neutral';
    return '<span class="badge ' + cls + '">' + pct + '%</span>';
  }

  function meter(value, max, color) {
    const pct = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return '<span class="bar-meter"><i style="width:' + pct.toFixed(1) + '%;background:' + color + '"></i></span>';
  }

  function jsonHighlight(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return esc(text)
      .replace(/&quot;([^&]*?)&quot;(\s*:)/g, '<span class="k">"$1"</span>$2')
      .replace(/:\s*&quot;([^]*?)&quot;/g, ': <span class="s">"$1"</span>')
      .replace(/:\s*(-?\d+\.?\d*(e[+-]?\d+)?)/gi, ': <span class="n">$1</span>')
      .replace(/:\s*(true|false|null)/g, ': <span class="b">$1</span>');
  }

  // -------------------------------------------------------------------- api
  let inflight = 0;
  function progress(delta) {
    inflight = Math.max(0, inflight + delta);
    const bar = document.querySelector('.loading-bar');
    if (!bar) return;
    if (inflight > 0) {
      bar.style.opacity = '1';
      bar.style.width = '65%';
    } else {
      bar.style.width = '100%';
      setTimeout(() => {
        bar.style.opacity = '0';
        bar.style.width = '0';
      }, 220);
    }
  }

  /**
   * Fetch JSON, or throw. The thrown Error carries the response body on
   * `.payload`, because an error's details are often the useful part - a 404
   * that knows when the user was last seen can offer a way out.
   */
  async function api(path, options) {
    progress(1);
    try {
      const res = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      if (res.status === 401) {
        // The credentials stopped working - the password changed, most likely.
        // Reloading is the recovery: a top-level request with bad credentials is
        // what makes the browser ask again. There is no login page to send them to.
        location.reload();
        throw new Error('Not authorised - reloading');
      }
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (err) {
        throw new Error('Bad response from ' + path);
      }
      if (!res.ok) {
        const err = new Error((body && body.error) || res.statusText);
        err.status = res.status;
        err.payload = body;
        throw err;
      }
      return body;
    } finally {
      progress(-1);
    }
  }

  const toasts = [];
  function toast(message, kind) {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = el('div', { class: 'toast-stack' });
      document.body.append(stack);
    }
    const node = el('div', { class: 'toast ' + (kind || ''), text: message });
    stack.append(node);
    toasts.push(node);
    setTimeout(() => node.remove(), kind === 'error' ? 7000 : 3500);
  }

  // --------------------------------------------------------------- filters
  const RANGE_PRESETS = [
    { key: '1h', label: 'Last hour', minutes: 60 },
    { key: '3h', label: 'Last 3 hours', minutes: 180 },
    { key: '6h', label: 'Last 6 hours', minutes: 360 },
    { key: '12h', label: 'Last 12 hours', minutes: 720 },
    { key: '24h', label: 'Last 24 hours', minutes: 1440 },
    { key: '3d', label: 'Last 3 days', minutes: 4320 },
    { key: '7d', label: 'Last 7 days', minutes: 10080 },
    { key: 'all', label: 'All time', minutes: null },
    { key: 'custom', label: 'Custom range...', minutes: undefined },
  ];

  // What every page opens on, and what Reset goes back to.
  const DEFAULT_RANGE = '3h';

  function readUrlState() {
    const params = new URLSearchParams(location.search);
    const out = {};
    for (const [k, v] of params.entries()) {
      if (out[k] === undefined) out[k] = v;
      else out[k] = [].concat(out[k], v);
    }
    return out;
  }

  function writeUrlState(replace) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(state.filters)) {
      if (v === null || v === undefined || v === '') continue;
      for (const item of [].concat(v)) {
        if (item === '' || item === null || item === undefined) continue;
        params.append(k, item);
      }
    }
    const url = location.pathname + (params.toString() ? '?' + params.toString() : '');
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  /** Query string for the API, resolving the range preset into from/to. */
  function queryString(extra) {
    const params = new URLSearchParams();
    const f = { ...state.filters, ...(extra || {}) };
    const preset = f.range || DEFAULT_RANGE;
    delete f.range;

    if (preset !== 'all' && preset !== 'custom') {
      const hit = RANGE_PRESETS.find((p) => p.key === preset);
      if (hit && hit.minutes) {
        // Rounded down to the minute. Taken raw, a rolling preset produces a
        // slightly different `from` on every call, so no two requests ever share
        // a cache key on the server - every auto-refresh tick and every page
        // navigation paid full price for aggregations that had just been run.
        // A window that starts up to a minute early changes no answer here.
        const startedAt = Date.now() - hit.minutes * 60000;
        f.from = new Date(Math.floor(startedAt / 60000) * 60000).toISOString();
        delete f.to;
      }
    } else if (preset === 'all') {
      delete f.from;
      delete f.to;
    }

    for (const [k, v] of Object.entries(f)) {
      if (v === null || v === undefined || v === '') continue;
      for (const item of [].concat(v)) {
        if (item === '' || item === null || item === undefined) continue;
        params.append(k, item);
      }
    }
    return params.toString();
  }

  function setFilter(key, value, options) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) {
      delete state.filters[key];
    } else {
      state.filters[key] = value;
    }
    writeUrlState(true);
    renderChips();
    if (!options || options.reload !== false) emit('pm:filters');
  }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /**
   * Draws the filter bar.
   *
   * `spec` may be a function returning the spec, and pages pass one so the bar
   * can be built twice: once immediately, and again when /api/meta lands with
   * the contents of the dropdowns. Passing an already-built array still works,
   * but its options are then frozen at whatever metadata existed at the time.
   *
   * options.hideChips - params that identify the page, not a filter to clear.
   */
  function buildFilterBar(spec, options) {
    if (typeof spec === 'function') {
      state.filterBuilder = spec;
      state.filterSpec = spec() || [];
    } else {
      state.filterBuilder = null;
      state.filterSpec = spec || [];
    }
    if (options || !state.hideChips) state.hideChips = (options && options.hideChips) || [];
    const host = document.querySelector('#filters');
    if (!host) return;
    host.innerHTML = '';
    if (!state.filterSpec.length) {
      host.style.display = 'none';
      return;
    }

    const row = el('div', { class: 'filter-row' });
    for (const item of state.filterSpec) row.append(renderControl(item));

    const actions = el('div', { class: 'field field-inline', style: 'margin-left:auto' }, [
      el('button', {
        class: 'btn btn-sm',
        text: '⌨ Advanced',
        title: 'Raw MongoDB where clause',
        onclick: () => document.querySelector('#advanced').classList.toggle('open'),
      }),
      el('button', { class: 'btn btn-sm', text: '⧉ Copy link', onclick: copyLink }),
      el('button', { class: 'btn btn-sm', text: '⟲ Reset', onclick: resetFilters }),
    ]);
    row.append(actions);
    host.append(row);

    // --- advanced / raw where clause -------------------------------------
    const adv = el('div', { class: 'adv', id: 'advanced' });
    const whereBox = el('textarea', {
      id: 'where-input',
      rows: 4,
      spellcheck: 'false',
      placeholder: '{ "batteryPercentage": { "$lte": 15 }, "deviceType": "ios" }',
    });
    whereBox.value = state.filters.where || '';
    const savedBox = el('select', { id: 'saved-views' });

    adv.append(
      el('div', { class: 'adv-grid' }, [
        el('div', { class: 'field' }, [
          el('label', { text: 'Where clause (MongoDB query, read-only)' }),
          whereBox,
          el('div', {
            class: 'hint',
            html:
              'Applied on top of the controls above with <code>$and</code>. Extended JSON works: ' +
              '<code>{"createdAt":{"$gte":{"$date":"2026-08-30T00:00:00Z"}}}</code>. ' +
              '<code>$where</code>, <code>$function</code> and write stages are rejected.',
          }),
          el('div', { class: 'field field-inline' }, [
            el('button', {
              class: 'btn btn-sm btn-primary',
              text: 'Apply clause',
              onclick: () => setFilter('where', whereBox.value.trim()),
            }),
            el('button', {
              class: 'btn btn-sm',
              text: 'Clear',
              onclick: () => {
                whereBox.value = '';
                setFilter('where', '');
              },
            }),
          ]),
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Saved views' }),
          savedBox,
          el('div', { class: 'field field-inline' }, [
            el('button', { class: 'btn btn-sm', text: 'Load', onclick: () => loadView(savedBox.value) }),
            el('button', { class: 'btn btn-sm', text: 'Save current', onclick: saveView }),
            el('button', { class: 'btn btn-sm', text: 'Delete', onclick: () => deleteView(savedBox.value) }),
          ]),
          el('div', {
            class: 'hint',
            text: 'Views store every filter on this page, including the where clause, in this browser.',
          }),
        ]),
      ])
    );
    host.append(adv);
    host.append(el('div', { class: 'chips', id: 'filter-chips' }));
    host.style.display = '';
    refreshViewList();
    renderChips();
  }

  function renderControl(item) {
    const wrap = el('div', { class: 'field' });
    if (item.kind === 'daterange') {
      wrap.append(el('label', { text: item.label || 'Time range' }));
      const inner = el('div', { class: 'field field-inline' });
      const select = el('select', {
        onchange: (e) => {
          setFilter('range', e.target.value, { reload: e.target.value !== 'custom' });
          renderCustomRange(inner, e.target.value === 'custom');
        },
      });
      const current = state.filters.range || (state.filters.from ? 'custom' : DEFAULT_RANGE);
      for (const p of RANGE_PRESETS) {
        select.append(el('option', { value: p.key, text: p.label, selected: current === p.key ? 'selected' : null }));
      }
      inner.append(select);
      wrap.append(inner);
      renderCustomRange(inner, current === 'custom');
      return wrap;
    }

    if (item.kind === 'multi') return renderMultiSelect(item);

    if (item.kind === 'tri') {
      wrap.append(el('label', { text: item.label }));
      const select = el('select', { onchange: (e) => setFilter(item.key, e.target.value) });
      const opts = [
        { value: '', label: 'Any' },
        { value: 'true', label: item.yes || 'Yes' },
        { value: 'false', label: item.no || 'No' },
      ];
      if (item.nullable) opts.push({ value: 'null', label: item.nullLabel || 'Unknown' });
      const current = String(state.filters[item.key] === undefined ? '' : state.filters[item.key]);
      for (const o of opts) {
        select.append(el('option', { value: o.value, text: o.label, selected: current === o.value ? 'selected' : null }));
      }
      wrap.append(select);
      return wrap;
    }

    if (item.kind === 'number') {
      wrap.append(el('label', { text: item.label }));
      wrap.append(
        el('input', {
          type: 'number',
          value: state.filters[item.key] || '',
          placeholder: item.placeholder || '',
          min: item.min === undefined ? null : item.min,
          step: item.step || 1,
          style: 'width:110px',
          onchange: (e) => setFilter(item.key, e.target.value),
        })
      );
      return wrap;
    }

    if (item.kind === 'text') {
      wrap.append(el('label', { text: item.label }));
      const input = el('input', {
        type: 'search',
        value: state.filters[item.key] || '',
        placeholder: item.placeholder || 'Search...',
        style: 'width:' + (item.width || 200) + 'px',
      });
      let timer = null;
      input.addEventListener('input', (e) => {
        clearTimeout(timer);
        const value = e.target.value;
        timer = setTimeout(() => setFilter(item.key, value), 380);
      });
      wrap.append(input);
      return wrap;
    }

    if (item.kind === 'select') {
      wrap.append(el('label', { text: item.label }));
      const select = el('select', { onchange: (e) => setFilter(item.key, e.target.value) });
      const current = String(state.filters[item.key] === undefined ? item.default || '' : state.filters[item.key]);
      for (const o of item.options) {
        select.append(
          el('option', { value: String(o.value), text: o.label, selected: current === String(o.value) ? 'selected' : null })
        );
      }
      wrap.append(select);
      return wrap;
    }
    return wrap;
  }

  /**
   * Multi-select dropdown: a trigger that summarises the selection, and a
   * popover with search, checkboxes and per-option counts. Changes are
   * debounced, so ticking three boxes costs one request and the panel stays
   * open while picking.
   */
  function renderMultiSelect(item) {
    const wrap = el('div', { class: 'dd' });
    wrap.append(el('label', { text: item.label }));

    let selected = [].concat(state.filters[item.key] || []).map(String);
    const options = item.options || [];

    const text = el('span', { class: 'dd-text' });
    const badge = el('span', { class: 'dd-badge', style: 'display:none' });
    const trigger = el('button', { class: 'dd-trigger', type: 'button' }, [
      text,
      badge,
      el('span', { class: 'dd-caret', text: '▼' }),
    ]);

    const list = el('div', { class: 'dd-list' });
    const search = el('input', {
      type: 'search',
      placeholder: 'Filter ' + item.label.toLowerCase() + '\u2026',
      style: options.length > 7 ? '' : 'display:none',
    });
    const panel = el('div', { class: 'dd-panel' }, [search, list]);

    const summarise = () => {
      const hits = options.filter((o) => selected.includes(String(o.value)));
      if (!selected.length) {
        text.className = 'dd-text placeholder';
        // The field label sits directly above, so "Any" reads better than a
        // pluralised echo of it - and it matches the tri-state selects.
        text.textContent = item.allLabel || 'Any';
        badge.style.display = 'none';
        trigger.classList.remove('has-value');
      } else {
        text.className = 'dd-text';
        text.textContent = hits.length ? hits.map((o) => o.label).join(', ') : selected.join(', ');
        badge.textContent = String(selected.length);
        badge.style.display = selected.length > 1 ? '' : 'none';
        trigger.classList.add('has-value');
      }
      trigger.title = selected.length
        ? item.label + ': ' + text.textContent
        : 'Showing every ' + item.label.toLowerCase();
    };

    let timer = null;
    const commit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setFilter(item.key, selected.slice()), 350);
    };

    const paint = () => {
      const needle = search.value.trim().toLowerCase();
      const shown = options.filter((o) => !needle || String(o.label).toLowerCase().includes(needle));
      list.innerHTML = '';
      if (!options.length) {
        list.append(el('div', { class: 'dd-empty', text: 'No values in this dataset yet.' }));
      } else if (!shown.length) {
        list.append(el('div', { class: 'dd-empty', text: 'Nothing matches that search.' }));
      }
      for (const opt of shown) {
        const value = String(opt.value);
        const isOn = selected.includes(value);
        const box = el('input', { type: 'checkbox', checked: isOn ? 'checked' : null });
        const row = el('label', { class: 'dd-opt' + (isOn ? ' is-selected' : '') }, [
          box,
          el('span', { class: 'dd-opt-label', text: opt.label, title: opt.label }),
          opt.count === undefined || opt.count === null
            ? null
            : el('span', { class: 'dd-opt-count', text: fmt.int(opt.count) }),
        ]);
        box.addEventListener('change', () => {
          selected = box.checked ? selected.concat(value) : selected.filter((v) => v !== value);
          row.classList.toggle('is-selected', box.checked);
          summarise();
          commit();
        });
        list.append(row);
      }
    };

    search.addEventListener('input', paint);

    const footer = el('div', { class: 'dd-foot' }, [
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: 'Select all',
        onclick: () => {
          const needle = search.value.trim().toLowerCase();
          const visible = options.filter((o) => !needle || String(o.label).toLowerCase().includes(needle));
          selected = [...new Set(selected.concat(visible.map((o) => String(o.value))))];
          paint();
          summarise();
          commit();
        },
      }),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: 'Clear',
        onclick: () => {
          selected = [];
          paint();
          summarise();
          commit();
        },
      }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: 'Done', onclick: () => close() }),
    ]);
    panel.append(footer);

    function open() {
      closeAllDropdowns();
      panel.classList.add('open');
      paint();
      // Keep the panel inside the viewport when the control sits on the right.
      const box = panel.getBoundingClientRect();
      panel.classList.toggle('flip-right', box.right > window.innerWidth - 8);
      if (search.style.display !== 'none') search.focus();
    }

    function close() {
      panel.classList.remove('open');
      search.value = '';
    }

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      if (panel.classList.contains('open')) close();
      else open();
    });
    panel.addEventListener('click', (event) => event.stopPropagation());

    wrap.append(trigger, panel);
    summarise();
    return wrap;
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.dd-panel.open').forEach((p) => p.classList.remove('open'));
  }

  function renderCustomRange(host, show) {
    host.querySelectorAll('.custom-range').forEach((n) => n.remove());
    if (!show) return;
    const toLocal = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return (
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      );
    };
    const from = el('input', {
      type: 'datetime-local',
      class: 'custom-range',
      value: toLocal(state.filters.from),
      onchange: (e) => setFilter('from', e.target.value ? new Date(e.target.value).toISOString() : ''),
    });
    const to = el('input', {
      type: 'datetime-local',
      class: 'custom-range',
      value: toLocal(state.filters.to),
      onchange: (e) => setFilter('to', e.target.value ? new Date(e.target.value).toISOString() : ''),
    });
    host.append(from, to);
  }

  const CHIP_LABELS = {
    userId: 'User',
    tenantId: 'Tenant',
    deviceType: 'Device',
    appVersion: 'App',
    timezone: 'TZ',
    jobSiteId: 'Site',
    clockedIn: 'Clocked in',
    insideGeofence: 'Inside fence',
    connected: 'Connected',
    reachable: 'Reachable',
    loggedIn: 'Logged in',
    accuracyMin: 'Accuracy >=',
    accuracyMax: 'Accuracy <=',
    accuracyBand: 'Accuracy band',
    batteryMin: 'Battery >=',
    batteryMax: 'Battery <=',
    hasLocation: 'Has location',
    permissionMissing: 'Missing permission',
    permissionGranted: 'Has permission',
    search: 'Search',
    where: 'Where',
    status: 'Status',
    resolution: 'Resolution',
    openedBy: 'Opened by',
    withinRadius: 'Within radius',
    actualWithinRadius: 'Actually within',
    mismatch: 'Grace mismatch',
    unmapped: 'Unmapped',
    triggeredClockOut: 'Auto clock-out',
    outsideCountMin: 'Outside streak >=',
    verdict: 'Verdict',
    staleMinutes: 'Stale >= min',
    activeMinutes: 'Active <= min',
    minSamples: 'Samples >=',
    minDistance: 'Distance >=',
    minDurationMinutes: 'Duration >= min',
    hasUnknown: 'Has uncertain',
    from: 'From',
    to: 'To',
  };

  function renderChips() {
    const host = document.querySelector('#filter-chips');
    if (!host) return;
    host.innerHTML = '';
    const hidden = ['range', 'page', 'sortBy', 'sortDir'].concat(state.hideChips || []);
    const entries = Object.entries(state.filters).filter(([k]) => !hidden.includes(k));
    if (!entries.length) {
      host.append(el('span', { class: 'hint', text: 'No filters applied - showing the selected time range.' }));
      return;
    }
    for (const [key, value] of entries) {
      const label = CHIP_LABELS[key] || key;
      let shown = [].concat(value).join(', ');
      if (key === 'where') shown = shown.length > 46 ? shown.slice(0, 46) + '...' : shown;
      if (key === 'from' || key === 'to') shown = fmt.dayTime(shown);
      const chip = el('span', { class: 'chip' }, [
        el('span', { text: label + ': ' + shown }),
        el('button', {
          text: '×',
          title: 'Remove',
          onclick: () => {
            setFilter(key, '');
            rebuildFilterBar();
          },
        }),
      ]);
      host.append(chip);
    }
  }

  /**
   * Redraws the bar without losing the dropdown contents.
   *
   * Everything internal used to call buildFilterBar(state.filterSpec), which
   * re-used the ALREADY-BUILT spec - fine when metadata arrived before the page
   * was drawn, and wrong now that it can arrive after: the options would be
   * frozen empty forever.
   */
  function rebuildFilterBar() {
    buildFilterBar(state.filterBuilder || state.filterSpec);
  }

  function resetFilters() {
    state.filters = { range: state.filters.range || DEFAULT_RANGE };
    writeUrlState(true);
    rebuildFilterBar();
    emit('pm:filters');
  }

  function copyLink() {
    navigator.clipboard
      .writeText(location.href)
      .then(() => toast('Link with these filters copied', 'ok'))
      .catch(() => toast('Could not copy link', 'error'));
  }

  // ----------------------------------------------------------- saved views
  const viewKey = () => 'pm.views.' + (state.page ? state.page.file : 'x');
  function readViews() {
    try {
      return JSON.parse(localStorage.getItem(viewKey()) || '{}');
    } catch (err) {
      return {};
    }
  }
  function refreshViewList() {
    const select = document.querySelector('#saved-views');
    if (!select) return;
    const views = readViews();
    select.innerHTML = '';
    const names = Object.keys(views);
    if (!names.length) select.append(el('option', { value: '', text: 'no saved views' }));
    for (const name of names) select.append(el('option', { value: name, text: name }));
  }
  function saveView() {
    const name = prompt('Name this view');
    if (!name) return;
    const views = readViews();
    views[name] = { ...state.filters };
    localStorage.setItem(viewKey(), JSON.stringify(views));
    refreshViewList();
    toast('Saved view "' + name + '"', 'ok');
  }
  function loadView(name) {
    const views = readViews();
    if (!name || !views[name]) return;
    state.filters = { ...views[name] };
    writeUrlState(true);
    rebuildFilterBar();
    emit('pm:filters');
  }
  function deleteView(name) {
    const views = readViews();
    if (!name || !views[name]) return;
    delete views[name];
    localStorage.setItem(viewKey(), JSON.stringify(views));
    refreshViewList();
  }

  // -------------------------------------------------------------- page tabs
  /**
   * In-page tabs inside one card.
   *   tabs: [{ id, label, count?, padded?, render(host), onShow?(host) }]
   * Panels are rendered lazily and re-rendered when invalidated, because a
   * chart or map sized inside a hidden panel comes out 0x0. The active tab is
   * kept in the URL hash so a tab can be linked and survives a reload.
   */
  function pageTabs(host, tabs, options) {
    const opts = options || {};
    const nav = el('div', { class: 'page-tabs', role: 'tablist' });
    const body = el('div', { class: 'page-tab-body' });
    const entries = [];
    let active = null;

    for (const tab of tabs) {
      const button = el('button', { type: 'button', role: 'tab', title: tab.title || tab.label }, [
        el('span', { text: tab.label }),
        tab.count === undefined || tab.count === null ? null : el('span', { class: 'tab-count', text: fmt.int(tab.count) }),
      ]);
      const panel = el('div', { class: 'page-tab-panel' + (tab.padded === false ? '' : ' padded'), id: 'tab-' + tab.id });
      button.addEventListener('click', () => show(tab.id));
      nav.append(button);
      body.append(panel);
      entries.push({ tab, button, panel, rendered: false, stale: false });
    }

    function show(id, quiet) {
      const hit = entries.find((e) => e.tab.id === id) || entries[0];
      if (!hit) return;
      active = hit.tab.id;
      for (const entry of entries) {
        const on = entry === hit;
        entry.button.classList.toggle('active', on);
        entry.panel.classList.toggle('active', on);
      }
      if (!hit.rendered || hit.stale) {
        hit.panel.innerHTML = '';
        try {
          hit.tab.render(hit.panel);
        } catch (err) {
          hit.panel.append(el('div', { class: 'empty', text: 'Could not render: ' + err.message }));
        }
        hit.rendered = true;
        hit.stale = false;
      } else if (hit.tab.onShow) {
        hit.tab.onShow(hit.panel);
      }
      if (opts.syncHash !== false && !quiet) {
        // replaceState, not a hash assignment: no scroll jump, no history spam.
        history.replaceState(null, '', location.pathname + location.search + '#' + hit.tab.id);
      }
    }

    /** Data changed: re-render the visible tab now, the rest when opened. */
    function invalidate() {
      for (const entry of entries) entry.stale = true;
      const current = active;
      const hit = entries.find((e) => e.tab.id === current);
      if (hit) {
        hit.rendered = false;
        show(current, true);
      }
    }

    function setCount(id, count) {
      const hit = entries.find((e) => e.tab.id === id);
      if (!hit) return;
      let badge = hit.button.querySelector('.tab-count');
      if (count === null || count === undefined) {
        if (badge) badge.remove();
        return;
      }
      if (!badge) {
        badge = el('span', { class: 'tab-count' });
        hit.button.append(badge);
      }
      badge.textContent = fmt.int(count);
    }

    host.append(nav, body);
    const fromHash = (location.hash || '').replace('#', '');
    const initial = entries.some((e) => e.tab.id === fromHash) ? fromHash : entries[0].tab.id;
    if (opts.defer) {
      // The caller has no data yet: show the strip and a placeholder, and let
      // the first invalidate() do the rendering once data has arrived.
      active = initial;
      for (const entry of entries) {
        const on = entry.tab.id === initial;
        entry.button.classList.toggle('active', on);
        entry.panel.classList.toggle('active', on);
        // A shaped placeholder, not the word "loading" in an empty-state box -
        // this panel is about to hold a table or a map, so it should look like one.
        if (on) entry.panel.innerHTML = skeletonMarkup(opts.skeleton || 'table:8x6');
      }
    } else {
      show(initial, true);
    }

    window.addEventListener('hashchange', () => {
      const id = (location.hash || '').replace('#', '');
      if (id && id !== active && entries.some((e) => e.tab.id === id)) show(id, true);
    });

    return { show, invalidate, setCount, activeId: () => active };
  }

  // ---------------------------------------------------------------- drawer
  function drawer() {
    let scrim = document.querySelector('.drawer-scrim');
    let panel = document.querySelector('.drawer');
    if (!scrim) {
      scrim = el('div', { class: 'drawer-scrim', onclick: () => closeDrawer() });
      panel = el('div', { class: 'drawer' }, [
        el('div', { class: 'drawer-head' }, [
          el('div', { style: 'min-width:0;flex:1' }, [
            el('h2', { id: 'drawer-title', text: '' }),
            el('div', { class: 'sub', id: 'drawer-sub', text: '' }),
          ]),
          el('button', { class: 'btn btn-sm', text: 'Close ✕', onclick: () => closeDrawer() }),
        ]),
        el('div', { class: 'tabs', id: 'drawer-tabs' }),
        el('div', { class: 'drawer-body', id: 'drawer-body' }),
      ]);
      document.body.append(scrim, panel);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeDrawer();
      });
    }
    return { scrim, panel };
  }

  /** tabs: [{ id, label, render(host) }] */
  function openDrawer({ title, subtitle, tabs }) {
    const { scrim, panel } = drawer();
    document.querySelector('#drawer-title').textContent = title || '';
    document.querySelector('#drawer-sub').textContent = subtitle || '';
    const tabHost = document.querySelector('#drawer-tabs');
    const body = document.querySelector('#drawer-body');
    tabHost.innerHTML = '';
    body.innerHTML = '';

    const panels = [];
    (tabs || []).forEach((tab, index) => {
      const button = el('button', { text: tab.label, class: index === 0 ? 'active' : '' });
      const wrap = el('div', { class: 'tab-panel' + (index === 0 ? ' active' : ''), id: 'panel-' + tab.id });
      button.addEventListener('click', () => {
        tabHost.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        body.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        button.classList.add('active');
        wrap.classList.add('active');
        emit('pm:drawer-tab', { id: tab.id, host: wrap });
      });
      tabHost.append(button);
      body.append(wrap);
      panels.push({ tab, wrap });
    });

    scrim.classList.add('open');
    panel.classList.add('open');
    // Render after the panel is visible so charts and maps size correctly.
    requestAnimationFrame(() => {
      for (const p of panels) {
        try {
          p.tab.render(p.wrap);
        } catch (err) {
          p.wrap.append(el('div', { class: 'empty', text: 'Could not render: ' + err.message }));
        }
      }
    });
  }

  function closeDrawer() {
    const scrim = document.querySelector('.drawer-scrim');
    const panel = document.querySelector('.drawer');
    if (scrim) scrim.classList.remove('open');
    if (panel) panel.classList.remove('open');
    emit('pm:drawer-close');
  }

  function kv(pairs) {
    const list = el('dl', { class: 'kv' });
    // Callers include conditional rows as `undefined`, so skip holes first.
    for (const pair of (pairs || []).filter(Boolean)) {
      const [key, value] = pair;
      if (value === undefined) continue;
      list.append(el('dt', { text: key }));
      const dd = el('dd');
      if (value && value.nodeType) dd.append(value);
      else dd.innerHTML = value === null || value === '' ? '--' : String(value);
      list.append(dd);
    }
    return list;
  }

  // ---------------------------------------------------------------- shell
  /**
   * The app frame. Everything here is known before any request runs - brand,
   * nav, page title, theme switch, the hosts the page fills - so it goes up
   * immediately and renderShellMeta() fills in the two parts that need
   * /api/meta, which is the slowest request on the page.
   */
  function renderShell() {
    const page = state.page;
    const shell = el('div', { class: 'shell' });

    const sidebar = el('div', { class: 'sidebar' });
    sidebar.append(
      el('div', { class: 'brand' }, [
        el('div', { class: 'brand-mark', text: 'P' }),
        el('div', {}, [
          el('div', { class: 'brand-name', text: 'Phantom Monitor' }),
          el('div', { class: 'brand-sub', text: 'field device & geofence ops' }),
        ]),
      ])
    );

    const nav = el('div', { class: 'nav' });
    let lastGroup = null;
    for (const p of PAGES) {
      if (p.group !== lastGroup) {
        nav.append(el('div', { class: 'nav-label', text: p.group }));
        lastGroup = p.group;
      }
      // The count is the only part of a nav row that needs /api/meta, so the row
      // goes up now and the number lands later.
      nav.append(
        el('a', { href: '/' + p.file, class: state.activeFile === p.file ? 'active' : '' }, [
          el('span', { class: 'ico', text: p.icon }),
          el('span', { text: p.title }),
          p.countKey ? el('span', { class: 'count', 'data-count-key': p.countKey }) : null,
        ])
      );
    }
    sidebar.append(nav);
    sidebar.append(el('div', { class: 'sidebar-foot', id: 'sidebar-foot' }, [el('div', { class: 'sk sk-line sk-w80' })]));

    const main = el('div', { class: 'main' });
    const topbar = el('div', { class: 'topbar' }, [
      el('div', {}, [
        el('h1', { id: 'page-title', text: page ? page.title : 'Phantom Monitor' }),
        el('div', { class: 'sub', id: 'page-sub', text: '' }),
      ]),
      el('div', { class: 'spacer' }),
      el('div', { class: 'theme-switch', id: 'theme-switch' }),
      el('div', { class: 'live', id: 'live-indicator' }, [
        el('span', { class: 'led' }),
        el('span', { id: 'live-text', text: 'loading...' }),
      ]),
      el('div', { class: 'field field-inline' }, [
        el(
          'select',
          {
            id: 'refresh-select',
            title: 'Auto-refresh',
            onchange: (e) => setRefresh(Number(e.target.value)),
          },
          [
            el('option', { value: '0', text: 'Manual' }),
            el('option', { value: '10000', text: 'Every 10s' }),
            el('option', { value: '30000', text: 'Every 30s' }),
            el('option', { value: '60000', text: 'Every 60s' }),
          ]
        ),
        el('button', { class: 'btn btn-sm btn-primary', text: '⟳ Refresh', onclick: () => emit('pm:refresh') }),
      ]),
    ]);

    const content = el('div', { class: 'content' }, [
      el('div', { class: 'filters', id: 'filters', style: 'display:none' }),
      // Above the content on purpose: if the figures below are stale, that
      // has to be read before them, not after.
      el('div', { id: 'stale-banner', style: 'display:none' }),
      el('div', { id: 'page-root' }),
    ]);

    main.append(topbar, content);
    shell.append(sidebar, main);
    document.body.append(el('div', { class: 'loading-bar' }), shell);

    const select = document.querySelector('#refresh-select');
    if (select) select.value = String(state.refreshMs);
    renderThemeSwitch();
  }

  /**
   * The two parts of the shell that need /api/meta: the collection counts in the
   * nav, and the database chip in the sidebar foot. Called when that request
   * answers, which is well after the frame is on screen.
   */
  function renderShellMeta() {
    const meta = state.meta || {};
    const cols = meta.collections || {};
    const counts = cols.counts || {};
    for (const node of document.querySelectorAll('.nav .count[data-count-key]')) {
      const value = counts[node.getAttribute('data-count-key')];
      node.textContent = value ? fmt.int(value) : '';
    }

    const foot = document.querySelector('#sidebar-foot');
    if (!foot) return;
    foot.innerHTML = '';
    foot.append(
      el('div', { class: 'db-chip' }, [
        el('div', {}, [el('b', { text: 'DB ' }), document.createTextNode(meta.database || '--')]),
        // Document kinds share a collection here, so label by kind and put the
        // collection name in the tooltip rather than printing it twice.
        dbLine('snapshots', cols.snapshots, counts.snapshots, cols),
        dbLine('clock-in logs', cols.clockInLogs, counts.clockInLogs, cols),
        dbLine('exit windows', cols.exitWindows, counts.exitWindows, cols),
      ]),
      // No sign-out button: HTTP Basic gives the browser no way to forget the
      // credentials, so a button that claimed to log you out would be lying.
      state.authRequired
        ? el('div', {
            class: 'hint',
            text: (state.username ? 'Signed in as ' + state.username : 'Password protected') + ' - close the browser to sign out',
          })
        : el('div', { class: 'hint', text: 'Open access - no password configured' })
    );
  }

  /** One "kind: count" line, flagged when the collection is shared. */
  function dbLine(label, collection, count, cols) {
    if (!collection) return el('div', { text: label + ': none yet' });
    const shared =
      [cols.snapshots, cols.clockInLogs, cols.exitWindows].filter((name) => name === collection).length > 1;
    return el('div', {
      title: collection + (shared ? ' (holds more than one document kind)' : ''),
      text: label + ': ' + fmt.int(count) + (shared ? ' · shared' : ''),
    });
  }

  function setRefresh(ms) {
    state.refreshMs = ms;
    localStorage.setItem('pm.refresh', String(ms));
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    if (ms > 0) state.refreshTimer = setInterval(() => emit('pm:refresh'), ms);
    updateLive();
  }

  /**
   * Says outright that what is on screen is older than it looks.
   *
   * A refresh that fails used to leave every panel exactly as it was, with the
   * only signal a toast that disappeared after seven seconds. Anyone arriving a
   * moment later read stale figures as current, which is worse than an error:
   * the page was confidently wrong. On a first load it left every panel
   * shimmering as a skeleton for good.
   */
  function markStale(message) {
    state.staleSince = state.lastLoadedAt || null;
    // Nothing should still be pretending to load once the load has failed.
    clearSkeletonOverlays();
    const host = document.querySelector('#stale-banner');
    if (!host) return;
    host.innerHTML = '';
    const had = !!state.lastLoadedAt;
    host.append(
      el('div', { class: 'banner is-stale' }, [
        el('span', { class: 'banner-icon', text: '!' }),
        el('div', { class: 'banner-text' }, [
          el('b', {
            text: had
              ? 'These figures are from ' + fmt.time(state.lastLoadedAt) + ' and did not refresh.'
              : 'This page could not load.',
          }),
          el('span', { text: ' ' + (message || 'The last request failed.') }),
        ]),
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-sm',
          text: 'Retry',
          onclick: () => {
            clearStale();
            emit('pm:refresh');
          },
        }),
      ])
    );
    host.style.display = '';
    updateLive(had ? 'stale - refresh failed' : 'load failed');
  }

  function clearStale() {
    state.staleSince = null;
    const host = document.querySelector('#stale-banner');
    if (!host) return;
    host.innerHTML = '';
    host.style.display = 'none';
  }

  function updateLive(text) {
    const node = document.querySelector('#live-text');
    const wrap = document.querySelector('#live-indicator');
    if (!node) return;
    if (text) {
      node.textContent = text;
    } else if (state.lastLoadedAt) {
      node.textContent =
        'updated ' + fmt.time(state.lastLoadedAt) + (state.refreshMs ? ' · auto ' + state.refreshMs / 1000 + 's' : '');
    }
    if (wrap) wrap.classList.toggle('paused', !state.refreshMs);
  }

  function markLoaded() {
    clearSkeletonOverlays();
    state.lastLoadedAt = new Date().toISOString();
    clearStale();
    updateLive();
  }

  function setTitle(text) {
    const node = document.querySelector('#page-title');
    if (node) node.textContent = text;
    document.title = text + ' · Phantom Monitor';
  }

  function setSubtitle(text) {
    const node = document.querySelector('#page-sub');
    if (node) node.textContent = text;
  }

  // A page's reload handlers are async, so a rejected fetch (a bad where
  // clause, say) would otherwise vanish into an unhandled rejection.
  function installDropdownDismiss() {
    if (window.__pmDismiss) return;
    window.__pmDismiss = true;
    document.addEventListener('click', closeAllDropdowns);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllDropdowns();
    });
  }

  function installErrorTrap() {
    if (window.__pmTrap) return;
    window.__pmTrap = true;
    window.addEventListener('unhandledrejection', (event) => {
      const message = (event.reason && event.reason.message) || String(event.reason || 'Request failed');
      if (message === 'Session expired') return; // already redirecting
      console.error('[phantom-monitor]', event.reason);
      // A page load is what usually fails here, so the failure has to persist
      // on screen rather than fade with a toast.
      markStale(message);
      event.preventDefault();
    });
  }

  // ------------------------------------------------------------------ boot
  /**
   * options.activeFile - which nav entry to highlight for a detail page
   * options.title     - heading text when the page is not in PAGES
   */
  async function boot(pageFile, init, options) {
    const opts = options || {};
    installErrorTrap();
    installDropdownDismiss();
    // The inline script in each page already set data-theme before first paint;
    // this syncs the in-memory state and reads the palette out of the CSS.
    state.theme = storedTheme();
    applyTheme(state.theme, { repaint: false });
    const known = PAGES.find((p) => p.file === pageFile);
    state.page = known || { file: pageFile, title: opts.title || document.title };
    state.activeFile = opts.activeFile || pageFile;
    state.filters = readUrlState();
    if (!state.filters.range && !state.filters.from) state.filters.range = DEFAULT_RANGE;

    // Frame first, then the requests. Waiting for /api/meta before drawing
    // anything left the window blank for as long as that query took.
    renderShell();
    showSkeleton({ '#page-root': 'boot' });

    try {
      const me = await api('/api/auth/me');
      state.authRequired = me.authRequired !== false;
      state.username = me.username || null;
      // Nothing to redirect to: the browser asks for the password itself before
      // this script ever runs, so reaching here means we are already through.
    } catch (err) {
      return;
    }

    // /api/meta probes every collection in the database and then runs a
    // seven-way facet over all of it - about six seconds on a cold instance.
    // Nothing on any page needs it in order to ask for its own data: it fills
    // the filter dropdowns and the shell counters. Awaiting it here left the
    // window empty for those six seconds, which was the slowest thing about
    // using this console.
    //
    // state.meta keeps ONE identity for the life of the page and is filled in
    // place, because every page destructures it out of the init argument and
    // would otherwise hold a reference to the empty original.
    state.meta = {};
    const metaLoaded = api('/api/meta').then(
      (m) => m,
      (err) => ({ error: err.message })
    );
    metaLoaded.then((m) => {
      Object.assign(state.meta, m);
      renderShellMeta();
      // Now the dropdowns have something to list.
      rebuildFilterBar();
      emit('pm:meta');
      if (m && m.error) toast('Metadata failed: ' + m.error, 'error');
    });

    renderShellMeta();
    setRefresh(state.refreshMs);

    window.addEventListener('popstate', () => {
      state.filters = readUrlState();
      rebuildFilterBar();
      emit('pm:filters');
    });

    try {
      const root = document.querySelector('#page-root');
      // The page appends its own containers, so the boot placeholder goes first.
      root.innerHTML = '';
      await init({ root, meta: state.meta });
    } catch (err) {
      console.error(err);
      toast(err.message, 'error');
    }
  }

  /**
   * Fills the holes in a bucketed time series.
   *
   * The charts use a category axis (no date adapter is vendored), so a bucket
   * the aggregation never emitted would be dropped entirely and the axis would
   * silently compress quiet periods. Counts fill with 0; averages fill with
   * null so lines break instead of diving to zero.
   */
  function padBuckets(rows, unit, options) {
    const list = rows || [];
    if (list.length < 2) return list;
    const step = unit === 'day' ? 86400000 : unit === 'minute15' ? 900000 : 3600000;
    const zeroKeys = (options && options.zero) || [];
    const nullKeys = (options && options.nulls) || [];

    const byTime = new Map();
    for (const row of list) {
      const t = new Date(row.at).getTime();
      if (Number.isFinite(t)) byTime.set(t, row);
    }
    const stamps = [...byTime.keys()].sort((a, b) => a - b);
    if (!stamps.length) return list;

    const start = stamps[0];
    const end = stamps[stamps.length - 1];
    const expected = Math.round((end - start) / step) + 1;
    // Nothing to do, or the range is so long that padding would swamp the axis.
    if (expected <= list.length || expected > 1500) return list;

    const out = [];
    for (let t = start; t <= end; t += step) {
      const hit = byTime.get(t);
      if (hit) {
        out.push(hit);
        continue;
      }
      const filler = { at: new Date(t).toISOString(), filled: true };
      for (const key of zeroKeys) filler[key] = 0;
      for (const key of nullKeys) filler[key] = null;
      out.push(filler);
    }
    return out;
  }

  // ----------------------------------------------------------- skeletons
  const rep = (html, n) => new Array(Math.max(0, n)).fill(html).join('');

  /**
   * Markup for one placeholder shape. Kinds take an argument after a colon:
   *   tiles:8   table:10x7   text:3   list:5   kv:6   block
   * The shapes deliberately match the real thing’s geometry, so the layout
   * does not jump when the data lands.
   */
  function skeletonMarkup(kind) {
    const [name, arg] = String(kind || 'block').split(':');
    if (name === 'tiles') {
      return '<div class="sk-tiles">' + rep('<div class="sk sk-tile"></div>', Number(arg) || 4) + '</div>';
    }
    if (name === 'table') {
      const [rows, cols] = (arg || '8x6').split('x').map(Number);
      const cells = rep('<div class="sk sk-line"></div>', cols || 6);
      return (
        '<div class="sk-table">' +
        '<div class="sk-tr sk-head">' + cells + '</div>' +
        rep('<div class="sk-tr">' + cells + '</div>', rows || 8) +
        '</div>'
      );
    }
    if (name === 'list') {
      return rep(
        '<div class="sk-tr"><div class="sk sk-dot"></div><div style="flex:1">' +
          '<div class="sk sk-line sk-w60"></div><div class="sk sk-line sk-w40"></div></div></div>',
        Number(arg) || 5
      );
    }
    if (name === 'kv') {
      return rep(
        '<div class="sk-tr"><div class="sk sk-line sk-w25"></div><div class="sk sk-line"></div></div>',
        Number(arg) || 6
      );
    }
    if (name === 'text') {
      return rep('<div class="sk sk-line"></div>', Number(arg) || 3);
    }
    if (name === 'boot') {
      // Stands in for a whole page while the first requests are in flight: the
      // filter bar, a KPI row and one panel, which is what most pages open with.
      return (
        '<div class="card" style="padding:14px">' + skeletonMarkup('text:2') + '</div>' +
        skeletonMarkup('tiles:4') +
        '<div class="card">' + skeletonMarkup('table:7x6') + '</div>'
      );
    }
    return '<div class="sk sk-block"></div>';
  }

  /**
   * Put placeholders in the containers a load is about to fill.
   *
   * Containers that already hold real content are left alone: a refresh keeps
   * the numbers on screen (the progress bar says something is happening)
   * rather than blinking everything back to grey. Charts and maps keep their
   * canvas and get an overlay instead, since replacing it would break them.
   */
  function showSkeleton(spec, options) {
    const opts = options || {};
    for (const [selector, kind] of Object.entries(spec || {})) {
      const host = document.querySelector(selector);
      if (!host) continue;
      if (kind === 'chart' || kind === 'map') {
        const target = host.tagName === 'CANVAS' ? host.closest('.chart-wrap') || host.parentElement : host;
        if (target) target.classList.add('is-loading');
        continue;
      }
      const hasRealContent = host.children.length > 0 && !host.querySelector('.sk');
      if (hasRealContent && !opts.force) continue;
      host.innerHTML = skeletonMarkup(kind);
    }
  }

  /** Drops every chart/map loading overlay on the page. */
  function clearSkeletonOverlays() {
    for (const node of document.querySelectorAll('.is-loading')) node.classList.remove('is-loading');
  }

  // --------------------------------------------------------- row navigation
  /**
   * Follow a row to its own page. Same tab, because that is what a click on a
   * row means; the modifier keys and the middle button keep their usual
   * meaning, so anyone who wants a second tab still gets one.
   */
  function openRow(href, event) {
    const newTab = event && (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1);
    if (newTab) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    location.href = href;
  }

  /**
   * The active time range, in words - "the last 3 hours", "all time".
   * A panel showing nothing has to be able to say which window it looked in,
   * or an empty panel reads as "this person has none" when it means "none
   * here, in these three hours".
   */
  function rangeLabel() {
    const key = state.filters.range || (state.filters.from ? 'custom' : DEFAULT_RANGE);
    if (key === 'all') return 'all time';
    if (key === 'custom') {
      const from = state.filters.from ? fmt.dayTime(state.filters.from) : null;
      const to = state.filters.to ? fmt.dayTime(state.filters.to) : 'now';
      return from ? from + ' to ' + to : 'the selected range';
    }
    const hit = RANGE_PRESETS.find((p) => p.key === key);
    return hit ? 'the ' + hit.label.toLowerCase() : 'the selected range';
  }

  // ----------------------------------------------------- option list helpers
  function optionsFrom(list, valueKey, labelKey, countKey) {
    return (list || []).map((item) => ({
      value: item[valueKey] === null ? 'null' : item[valueKey],
      label: String(item[labelKey] === null || item[labelKey] === undefined ? item[valueKey] : item[labelKey]),
      count: countKey ? item[countKey] : undefined,
    }));
  }

  return {
    PAGES,
    openRow,
    state,
    el,
    esc,
    fmt,
    api,
    toast,
    boot,
    buildFilterBar,
    rebuildFilterBar,
    markStale,
    clearStale,
    setFilter,
    queryString,
    resetFilters,
    openDrawer,
    pageTabs,
    closeDrawer,
    kv,
    geofenceBadge,
    accuracyBadge,
    accuracyBandOf,
    batteryBadge,
    meter,
    jsonHighlight,
    optionsFrom,
    rangeLabel,
    padBuckets,
    showSkeleton,
    skeletonMarkup,
    clearSkeletonOverlays,
    markLoaded,
    setTitle,
    setSubtitle,
    updateLive,
    colors: readColors(),
    applyTheme,
    readColors,
    closeAllDropdowns,
  };
})();
