/* Raw Documents: what is actually in a collection, newest first.

   The Query Explorer answers "show me the documents matching this". This page
   answers "show me what just arrived", which needs no query written to ask it -
   pick a collection, read down. Each row is a table row with the columns you
   chose, and the document itself folded away underneath it, rendered as stored.

   Columns are computed HERE, from the documents already on the page. The server
   sends whole documents either way, so picking a different column costs no
   request - the paths offered in the picker are the paths actually present in
   what came back, which is also the only honest list to offer.

   Two things are deliberately not raw:

     - Redaction still applies. These documents embed the whole employee record,
       which in this store carries SSN, bank and routing numbers, home address
       and emergency contacts. A page whose job is to show documents verbatim is
       exactly the one that would put all of it on screen.
     - Kinds are not separated. Elsewhere the console isolates the kinds mixed
       into one collection so the counts stay honest; here that would hide the
       answer, because "what is in this collection" is the question. Every
       document is listed and each is labelled with the kind it looks like. */
(function () {
  'use strict';
  const { el, fmt, api, esc } = PM;

  let data = { rows: [], total: 0 };
  let collections = [];

  /**
   * What to show when nothing has been picked, by the kind that dominates the
   * page. A generic fallback would offer the same five columns for a heartbeat
   * and an exit window, and neither would be the five worth seeing.
   */
  const DEFAULT_COLUMNS = {
    heartbeat: ['currentUser.data.fullName', 'deviceType', 'batteryPercentage', 'currentUserLocation.accuracy', 'isInsideGeofence'],
    'exit window': ['userId', 'status', 'resolution', 'openedBy', 'fence.radius'],
    'shift trail': ['userId', 'runId', 'siteId', 'locationPermission', 'batteryPercentage'],
    'clock-in check': ['userId', 'siteAreaData.siteArea.id', 'response.isWithinRadius', 'response.actualIsWithinRadius'],
  };

  const MAX_COLUMNS = 8;
  const MAX_SUGGESTIONS = 120;

  /**
   * Envelopes the writers use interchangeably for the same fields.
   *
   * The Android client sends `currentUser` unwrapped on about a quarter of its
   * heartbeats, where iOS always wraps it in `data` - same fields, same
   * meaning, two paths, both being written today on the same build. A column
   * asking for one of them printed `--` next to a name that was plainly there
   * in the document below it, which is the one thing this page must not do.
   *
   * So a path resolves against both envelopes and the cell reports which one it
   * actually came from. This is a deliberate exception, not a general rule: it
   * is here because the store genuinely holds one field under two names, and
   * each pair has to be written down to be believed. Guessing at equivalence by
   * matching leaf names would be magic, and would eventually show a value from
   * somewhere the reader never asked about.
   */
  const EQUIVALENT_PREFIXES = [['currentUser.data.', 'currentUser.']];

  /** The paths that mean what this path means, this one first. */
  function equivalentPaths(path) {
    const out = [path];
    for (const [wrapped, bare] of EQUIVALENT_PREFIXES) {
      // The longer prefix is tested first: every wrapped path also starts with
      // the bare one, and reversing these two produces currentUser.data.data.
      if (path.startsWith(wrapped)) out.push(bare + path.slice(wrapped.length));
      else if (path.startsWith(bare)) out.push(wrapped + path.slice(bare.length));
    }
    return out;
  }

  /** The value for a column, and the path it actually came from. */
  function resolve(doc, path) {
    for (const candidate of equivalentPaths(path)) {
      const value = dig(doc, candidate);
      if (value !== undefined) return { path: candidate, value };
    }
    return { path, value: undefined };
  }

  PM.boot(
    'raw.html',
    async ({ root }) => {
      PM.buildFilterBar(() => [
        { kind: 'daterange' },
        {
          kind: 'select',
          key: 'collection',
          label: 'Collection',
          options: collections.map((c) => ({
            value: c.name,
            label: c.name + (c.count === null ? '' : ' · ' + fmt.int(c.count)),
          })),
        },
        {
          kind: 'select',
          key: 'limit',
          label: 'Per page',
          default: '25',
          options: [10, 25, 50, 100].map((n) => ({ value: n, label: String(n) })),
        },
      ]);

      root.append(
        el('div', { id: 'raw-banner' }),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { id: 'raw-title', text: 'Documents' }),
            el('span', { class: 'sub', id: 'raw-sub' }),
            el('div', { class: 'spacer' }),
            el('div', { id: 'raw-columns' }),
            el('button', { class: 'btn btn-sm', id: 'raw-expand', text: '⌄ Expand all', onclick: toggleAll }),
          ]),
          el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'raw-list' })]),
          el('div', { class: 'pager', id: 'pager' }),
        ])
      );

      await loadCollections();
      await load();
      window.addEventListener('pm:filters', load);
      window.addEventListener('pm:refresh', async () => {
        await loadCollections();
        await load();
      });
    },
    // `columns` is a view setting, not a filter on the data - it belongs in the
    // URL so a view can be shared, but not in the chip row beside the filters
    // that actually narrowed the result.
    { hideChips: ['columns'] }
  );

  // --------------------------------------------------------------- columns

  /** Dot path -> value, for the paths the picker offers. */
  function dig(obj, path) {
    return String(path)
      .split('.')
      .reduce((acc, part) => (acc === null || acc === undefined ? acc : acc[part]), obj);
  }

  /**
   * Every path in a document that leads to something printable.
   *
   * Arrays stop the walk: `samples.0.lat` is a path into one element of a list
   * whose length varies per document, so it would be a column that is populated
   * on some rows by accident. The array itself is offered instead, and renders
   * as its length.
   */
  function leafPaths(value, prefix, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (depth > 5 || out.length > 400) return out;
    if (value === null || typeof value !== 'object' || value instanceof Date) {
      if (prefix) out.push(prefix);
      return out;
    }
    if (Array.isArray(value)) {
      if (prefix) out.push(prefix);
      return out;
    }
    for (const [k, v] of Object.entries(value)) {
      if (k === '_id' && !prefix) continue; // always shown in its own column
      leafPaths(v, prefix ? prefix + '.' + k : k, out, depth + 1);
    }
    return out;
  }

  /** Paths present on this page, commonest first - the only honest list. */
  function suggestions() {
    const counts = new Map();
    for (const row of data.rows || []) {
      for (const path of leafPaths(row.doc)) counts.set(path, (counts.get(path) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_SUGGESTIONS)
      .map(([path, n]) => ({ path, n }));
  }

  /** The kind most of this page is, which is what the defaults key off. */
  function dominantKind() {
    const counts = {};
    for (const row of data.rows || []) counts[row.kind || '?'] = (counts[row.kind || '?'] || 0) + 1;
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
  }

  function defaultColumns() {
    const preset = DEFAULT_COLUMNS[dominantKind()];
    if (preset) {
      // Only the ones this page actually has, so a preset never prints a column
      // of dashes for a field this collection does not carry. A column counts
      // as present when EITHER envelope of it is - otherwise the whole page
      // would drop the name column just because the rows it sampled happen to
      // be the other shape.
      const present = new Set(suggestions().map((s) => s.path));
      const kept = preset.filter((p) => equivalentPaths(p).some((a) => present.has(a)));
      if (kept.length) return kept;
    }
    return suggestions()
      .slice(0, 4)
      .map((s) => s.path);
  }

  function activeColumns() {
    const raw = PM.state.filters.columns;
    if (raw === undefined) return defaultColumns();
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_COLUMNS);
  }

  function setColumns(paths) {
    const unique = [...new Set(paths)].slice(0, MAX_COLUMNS);
    // No refetch: the documents are already here and the columns are read off
    // them, so changing one is a redraw rather than a request.
    PM.setFilter('columns', unique.length ? unique.join(',') : '', { reload: false });
    renderColumnPicker();
    renderTable();
  }

  function renderColumnPicker() {
    const host = document.querySelector('#raw-columns');
    if (!host) return;
    host.innerHTML = '';

    const chosen = activeColumns();
    const all = suggestions();
    const usingDefaults = PM.state.filters.columns === undefined;

    const wrap = el('div', { class: 'dd' });
    const panel = el('div', { class: 'dd-panel' });
    const trigger = el('button', {
      class: 'btn btn-sm' + (usingDefaults ? '' : ' has-value'),
      text: '▦ Columns',
      onclick: (event) => {
        event.stopPropagation();
        const open = panel.classList.contains('open');
        PM.closeAllDropdowns();
        if (!open) panel.classList.add('open');
      },
    });
    if (chosen.length) trigger.append(el('span', { class: 'dd-badge', text: String(chosen.length) }));

    panel.addEventListener('click', (event) => event.stopPropagation());

    const search = el('input', { type: 'search', placeholder: 'Find a field…' });
    const list = el('div', { class: 'dd-list' });

    const draw = (needle) => {
      list.innerHTML = '';
      const term = (needle || '').toLowerCase();
      // Chosen paths first, so an added custom path is visible rather than
      // buried a hundred rows down a frequency-ordered list.
      const ordered = [
        ...chosen.filter((p) => !term || p.toLowerCase().includes(term)).map((p) => ({ path: p, n: null })),
        ...all.filter((s) => !chosen.includes(s.path)).filter((s) => !term || s.path.toLowerCase().includes(term)),
      ];
      if (!ordered.length) {
        list.append(el('div', { class: 'dd-opt', text: 'No field matches.' }));
        return;
      }
      for (const item of ordered) {
        const on = chosen.includes(item.path);
        const opt = el('label', { class: 'dd-opt' });
        const box = el('input', { type: 'checkbox', checked: on ? 'checked' : null });
        box.addEventListener('change', () => {
          setColumns(box.checked ? chosen.concat(item.path) : chosen.filter((p) => p !== item.path));
        });
        opt.append(
          box,
          el('span', { class: 'dd-opt-label', text: item.path, title: item.path }),
          el('span', { class: 'dd-opt-count', text: item.n === null ? '' : item.n + '/' + (data.rows || []).length })
        );
        list.append(opt);
      }
    };

    search.addEventListener('input', () => draw(search.value));

    // Any dot path, whether or not this page happens to carry it - a field that
    // only appears on older documents is still worth a column while you page
    // back to find one.
    const custom = el('input', { type: 'text', placeholder: 'or type a path: a.b.c', style: 'width:100%;margin-top:6px' });
    custom.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const path = custom.value.trim();
      if (!path) return;
      custom.value = '';
      setColumns(chosen.concat(path));
    });

    panel.append(
      search,
      list,
      custom,
      // One action, not two: clearing the list and resetting it are the same
      // thing here, because no columns at all falls straight back to the
      // defaults. Offering both would be two buttons that do one job.
      el('div', { class: 'dd-foot' }, [
        el('button', {
          class: 'btn btn-sm',
          text: 'Reset to defaults',
          disabled: usingDefaults ? 'disabled' : null,
          onclick: () => {
            PM.setFilter('columns', '', { reload: false });
            renderColumnPicker();
            renderTable();
          },
        }),
      ])
    );

    draw('');
    wrap.append(trigger, panel);
    host.append(wrap);
  }

  // ------------------------------------------------------------ rendering

  /** One cell, honest about what it is holding. */
  function cell(value) {
    if (value === undefined) return '<span class="hint" title="this document has no such field">--</span>';
    if (value === null) return '<span class="hint">null</span>';
    if (typeof value === 'boolean') {
      return '<span class="badge ' + (value ? 'badge-good' : 'badge-neutral') + '">' + value + '</span>';
    }
    if (Array.isArray(value)) {
      return '<span class="hint">' + value.length + ' item' + (value.length === 1 ? '' : 's') + '</span>';
    }
    if (typeof value === 'object') {
      const text = JSON.stringify(value);
      return '<span class="mono" title="' + esc(text) + '">' + esc(text.slice(0, 40)) + (text.length > 40 ? '…' : '') + '</span>';
    }
    const text = String(value);
    // An ISO-looking string is a date and reads better as one, but the original
    // stays in the title so nothing is lost to the formatting.
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(text)) {
      return '<span title="' + esc(text) + '">' + esc(fmt.dayTime(text)) + '</span>';
    }
    if (text.length > 44) return '<span title="' + esc(text) + '">' + esc(text.slice(0, 44)) + '…</span>';
    return esc(text);
  }

  async function loadCollections() {
    try {
      const res = await api('/api/raw/collections');
      collections = res.collections || [];
    } catch (err) {
      collections = [];
    }
    PM.rebuildFilterBar();
  }

  async function load() {
    PM.showSkeleton({ '#raw-list': 'table:8x6' });
    try {
      data = await api('/api/raw?' + PM.queryString());
    } catch (err) {
      document.querySelector('#raw-list').innerHTML = '';
      document.querySelector('#raw-list').append(el('div', { class: 'empty', text: err.message }));
      document.querySelector('#pager').innerHTML = '';
      PM.markLoaded();
      return;
    }
    renderBanner();
    renderColumnPicker();
    renderTable();
    renderPager();
    PM.setSubtitle(fmt.int(data.total) + ' documents in ' + (data.collection || '--'));
    PM.markLoaded();
  }

  function renderBanner() {
    const host = document.querySelector('#raw-banner');
    host.innerHTML = '';

    host.append(
      el('div', {
        class: 'notice',
        html:
          '<span>ℹ</span><span><b>Documents exactly as stored, newest first.</b> ' +
          'The columns are read off the documents on this page - pick any field, or type a path - and the ' +
          'row opens to the document itself. The kinds sharing a collection are <b>not</b> separated, since ' +
          'that is what this view is for, so each row says which kind it looks like. ' +
          '<b>Personal fields are still redacted</b>: <code>[redacted]</code> marks a value that was there, ' +
          'not one that was missing.</span>',
      })
    );

    if (data.sortNote) {
      host.append(
        el('div', {
          class: 'notice',
          html:
            '<span>⚠</span><span><b>Ordered by <code>_id</code>, not <code>createdAt</code>.</b> ' +
            esc(data.sortNote) + '. The date range on the filter bar does not apply here.</span>',
        })
      );
    }
  }

  function renderTable() {
    const host = document.querySelector('#raw-list');
    host.innerHTML = '';
    if (!(data.rows || []).length) {
      host.append(
        el('div', {
          class: 'empty',
          text: 'No documents in ' + (data.collection || 'this collection') + ', in ' + PM.rangeLabel() + '.',
        })
      );
      return;
    }

    const columns = activeColumns();
    const span = columns.length + 4;

    const node = el('table', { class: 'raw-table' });
    node.innerHTML =
      '<thead><tr><th class="raw-caret-col"></th><th>Stored</th><th>Kind</th>' +
      columns.map((c) => '<th title="' + esc(c) + '">' + esc(c.split('.').pop()) + '</th>').join('') +
      '<th></th></tr></thead>';
    const body = el('tbody');

    for (const row of data.rows) {
      const json = el('tr', { class: 'raw-json-row' });
      const jsonCell = el('td', { colspan: String(span) });
      jsonCell.append(el('pre', { class: 'json', html: PM.jsonHighlight(row.doc) }));
      json.append(jsonCell);
      json.hidden = true;

      const caret = el('span', { class: 'raw-caret', text: '›' });
      const tr = el('tr', {
        class: 'clickable',
        title: 'Show the document',
        onclick: (event) => {
          if (event.target.closest('button')) return;
          json.hidden = !json.hidden;
          caret.textContent = json.hidden ? '›' : '⌄';
        },
      });

      const caretCell = el('td', { class: 'raw-caret-col' });
      caretCell.append(caret);
      tr.append(caretCell);
      tr.append(
        el('td', {
          class: 'raw-at',
          html: row.at
            ? esc(fmt.dayTime(row.at)) + '<div class="person-sub">' + esc(fmt.ago(row.at)) + '</div>'
            : '<span class="hint">no createdAt</span>',
          title: row.at || '',
        })
      );
      tr.append(
        el('td', {
          html: row.kind
            ? '<span class="badge badge-neutral">' + esc(row.kind) + '</span>'
            : '<span class="badge badge-warning" title="this document matches none of the shapes this console knows">unrecognised</span>',
        })
      );
      for (const path of columns) {
        const hit = resolve(row.doc, path);
        tr.append(
          el('td', {
            html: cell(hit.value),
            // Only when the value came from somewhere other than the column
            // asked for, so the reader is never misled about which field they
            // are looking at.
            title: hit.value !== undefined && hit.path !== path ? 'from ' + hit.path : null,
            class: hit.value !== undefined && hit.path !== path ? 'raw-aliased' : null,
          })
        );
      }
      tr.append(
        el('td', { class: 'raw-actions' }, [
          el('button', {
            class: 'btn btn-sm',
            text: '⧉',
            title: 'Copy this document as JSON',
            onclick: () => {
              navigator.clipboard
                .writeText(JSON.stringify(row.doc, null, 2))
                .then(() => PM.toast('Copied ' + row.id, 'ok'))
                .catch(() => PM.toast('Could not copy', 'error'));
            },
          }),
        ])
      );

      body.append(tr, json);
    }

    node.append(body);
    host.append(node);
  }

  function toggleAll() {
    const button = document.querySelector('#raw-expand');
    const rows = document.querySelectorAll('#raw-list .raw-json-row');
    const anyClosed = [...rows].some((r) => r.hidden);
    for (const r of rows) r.hidden = !anyClosed;
    for (const c of document.querySelectorAll('#raw-list .raw-caret')) c.textContent = anyClosed ? '⌄' : '›';
    button.textContent = anyClosed ? '› Collapse all' : '⌄ Expand all';
  }

  function renderPager() {
    const pager = document.querySelector('#pager');
    pager.innerHTML = '';
    document.querySelector('#raw-title').textContent = data.collection || 'Documents';
    document.querySelector('#raw-sub').textContent = 'ordered by ' + (data.sortField || 'createdAt') + ' descending';
    if (!(data.rows || []).length) return;

    const page = Number(data.page || 1);
    const limit = Number(data.limit || 25);
    pager.append(
      el('span', { text: 'Showing ' + data.rows.length + ' of ' + fmt.int(data.total) }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm',
        text: '← Newer',
        disabled: page <= 1 ? 'disabled' : null,
        onclick: () => PM.setFilter('page', String(page - 1)),
      }),
      el('span', { text: 'Page ' + page }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Older →',
        disabled: page * limit >= data.total ? 'disabled' : null,
        onclick: () => PM.setFilter('page', String(page + 1)),
      })
    );
  }
})();
