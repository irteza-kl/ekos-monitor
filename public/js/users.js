/* Users & Devices: one row per person with their newest snapshot. Clicking a row
   opens that user own page (user.html) in the same tab. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let rows = [];
  let total = 0;

  const COLUMNS = [
    { key: 'currentUser.data.fullName', label: 'User' },
    { key: 'deviceType', label: 'Device' },
    { key: 'clockedIn', label: 'Clock' },
    { key: 'isInsideGeofence', label: 'Geofence' },
    { key: null, label: 'Distance to boundary', className: 'num' },
    { key: 'currentUserLocation.accuracy', label: 'GPS accuracy', className: 'num' },
    { key: 'batteryPercentage', label: 'Battery', className: 'num' },
    { key: null, label: 'Permissions' },
    // capturedAt, not createdAt: the column shows when they were last seen and
    // clicking it has to sort by the same thing it displays.
    { key: 'capturedAt', label: 'Last seen' },
  ];

  PM.boot('users.html', async ({ root, meta }) => {
    PM.buildFilterBar(() => [
      { kind: 'daterange' },
      { kind: 'multi', key: 'tenantId', label: 'Tenant', options: PM.optionsFrom(meta.tenants || [], 'id', 'name', 'snapshots') },
      { kind: 'multi', key: 'userId', label: 'User', options: PM.optionsFrom(meta.users || [], 'id', 'name', 'snapshots') },
      { kind: 'multi', key: 'deviceType', label: 'Device', options: PM.optionsFrom(meta.deviceTypes || [], 'key', 'key', 'count') },
      { kind: 'multi', key: 'appVersion', label: 'App version', options: PM.optionsFrom(meta.appVersions || [], 'key', 'key', 'count') },
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: PM.optionsFrom(meta.jobSiteIds || [], 'id', 'id', 'snapshots') },
      { kind: 'multi', key: 'accuracyBand', label: 'Accuracy band', options: PM.optionsFrom(meta.accuracyBands || [], 'key', 'label') },
      {
        kind: 'multi',
        key: 'permissionMissing',
        label: 'Missing permission',
        options: (meta.permissions || []).map((p) => ({ value: p, label: p })),
      },
      { kind: 'tri', key: 'clockedIn', label: 'Clocked in', yes: 'On the clock', no: 'Off the clock' },
      { kind: 'tri', key: 'insideGeofence', label: 'Inside fence', yes: 'Inside', no: 'Outside', nullable: true },
      { kind: 'tri', key: 'connected', label: 'Connectivity', yes: 'Online', no: 'Offline' },
      { kind: 'number', key: 'accuracyMax', label: 'Accuracy <= m', placeholder: 'e.g. 25' },
      { kind: 'number', key: 'accuracyMin', label: 'Accuracy >= m', placeholder: 'e.g. 50' },
      { kind: 'number', key: 'batteryMax', label: 'Battery <= %', placeholder: 'e.g. 20' },
      { kind: 'number', key: 'staleMinutes', label: 'Quiet >= min', placeholder: 'e.g. 15' },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'name, email, ref, tz' },
    ]);

    root.append(
      el('div', { class: 'tiles', id: 'user-tiles' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Latest state per user' }),
          el('span', { class: 'sub', id: 'table-sub' }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm', text: '↓ CSV', onclick: exportCsv }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'user-table' })]),
        el('div', { class: 'pager', id: 'pager' }),
      ])
    );

    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  function exportCsv() {
    window.open('/api/users.csv?' + queryString(), '_blank');
  }

  async function load() {
    PM.showSkeleton({
      '#user-tiles': 'tiles:5',
      '#user-table': 'table:10x9',
    });
    const data = await api('/api/users?' + queryString());
    rows = data.rows || [];
    total = data.total || 0;
    renderTiles();
    renderTable();
    PM.setSubtitle(fmt.int(total) + ' users match · newest snapshot each');
    PM.markLoaded();
  }

  function renderTiles() {
    const host = document.querySelector('#user-tiles');
    host.innerHTML = '';
    const withFix = rows.filter((r) => r.location);
    const disagree = rows.filter((r) => r.verdictDisagrees);
    const uncertain = rows.filter((r) => r.computedVerdict === 'unknown');
    const gaps = rows.filter((r) => r.permissionsMissing.length);
    const tile = (label, value, note, tone) =>
      el('div', { class: 'tile ' + (tone ? 'is-' + tone : '') }, [
        el('div', { class: 'tile-label', text: label }),
        el('div', { class: 'tile-value', text: value }),
        el('div', { class: 'tile-note', text: note }),
      ]);
    host.append(
      tile('Matching users', fmt.int(total), rows.length + ' on this page'),
      tile('With a GPS fix', fmt.int(withFix.length), rows.length - withFix.length + ' without coordinates'),
      tile('Verdict mismatches', fmt.int(disagree.length), 'app flag vs recomputed geometry', disagree.length ? 'critical' : undefined),
      tile('Uncertain fixes', fmt.int(uncertain.length), 'accuracy overlaps the boundary', uncertain.length ? 'warning' : undefined),
      tile('Permission gaps', fmt.int(gaps.length), 'at least one permission denied', gaps.length ? 'warning' : undefined)
    );
  }

  function renderTable() {
    const host = document.querySelector('#user-table');
    host.innerHTML = '';
    if (!rows.length) {
      host.append(el('div', { class: 'empty', text: 'No users match these filters. Widen the time range or clear a filter.' }));
      document.querySelector('#pager').innerHTML = '';
      return;
    }

    const table = el('table');
    const head = el('tr');
    for (const col of COLUMNS) {
      const th = el('th', { class: (col.className || '') + (col.key ? ' sortable' : ''), text: col.label });
      if (col.key) {
        const current = PM.state.filters.sortBy;
        if (current === col.key) {
          th.append(el('span', { class: 'arrow', text: PM.state.filters.sortDir === 'asc' ? '▲' : '▼' }));
        }
        th.addEventListener('click', () => {
          const dir = PM.state.filters.sortBy === col.key && PM.state.filters.sortDir !== 'asc' ? 'asc' : 'desc';
          PM.setFilter('sortBy', col.key, { reload: false });
          PM.setFilter('sortDir', dir);
        });
      }
      head.append(th);
    }
    table.append(el('thead', {}, [head]));

    const body = el('tbody');
    for (const row of rows) {
      const rel = row.relation;
      const distance = rel
        ? (rel.inside ? '−' : '+') +
          fmt.metres(Math.abs(rel.distanceFromBoundary)) +
          '<div class="person-sub">' +
          (rel.inside ? 'inside' : 'outside') +
          ' · ' +
          (rel.compass || '') +
          '</div>'
        : '<span class="hint">no fence</span>';

      const href = '/user.html?userId=' + encodeURIComponent(row.userId === null ? 'anonymous' : row.userId);
      const tr = el('tr', {
        class: 'clickable',
        title: 'Open this user',
        html:
          '<td><div class="person"><div class="avatar">' +
          esc(fmt.initials(row.name)) +
          '</div><div class="person-main"><div class="person-name">' +
          '<a href="' + href + '">' + esc(row.name || 'Unidentified device') + '</a>' +
          (row.verdictDisagrees ? ' <span class="badge badge-critical">⚑ mismatch</span>' : '') +
          '</div><div class="person-sub">' +
          esc([row.employeeRef, row.tenantName, row.email].filter(Boolean).join(' · ') || 'no session data') +
          '</div></div></div></td>' +
          '<td>' +
          esc(row.deviceType || '?') +
          '<div class="person-sub">v' +
          esc(row.appVersion || '?') +
          ' (' +
          esc(row.buildVersion || '?') +
          ')' +
          (row.offline ? ' · <span style="color:' + C.critical + '">offline</span>' : '') +
          '</div></td>' +
          '<td>' +
          (row.clockedIn ? '<span class="badge badge-good">● On clock</span>' : '<span class="badge badge-neutral">○ Off clock</span>') +
          (row.timeEntry && row.timeEntry.clockIn ? '<div class="person-sub">since ' + fmt.time(row.timeEntry.clockIn) + '</div>' : '') +
          '</td>' +
          '<td>' +
          PM.geofenceBadge(row.isInsideGeofence, row.computedVerdict, row.verdictReason) +
          (row.jobSiteId != null ? '<div class="person-sub">site ' + row.jobSiteId + '</div>' : '<div class="person-sub">unmapped</div>') +
          '</td>' +
          '<td class="num">' +
          distance +
          '</td>' +
          '<td class="num">' +
          PM.accuracyBadge(row.accuracyBand, row.accuracy) +
          '</td>' +
          '<td class="num">' +
          PM.batteryBadge(row.battery) +
          '</td>' +
          '<td>' +
          (row.permissionsMissing.length
            ? '<span class="badge badge-warning" title="' + esc(row.permissionsMissing.join(', ')) + '">' + row.permissionsMissing.length + ' denied</span>'
            : '<span class="badge badge-good">All granted</span>') +
          '</td>' +
          '<td>' +
          fmt.ago(row.capturedAt) +
          '<div class="person-sub">' +
          esc(row.timezone || '') +
          '</div></td>',
        onclick: (event) => {
          // The name is a real link; anywhere else on the row goes to the same place.
          if (event.target.closest('a')) return;
          PM.openRow(href, event);
        },
      });
      body.append(tr);
    }
    table.append(body);
    host.append(table);

    const pager = document.querySelector('#pager');
    const page = Number(PM.state.filters.page || 1);
    const limit = Number(PM.state.filters.limit || 50);
    pager.innerHTML = '';
    pager.append(
      el('span', { text: 'Showing ' + rows.length + ' of ' + fmt.int(total) }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm',
        text: '← Previous',
        disabled: page <= 1 ? 'disabled' : null,
        onclick: () => PM.setFilter('page', String(page - 1)),
      }),
      el('span', { text: 'Page ' + page }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Next →',
        disabled: page * limit >= total ? 'disabled' : null,
        onclick: () => PM.setFilter('page', String(page + 1)),
      })
    );
    document.querySelector('#table-sub').textContent = 'click a row to open that user';
  }

  // The per-user detail lives on its own page (public/js/user.js), opened in a
  // new tab from the table above - see renderTable().
})();
