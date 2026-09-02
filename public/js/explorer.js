/* Query Explorer: raw read-only MongoDB access - find or aggregate, with the
   field inventory beside it and one-click recipes. */
(function () {
  'use strict';
  const { el, fmt, api, esc } = PM;

  let collections = [];
  let fields = [];
  let lastResult = null;

  const RECIPES = [
    {
      name: 'Devices outside their fence',
      collection: 'snapshots',
      filter: { isInsideGeofence: false, clockedIn: true },
      sort: { createdAt: -1 },
    },
    {
      name: 'Unusable GPS fixes (>100 m)',
      collection: 'snapshots',
      filter: { 'currentUserLocation.accuracy': { $gt: 100 } },
      sort: { 'currentUserLocation.accuracy': -1 },
    },
    {
      name: 'Low battery, background location denied',
      collection: 'snapshots',
      filter: { batteryPercentage: { $lte: 20 }, permissionsEnabled: { $nin: ['LOCATION_BACKGROUND'] } },
      sort: { batteryPercentage: 1 },
    },
    {
      name: 'Offline heartbeats',
      collection: 'snapshots',
      filter: { $or: [{ isConnected: false }, { isReachable: false }] },
      sort: { createdAt: -1 },
    },
    {
      name: 'Checks that failed the raw geometry',
      collection: 'clockInLogs',
      filter: { 'response.actualIsWithinRadius': false },
      sort: { createdAt: -1 },
    },
    {
      name: 'Passed only thanks to accuracy padding',
      collection: 'clockInLogs',
      filter: { 'response.isWithinRadius': true, 'response.actualIsWithinRadius': false },
      sort: { createdAt: -1 },
    },
    {
      name: 'Unmapped clock-ins',
      collection: 'clockInLogs',
      filter: { unmappedClockInData: { $ne: null } },
      sort: { createdAt: -1 },
    },
    {
      name: 'Snapshots per hour (aggregate)',
      collection: 'snapshots',
      pipeline: [
        { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'hour' } }, snapshots: { $sum: 1 }, users: { $addToSet: '$currentUser.data.id' } } },
        { $project: { snapshots: 1, users: { $size: '$users' } } },
        { $sort: { _id: -1 } },
      ],
    },
    {
      name: 'Worst accuracy per user (aggregate)',
      collection: 'snapshots',
      pipeline: [
        {
          $group: {
            _id: '$currentUser.data.fullName',
            worst: { $max: '$currentUserLocation.accuracy' },
            avg: { $avg: '$currentUserLocation.accuracy' },
            fixes: { $sum: 1 },
          },
        },
        { $sort: { worst: -1 } },
      ],
    },
    {
      name: 'Effective radius vs fence radius (aggregate)',
      collection: 'clockInLogs',
      pipeline: [
        {
          $group: {
            _id: '$siteAreaData.siteArea.id',
            radius: { $last: '$siteAreaData.siteArea.locations.radiusMeters' },
            maxEffective: { $max: '$response.effectiveRadius' },
            avgAccuracy: { $avg: '$requestBody.accuracy' },
            checks: { $sum: 1 },
          },
        },
        { $sort: { checks: -1 } },
      ],
    },
  ];

  PM.boot('explorer.html', async ({ root, meta }) => {
    // This page is the one that builds UI out of the metadata rather than
    // merely filtering by it, so it refreshes those parts when the metadata
    // arrives instead of holding the empty list it started with.
    const readCollections = () => {
      const cols = meta.collections || {};
      collections = [cols.snapshots, cols.clockInLogs, cols.exitWindows].filter(Boolean);
      return collections;
    };
    readCollections();

    PM.buildFilterBar([]);

    root.append(
      el('div', { class: 'notice' }, [
        el('span', { text: 'ℹ' }),
        el('span', {
          html:
            '<b>Read-only console.</b> Queries run with <code>find</code> or <code>aggregate</code> against ' +
            '<span id="explorer-collections">' + esc(collections.join(', ') || 'no collections') + '</span>' +
            '. <code>$where</code>, <code>$function</code>, <code>$accumulator</code>, <code>$out</code>, <code>$merge</code>, <code>$lookup</code> and ' +
            'other write or cross-collection stages are rejected server-side, results are capped at 500 documents, and every query has a ' +
            fmt.int(25) +
            '-second timeout.',
        }),
      ]),
      el('div', { style: 'display:grid;grid-template-columns:1fr 300px;gap:18px;align-items:start' }, [
        el('div', { style: 'display:flex;flex-direction:column;gap:18px;min-width:0' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-head' }, [
              el('h2', { text: 'Query' }),
              el('div', { class: 'spacer' }),
              el('span', { class: 'sub', id: 'query-status' }),
            ]),
            el('div', { class: 'card-body' }, [
              el('div', { class: 'filter-row' }, [
                el('div', { class: 'field' }, [
                  el('label', { text: 'Collection' }),
                  el(
                    'select',
                    { id: 'q-collection', onchange: loadFields },
                    collections.map((c) => el('option', { value: c, text: c }))
                  ),
                ]),
                el('div', { class: 'field' }, [
                  el('label', { text: 'Mode' }),
                  el('select', { id: 'q-mode', onchange: toggleMode }, [
                    el('option', { value: 'find', text: 'find' }),
                    el('option', { value: 'aggregate', text: 'aggregate' }),
                  ]),
                ]),
                el('div', { class: 'field' }, [el('label', { text: 'Limit' }), el('input', { id: 'q-limit', type: 'number', value: '25', min: '1', max: '500', style: 'width:90px' })]),
                el('div', { class: 'field' }, [el('label', { text: 'Skip' }), el('input', { id: 'q-skip', type: 'number', value: '0', min: '0', style: 'width:90px' })]),
                el('div', { class: 'field field-inline' }, [
                  el('label', { class: 'chip', style: 'cursor:pointer' }, [el('input', { type: 'checkbox', id: 'q-explain' }), document.createTextNode('Explain plan')]),
                ]),
                el('div', { class: 'field field-inline', style: 'margin-left:auto' }, [
                  el('button', { class: 'btn btn-sm btn-primary', text: '▶ Run  (Ctrl+Enter)', onclick: run }),
                  el('button', { class: 'btn btn-sm', text: '↓ JSON', onclick: download }),
                ]),
              ]),
              el('div', { class: 'adv-grid', id: 'find-inputs', style: 'margin-top:10px' }, [
                el('div', { class: 'field' }, [
                  el('label', { text: 'Filter' }),
                  el('textarea', { id: 'q-filter', rows: 8, spellcheck: 'false', text: '{\n  "isInsideGeofence": false\n}' }),
                ]),
                el('div', { class: 'field' }, [
                  el('div', { class: 'field' }, [el('label', { text: 'Projection (optional)' }), el('textarea', { id: 'q-projection', rows: 3, spellcheck: 'false', placeholder: '{ "createdAt": 1, "currentUserLocation": 1 }' })]),
                  el('div', { class: 'field' }, [el('label', { text: 'Sort' }), el('textarea', { id: 'q-sort', rows: 2, spellcheck: 'false', text: '{ "createdAt": -1 }' })]),
                ]),
              ]),
              el('div', { class: 'field', id: 'pipeline-inputs', style: 'display:none;margin-top:10px' }, [
                el('label', { text: 'Aggregation pipeline (array of stages, max 25)' }),
                el('textarea', {
                  id: 'q-pipeline',
                  rows: 10,
                  spellcheck: 'false',
                  text: '[\n  { "$group": { "_id": "$deviceType", "n": { "$sum": 1 } } },\n  { "$sort": { "n": -1 } }\n]',
                }),
              ]),
              el('div', {
                class: 'hint',
                html:
                  'Extended JSON is accepted: <code>{"_id":{"$oid":"..."}}</code>, <code>{"createdAt":{"$gte":{"$date":"2026-08-30T00:00:00Z"}}}</code>.',
              }),
            ]),
          ]),
          el('div', { class: 'card' }, [
            el('div', { class: 'card-head' }, [
              el('h2', { text: 'Results' }),
              el('span', { class: 'sub', id: 'result-sub' }),
              el('div', { class: 'spacer' }),
              el('div', { class: 'field field-inline' }, [
                el('button', { class: 'btn btn-sm', id: 'view-json', text: 'JSON', onclick: () => setView('json') }),
                el('button', { class: 'btn btn-sm', id: 'view-table', text: 'Table', onclick: () => setView('table') }),
              ]),
            ]),
            el('div', { class: 'card-body tight' }, [el('div', { id: 'results' }, [el('div', { class: 'empty', text: 'Run a query to see documents.' })])]),
          ]),
        ]),
        el('div', { style: 'display:flex;flex-direction:column;gap:18px' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-head' }, [el('h2', { text: 'Recipes' })]),
            el('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:6px' }, RECIPES.map(recipeButton)),
          ]),
          el('div', { class: 'card' }, [
            el('div', { class: 'card-head' }, [el('h2', { text: 'Fields' }), el('span', { class: 'sub', text: 'click to copy a path' })]),
            el('div', { class: 'card-body tight' }, [el('div', { id: 'field-list', style: 'max-height:520px;overflow:auto' })]),
          ]),
        ]),
      ])
    );

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
    });
    setView('table');

    // The collection list comes from /api/meta, which now answers after the
    // page is drawn. Fill the picker whenever it arrives, then read the fields
    // for whatever it selected.
    const fillCollections = async () => {
      const select = document.querySelector('#q-collection');
      if (!select) return;
      const chosen = select.value;
      const names = readCollections();
      select.innerHTML = '';
      for (const name of names) select.append(el('option', { value: name, text: name }));
      if (names.includes(chosen)) select.value = chosen;
      const shown = document.querySelector('#explorer-collections');
      if (shown) shown.textContent = names.join(', ') || 'no collections';
      await loadFields();
    };

    await fillCollections();
    window.addEventListener('pm:meta', fillCollections);
    window.addEventListener('pm:refresh', run);
  });

  function recipeButton(recipe) {
    return el('button', {
      class: 'btn btn-sm',
      style: 'text-align:left',
      text: (recipe.pipeline ? 'Σ ' : '⌕ ') + recipe.name,
      onclick: () => {
        const meta = PM.state.meta.collections || {};
        const name = meta[recipe.collection] || recipe.collection;
        document.querySelector('#q-collection').value = name;
        if (recipe.pipeline) {
          document.querySelector('#q-mode').value = 'aggregate';
          document.querySelector('#q-pipeline').value = JSON.stringify(recipe.pipeline, null, 2);
        } else {
          document.querySelector('#q-mode').value = 'find';
          document.querySelector('#q-filter').value = JSON.stringify(recipe.filter, null, 2);
          document.querySelector('#q-sort').value = JSON.stringify(recipe.sort || { _id: -1 }, null, 2);
        }
        toggleMode();
        loadFields();
        run();
      },
    });
  }

  function toggleMode() {
    const mode = document.querySelector('#q-mode').value;
    document.querySelector('#find-inputs').style.display = mode === 'find' ? '' : 'none';
    document.querySelector('#pipeline-inputs').style.display = mode === 'aggregate' ? '' : 'none';
  }

  async function loadFields() {
    const collection = document.querySelector('#q-collection').value;
    const host = document.querySelector('#field-list');
    host.innerHTML = '<div class="empty">loading fields...</div>';
    try {
      const data = await api('/api/query/fields?collection=' + encodeURIComponent(collection));
      fields = data.fields || [];
      host.innerHTML = '';
      for (const field of fields) {
        host.append(
          el('div', {
            style: 'padding:5px 12px;border-bottom:1px solid var(--grid);cursor:pointer;font-family:var(--mono);font-size:11.5px',
            title: 'click to copy',
            html: esc(field.path) + ' <span style="color:var(--ink-muted)">' + esc(field.types.join('|')) + '</span>',
            onclick: () => {
              navigator.clipboard.writeText(field.path).then(() => PM.toast('Copied ' + field.path, 'ok'));
            },
          })
        );
      }
    } catch (err) {
      host.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    }
  }

  function parseBox(id, label) {
    const raw = document.querySelector(id).value.trim();
    if (!raw) return undefined;
    try {
      JSON.parse(raw);
    } catch (err) {
      throw new Error(label + ' is not valid JSON: ' + err.message);
    }
    return raw;
  }

  async function run() {
    const status = document.querySelector('#query-status');
    const results = document.querySelector('#results');
    const mode = document.querySelector('#q-mode').value;
    status.textContent = 'running...';
    try {
      const body = {
        collection: document.querySelector('#q-collection').value,
        limit: Number(document.querySelector('#q-limit').value) || 25,
        skip: Number(document.querySelector('#q-skip').value) || 0,
      };
      if (mode === 'aggregate') {
        body.pipeline = parseBox('#q-pipeline', 'Pipeline');
      } else {
        body.filter = parseBox('#q-filter', 'Filter');
        body.projection = parseBox('#q-projection', 'Projection');
        body.sort = parseBox('#q-sort', 'Sort');
        body.explain = document.querySelector('#q-explain').checked;
      }
      const data = await api('/api/query', { method: 'POST', body: JSON.stringify(body) });
      lastResult = data;
      status.textContent = data.mode + ' · ' + data.took + ' ms';
      document.querySelector('#result-sub').textContent =
        data.count + ' document(s)' + (data.total !== null && data.total !== undefined ? ' of ' + fmt.int(data.total) + ' matching' : '') + ' · limit ' + data.limit;
      render();
      if (data.plan) PM.toast('Winning plan: ' + describePlan(data.plan.stage), 'ok');
      PM.markLoaded();
    } catch (err) {
      status.textContent = 'failed';
      results.innerHTML = '<div class="empty" style="color:#f08a8a">' + esc(err.message) + '</div>';
      PM.toast(err.message, 'error');
    }
  }

  function describePlan(stage) {
    const parts = [];
    let node = stage;
    let guard = 0;
    while (node && guard < 8) {
      if (node.stage) parts.push(node.stage + (node.indexName ? '(' + node.indexName + ')' : ''));
      node = node.inputStage;
      guard += 1;
    }
    return parts.join(' <- ') || 'unknown';
  }

  let view = 'table';
  function setView(next) {
    view = next;
    document.querySelector('#view-json').className = 'btn btn-sm' + (view === 'json' ? ' btn-primary' : '');
    document.querySelector('#view-table').className = 'btn btn-sm' + (view === 'table' ? ' btn-primary' : '');
    if (lastResult) render();
  }

  function render() {
    const host = document.querySelector('#results');
    host.innerHTML = '';
    const docs = (lastResult && lastResult.rows) || [];
    if (!docs.length) {
      host.append(el('div', { class: 'empty', text: 'No documents matched.' }));
      return;
    }
    if (view === 'json') {
      host.append(el('pre', { class: 'json', style: 'max-height:620px;border:none', html: PM.jsonHighlight(docs) }));
      return;
    }

    // Flatten one level deep so nested objects stay readable in a table.
    const columns = [];
    for (const doc of docs) {
      for (const key of Object.keys(flatten(doc))) if (!columns.includes(key)) columns.push(key);
    }
    const shown = columns.slice(0, 14);
    const table = el('table');
    table.innerHTML = '<thead><tr>' + shown.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead>';
    const body = el('tbody');
    for (const doc of docs) {
      const flat = flatten(doc);
      body.append(
        el('tr', {
          html: shown
            .map((c) => {
              const value = flat[c];
              const text = value === undefined ? '' : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
              return '<td class="mono" title="' + esc(text) + '">' + esc(text.length > 60 ? text.slice(0, 60) + '…' : text) + '</td>';
            })
            .join(''),
        })
      );
    }
    table.append(body);
    host.append(el('div', { class: 'table-scroll' }, [table]));
    if (columns.length > shown.length) {
      host.append(
        el('div', { class: 'pager' }, [
          el('span', { text: 'Showing ' + shown.length + ' of ' + columns.length + ' columns - switch to JSON for the whole document.' }),
        ])
      );
    }
  }

  function flatten(doc, prefix, out, depth) {
    const target = out || {};
    const level = depth || 0;
    for (const [key, value] of Object.entries(doc || {})) {
      const path = prefix ? prefix + '.' + key : key;
      if (value && typeof value === 'object' && !Array.isArray(value) && level < 2 && !value.$oid && !value.$date) {
        flatten(value, path, target, level + 1);
      } else {
        target[path] = value && value.$oid ? value.$oid : value && value.$date ? value.$date : value;
      }
    }
    return target;
  }

  function download() {
    if (!lastResult) return;
    const blob = new Blob([JSON.stringify(lastResult.rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'phantom-query-result.json';
    a.click();
    URL.revokeObjectURL(url);
  }
})();
