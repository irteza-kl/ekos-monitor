/* Overview: the at-a-glance operations picture. */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const C = PM.colors;

  let liveMap = null;
  let mapLayers = [];

  PM.boot('index.html', async ({ root, meta }) => {
    PM.buildFilterBar(() => [
      { kind: 'daterange' },
      {
        kind: 'multi',
        key: 'tenantId',
        label: 'Tenant',
        options: PM.optionsFrom(meta.tenants || [], 'id', 'name', 'snapshots'),
      },
      { kind: 'multi', key: 'userId', label: 'User', options: PM.optionsFrom(meta.users || [], 'id', 'name', 'snapshots') },
      {
        kind: 'multi',
        key: 'deviceType',
        label: 'Device',
        options: PM.optionsFrom(meta.deviceTypes || [], 'key', 'key', 'count'),
      },
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: PM.optionsFrom(meta.jobSiteIds || [], 'id', 'id', 'snapshots') },
      {
        kind: 'multi',
        key: 'accuracyBand',
        label: 'GPS accuracy',
        options: PM.optionsFrom(meta.accuracyBands || [], 'key', 'label'),
      },
      { kind: 'tri', key: 'clockedIn', label: 'Clocked in', yes: 'On the clock', no: 'Off the clock' },
      { kind: 'tri', key: 'insideGeofence', label: 'Inside fence', yes: 'Inside', no: 'Outside', nullable: true },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'name, email, employee ref' },
    ]);

    root.append(
      // Problems first: the strip at the top, its detail below the state tiles.
      el('div', { class: 'section-title', text: 'What is wrong' }),
      el('div', { class: 'tiles', id: 'issue-summary' }),
      el('div', { class: 'section-title', text: 'Current state' }),
      el('div', { class: 'tiles', id: 'tiles' }),
      el('div', { class: 'section-title', text: 'Time on site' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'How long people were actually inside a fence' }),
          el('span', { class: 'sub', id: 'fence-sub' }),
          el('div', { class: 'spacer' }),
          el('button', {
            class: 'btn btn-sm',
            text: '\u2193 CSV',
            onclick: () => window.open('/api/fence-time.csv?' + queryString(), '_blank'),
          }),
        ]),
        // Two bodies: the tiles need the normal padding, the table is
        // full-bleed like every other table here. A single 'tight' body put
        // the tiles flush against the card border.
        el('div', { class: 'card-body' }, [el('div', { class: 'tiles tiles-4', id: 'fence-tiles' })]),
        el('div', { class: 'card-body tight card-split' }, [
          el('div', { class: 'table-scroll', id: 'fence-table' }),
        ]),
      ]),
      el('div', { class: 'section-title', text: 'What is wrong, in detail' }),
      el('div', { class: 'grid-2', id: 'issue-columns' }, [
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { text: 'People in the field' }),
            el('span', { class: 'sub', id: 'people-sub' }),
            el('div', { class: 'spacer' }),
            el('button', {
              class: 'btn btn-sm',
              text: '↓ CSV',
              onclick: () => window.open('/api/issues.csv?' + queryString(), '_blank'),
            }),
          ]),
          el('div', { class: 'card-body tight' }, [el('div', { class: 'issue-list', id: 'issues-people' })]),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { text: 'App & data' }),
            el('span', { class: 'sub', id: 'app-sub' }),
          ]),
          el('div', { class: 'card-body tight' }, [el('div', { class: 'issue-list', id: 'issues-app' })]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Who is having the worst time' }),
          el('span', { class: 'sub', text: 'people ranked by the problems they are actually hitting' }),
          el('div', { class: 'spacer' }),
          el('a', { class: 'btn btn-sm', href: '/users.html', text: 'All users ↗' }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'worst-users' })]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Where everyone is right now' }),
          el('span', { class: 'sub', id: 'map-sub' }),
          el('div', { class: 'spacer' }),
          el('a', { class: 'btn btn-sm', href: '/map.html', text: 'Full map ↗' }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'map', id: 'overview-map' })]),
        el('div', { html: PMMap.legend() }),
      ]),
      el('div', { class: 'grid-2' }, [
        card('Geofence state over time', 'Snapshot counts per bucket, stacked', 'chart-geo', 'tall', [
          el('div', {
            html: PMChart.legend([
              { color: C.in, label: 'Inside fence' },
              { color: C.out, label: 'Outside fence' },
              { color: C.unknown, label: 'No fence flag' },
            ]),
          }),
        ]),
        card('GPS accuracy over time', 'Average and worst fix per bucket, metres', 'chart-acc', 'tall', [
          el('div', {
            html: PMChart.legend([
              { color: C.series[0], label: 'Average accuracy' },
              { color: C.series[3], label: 'Worst accuracy' },
            ]),
          }),
        ]),
      ]),
      el('div', { class: 'grid-2' }, [
        card('Accuracy distribution', 'How trustworthy the location data is', 'chart-hist'),
        card('Devices per platform', 'Snapshots by platform', 'chart-device'),
      ]),
      el('div', { class: 'grid-2' }, [
        card('Site activity', 'Snapshots per site, inside vs outside the fence', 'chart-sites', 'tall', [
          el('div', {
            html: PMChart.legend([
              { color: C.in, label: 'Inside fence' },
              { color: C.out, label: 'Outside fence' },
            ]),
          }),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { text: 'Per-user activity' }),
            el('div', { class: 'spacer' }),
            el('a', { class: 'btn btn-sm', href: '/users.html', text: 'All users ↗' }),
          ]),
          el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'user-table' })]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Geofence validation calls' }),
          el('span', { class: 'sub', text: 'What the clock-in checks decided, from validateClockInLogs' }),
          el('div', { class: 'spacer' }),
          el('a', { class: 'btn btn-sm', href: '/checks.html', text: 'Inspect checks ↗' }),
        ]),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'tiles', id: 'check-tiles' }),
          el('div', { style: 'margin-top:14px' }, [
            el('div', { class: 'chart-wrap', id: 'chart-checks-wrap' }, [el('canvas', { id: 'chart-checks' })]),
            el('div', {
              html: PMChart.legend([
                { color: C.in, label: 'Passed (within radius)' },
                { color: C.out, label: 'Failed geometry' },
                { color: C.series[3], label: 'Auto clock-outs' },
              ]),
            }),
          ]),
        ]),
      ])
    );

    liveMap = PMMap.create(document.querySelector('#overview-map'));
    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  function card(title, subtitle, canvasId, size, extra) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: title }), subtitle ? el('span', { class: 'sub', text: subtitle }) : null]),
      el('div', { class: 'card-body' }, [
        el('div', { class: 'chart-wrap ' + (size || '') }, [el('canvas', { id: canvasId })]),
        ...(extra || []),
      ]),
    ]);
  }

  async function load() {
    PM.showSkeleton({
      '#issue-summary': 'tiles:4',
      '#fence-tiles': 'tiles:4',
      '#fence-table': 'table:5x5',
      '#issues-people': 'table:5x2',
      '#issues-app': 'table:5x2',
      '#worst-users': 'table:5x3',
      '#tiles': 'tiles:8',
      '#overview-map': 'map',
      '#chart-geo': 'chart',
      '#chart-acc': 'chart',
      '#chart-hist': 'chart',
      '#chart-device': 'chart',
      '#chart-sites': 'chart',
      '#chart-checks': 'chart',
      '#user-table': 'table:8x7',
      '#check-tiles': 'tiles:5',
    });
    const qs = queryString();
    // allSettled, not all: these four are independent questions, and Promise.all
    // threw away three good answers whenever the fourth failed - so one slow
    // aggregation timing out blanked the entire page.
    // compare=1 adds the same detection over the previous window of equal
    // length, so every count can say which way it is moving.
    const [stats, users, problems, fence] = (
      await Promise.allSettled([
        api('/api/stats?' + qs),
        api('/api/users?' + qs + '&limit=200'),
        api('/api/issues?' + qs + '&compare=1'),
        api('/api/fence-time?' + qs),
      ])
    ).map((r) => (r.status === 'fulfilled' ? r.value : null));

    const failed = [];
    if (!problems) failed.push('problem detection');
    if (!stats) failed.push('statistics');
    if (!users) failed.push('device positions');
    if (!fence) failed.push('time on site');

    if (problems) {
      renderIssues(problems);
    } else {
      panelFailed('#issue-summary', '#issues-people', '#issues-app', '#worst-users');
    }
    if (fence) {
      renderFenceTime(fence, stats);
    } else {
      panelFailed('#fence-tiles', '#fence-table');
    }
    if (stats) {
      renderTiles(stats);
      renderCharts(stats);
      renderUserTable(stats.perUser || []);
      renderChecks(stats);
    } else {
      panelFailed('#tiles', '#user-table', '#check-tiles');
    }
    if (users) {
      renderMap(users.rows);
    } else {
      panelFailed('#overview-map');
    }
    if (problems) renderWorstUsers(problems);
    const c = (problems || {}).counts || {};
    // Improvement is worth stating outright: a list of problems that never
    // acknowledges anything clearing reads as though nothing ever gets fixed.
    const cleared = (((problems || {}).previous || {}).resolved || []).length;
    const devices = (stats || {}).devices || {};
    PM.setSubtitle(
      (c.critical + c.serious
        ? c.critical + ' critical · ' + c.serious + ' serious · ' + c.warning + ' warning'
        : 'nothing critical') +
        (cleared ? ' · ' + cleared + ' cleared since the previous period' : '') +
        ' · ' +
        fmt.int(devices.totalSnapshots) +
        ' snapshots · ' +
        fmt.int(devices.trackedUsers) +
        ' users in range'
    );

    if (failed.length) {
      // Some of the page is real and some of it is missing, and the reader has
      // to be told which - so this is a standing banner, not a toast.
      PM.markStale('Could not load ' + failed.join(', ') + '. Everything else on this page is current.');
    } else {
      PM.markLoaded();
    }
  }

  /** Marks the panels whose own request failed, leaving the rest of the page. */
  function panelFailed(...selectors) {
    for (const selector of selectors) {
      const host = document.querySelector(selector);
      if (!host) continue;
      host.classList.remove('is-loading');
      host.innerHTML = '';
      host.append(el('div', { class: 'panel-error', text: 'Could not load this panel.' }));
    }
  }

  function tile(label, value, opts) {
    const options = opts || {};
    const node = el('div', { class: 'tile ' + (options.tone ? 'is-' + options.tone : '') + (options.href ? ' clickable' : '') }, [
      el('div', { class: 'tile-label', text: label }),
      el('div', { class: 'tile-value', html: value === null || value === undefined ? '--' : String(value) }),
      deltaChip(options.delta),
      options.note ? el('div', { class: 'tile-note', text: options.note }) : null,
    ]);
    if (options.href) node.addEventListener('click', () => (location.href = options.href));
    return node;
  }

  /**
   * Which way a count is moving against the previous window of equal length.
   *
   * A bare number cannot say whether things are improving, which is most of
   * what anyone opens a monitor to find out. Absent when no comparison was
   * available - an unbounded date range has no previous period - rather than
   * showing a zero that would read as "no change".
   */
  function deltaChip(delta) {
    if (delta === null || delta === undefined) return null;
    if (delta === 0) {
      return el('div', { class: 'delta is-flat', text: 'no change' });
    }
    const worse = delta > 0;
    return el('div', {
      class: 'delta ' + (worse ? 'is-worse' : 'is-better'),
      text: (worse ? '▲ +' : '▼ ') + delta + ' vs previous period',
    });
  }

  /**
   * What the affected count is actually counting.
   *
   * This used to add every issue’s count together, so ten unresolved exit
   * windows plus two flat batteries plus one stuck device read as "13 affected"
   * - a number in no unit at all. Issues are grouped by their own unit instead.
   */
  function affectedNote(list) {
    const byUnit = new Map();
    for (const i of list) {
      const unit = i.unit || 'item';
      byUnit.set(unit, (byUnit.get(unit) || 0) + i.count);
    }
    return [...byUnit.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([unit, n]) => n + ' ' + unit + (n === 1 ? '' : 's'))
      .join(' · ');
  }

  /* The severity strip: the four numbers meant to be read first. */
  function renderIssues(problems) {
    const host = document.querySelector('#issue-summary');
    host.innerHTML = '';
    const c = problems.counts || {};
    const was = (problems.previous || {}).counts || null;
    const bySeverity = (sev) => (problems.issues || []).filter((i) => i.severity === sev);

    host.append(
      tile('Critical', fmt.int(c.critical), {
        tone: c.critical ? 'critical' : 'good',
        note: c.critical ? affectedNote(bySeverity('critical')) : 'nothing critical',
        delta: was ? c.critical - was.critical : null,
      }),
      tile('Serious', fmt.int(c.serious), {
        tone: c.serious ? 'serious' : undefined,
        note: c.serious ? affectedNote(bySeverity('serious')) : 'none',
        delta: was ? c.serious - was.serious : null,
      }),
      tile('Warnings', fmt.int(c.warning), {
        tone: c.warning ? 'warning' : undefined,
        note: c.warning ? affectedNote(bySeverity('warning')) : 'none',
        delta: was ? c.warning - was.warning : null,
      }),
      tile('People affected', fmt.int((problems.byUser || []).length), {
        note: c.people + ' issue type(s) in the field',
        href: '/users.html',
      })
    );


    fillFeed('#issues-people', (problems.issues || []).filter((i) => i.group === 'people'), '#people-sub');
    fillFeed('#issues-app', (problems.issues || []).filter((i) => i.group === 'app'), '#app-sub');

    if ((problems.unavailable || []).length) {
      document.querySelector('#app-sub').textContent += ' · not checked: ' + problems.unavailable.join(', ');
    }
  }

  function fillFeed(selector, list, subSelector) {
    const host = document.querySelector(selector);
    host.innerHTML = '';
    const sub = document.querySelector(subSelector);
    if (sub) {
      sub.textContent = list.length
        ? list.length + ' issue type(s), worst first'
        : 'nothing detected';
    }
    if (!list.length) {
      host.append(el('div', { class: 'all-clear', text: '✓ Nothing detected here' }));
      return;
    }
    for (const i of list) host.append(issueRow(i));
  }

  /* The link opens that page filtered to the documents behind the count. */
  function issueRow(i) {
    const who = i.who.length
      ? '<div class="issue-who">' +
        i.who.map((w) => '<span>' + esc(w.name) + (w.note ? ' · ' + esc(w.note) : '') + '</span>').join('') +
        (i.whoTotal > i.who.length ? '<span class="more">+' + (i.whoTotal - i.who.length) + ' more</span>' : '') +
        '</div>'
      : '';
    const node = el('a', {
      class: 'issue is-' + i.severity,
      href: i.href || '#',
      html:
        '<div class="issue-title">' + esc(i.title) + '</div>' +
        '<div class="issue-count">' + fmt.int(i.count) + ' ' + esc(i.unit) + (i.count === 1 ? '' : 's') + trendMark(i) + '</div>' +
        '<div class="issue-detail">' + esc(i.detail) + '</div>' +
        '<div class="issue-meta">' + (i.lastAt ? esc(fmt.ago(i.lastAt)) : '') + '</div>' +
        who +
        '<div class="issue-evidence">' + esc(i.evidence) + '</div>',
    });
    return node;
  }

  /**
   * How this issue compares with the previous window.
   *
   * "new" is the one worth spotting: an issue that was not happening before is
   * a change in behaviour, not a standing condition.
   */
  function trendMark(i) {
    if (i.isNew) return '<span class="trend is-new">new</span>';
    if (i.previousCount === null || i.previousCount === undefined) return '';
    const delta = i.count - i.previousCount;
    if (delta === 0) return '<span class="trend is-flat">level</span>';
    return (
      '<span class="trend ' + (delta > 0 ? 'is-worse' : 'is-better') + '">' +
      (delta > 0 ? '▲ ' : '▼ ') + Math.abs(delta) +
      '</span>'
    );
  }

  /**
   * Time on site, measured by integrating state rather than counting pings.
   *
   * The distinction is the whole point of this card. Reporting rates across
   * this fleet differ by more than two hundred times, so a share of heartbeats
   * says who reports most often; a share of TIME says who was on site. Both are
   * shown per person, because seeing them disagree is what makes the difference
   * believable.
   */
  function renderFenceTime(fence, stats) {
    const tiles = document.querySelector('#fence-tiles');
    const host = document.querySelector('#fence-table');
    tiles.innerHTML = '';
    host.innerHTML = '';
    const t = (fence && fence.totals) || {};
    const rows = (fence && fence.perUser) || [];
    const span = (msValue) => fmt.span(msValue);

    // Colour carries exactly one meaning across these four: amber marks time
    // that could not be accounted for. The first two are measurements - time on
    // site is neither good nor bad, and painting it green implied a verdict the
    // number does not carry.
    tiles.append(
      tile('Time inside a fence', span(t.insideMs), {
        note: 'measured, not sampled',
      }),
      tile('Share of measured time inside', fmt.pct((t.insideShareByTime || 0) * 100, 0), {
        note:
          'counting heartbeats instead would say ' +
          fmt.pct((t.insideShareByBeats || 0) * 100, 0),
      }),
      tile('Nobody knew where they were', span(t.silentMs), {
        tone: t.silentMs > 0 ? 'warning' : undefined,
        note: 'gaps too long to credit to any state',
      }),
      tile('No fence verdict at all', span(t.unknownMs), {
        tone: t.unknownMs > 0 ? 'warning' : undefined,
        note: 'reporting, but neither inside nor outside',
      })
    );

    const sub = document.querySelector('#fence-sub');
    if (sub) {
      const skew = (stats && stats.perPerson) || null;
      // "person-time" is load-bearing: these totals are summed across people,
      // so eight people watched for a day gives more than 24h and would
      // otherwise read as impossible.
      sub.textContent =
        t.people + ' people · ' + fmt.int(t.visits) + ' crossings · totals are person-time' +
        (skew && skew.dominance
          ? ' · ' + fmt.pct(skew.dominance * 100, 0) + ' of heartbeats come from ' + skew.dominanceOf + ' devices'
          : '');
    }

    if (!rows.length) {
      host.append(el('div', { class: 'all-clear', text: 'No fence activity in this range' }));
      return;
    }

    const table = el('table', { class: 'fence-table' });
    table.innerHTML =
      '<thead><tr><th>Person</th><th class="num">Inside</th><th class="num">Outside</th>' +
      '<th class="num">Inside %</th><th class="num">If counting pings</th>' +
      '<th class="num">Crossings</th><th>Not accounted for</th></tr></thead>';
    const body = el('tbody');
    for (const u of rows) {
      const byTime = u.insideShare === null ? null : u.insideShare * 100;
      const byBeats = u.insideShareByBeats === null ? null : u.insideShareByBeats * 100;
      // The gap between the two bases, which is the reason this card exists.
      const spread = byTime === null || byBeats === null ? null : Math.abs(byTime - byBeats);

      // Chips on one wrapping line rather than a stack of divs: three stacked
      // lines made some rows three times the height of their neighbours, and a
      // table of measurements is unreadable when the rows do not line up.
      const gaps = [];
      if (u.silentMs > 0) gaps.push(esc(span(u.silentMs)) + ' silent');
      if (u.unknownMs > 0) gaps.push(esc(span(u.unknownMs)) + ' no verdict');
      if (u.neverExited) gaps.push('never left');

      // The coverage badge only earns its place when it changes the reading of
      // the number beside it. 'none' next to a count of zero said nothing twice.
      const crossings =
        u.visits === 0
          ? '<span class="muted">0</span>'
          : fmt.int(u.visits) +
            (u.eventCoverage === 'sparse'
              ? '<span class="chip chip-soft" title="This device sends crossing markers rarely, so the count is a floor rather than a total.">at least</span>'
              : '');

      body.append(
        el('tr', {
          class: 'clickable',
          onclick: (event) => PM.openRow('/user.html?userId=' + u.userId, event),
          html:
            '<td><div class="person"><div class="avatar">' +
            esc(fmt.initials(u.name)) +
            '</div><div class="person-main"><div class="person-name">' +
            esc(u.name) +
            '</div><div class="person-sub">' +
            esc(u.timezone ? fmt.zoneLabel(u.timezone) + ' · ' + u.beatsPerHour + '/h' : 'id ' + u.userId) +
            '</div></div></div></td>' +
            '<td class="num">' + esc(span(u.insideMs)) + '</td>' +
            '<td class="num">' + esc(span(u.outsideMs)) + '</td>' +
            '<td class="num strong">' + (byTime === null ? '--' : esc(fmt.pct(byTime, 0))) + '</td>' +
            '<td class="num' + (spread !== null && spread >= 10 ? ' is-off' : '') + '">' +
            (byBeats === null ? '--' : esc(fmt.pct(byBeats, 0))) +
            (spread !== null && spread >= 10
              ? '<span class="chip chip-warn" title="Counting heartbeats disagrees with measured time by this much for this person.">' +
                Math.round(spread) +
                ' pts off</span>'
              : '') +
            '</td>' +
            '<td class="num">' + crossings + '</td>' +
            (gaps.length
              ? '<td><div class="chip-row">' + gaps.map((g) => '<span class="chip">' + g + '</span>').join('') + '</div></td>'
              : '<td><span class="muted">--</span></td>'),
        })
      );
    }
    table.append(body);
    host.append(table);
  }

  /* The same findings keyed by person: "who needs help". */
  function renderWorstUsers(problems) {
    const host = document.querySelector('#worst-users');
    host.innerHTML = '';
    const list = problems.byUser || [];
    if (!list.length) {
      host.append(el('div', { class: 'all-clear', text: '✓ No user-facing problems in this range' }));
      return;
    }
    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>Person</th><th class="num">Problems</th><th>What they are hitting</th></tr></thead>';
    const body = el('tbody');
    for (const u of list) {
      body.append(
        el('tr', {
          class: 'clickable',
          onclick: (event) => PM.openRow('/user.html?userId=' + u.userId, event),
          html:
            '<td><div class="person"><div class="avatar">' +
            esc(fmt.initials(u.name)) +
            '</div><div class="person-main"><div class="person-name">' +
            esc(u.name) +
            '</div><div class="person-sub">id ' + u.userId + '</div></div></div></td>' +
            '<td class="num"><span class="badge badge-' +
            (u.worst === 'critical' ? 'critical' : u.worst === 'serious' ? 'serious' : 'warning') +
            '">' + u.count + '</span></td>' +
            '<td><div class="hit-list">' +
            u.issues
              .map(
                (x) =>
                  '<div class="hit-line">' +
                  esc(x.title) +
                  (x.note ? ' <span class="hit-note">— ' + esc(x.note) + '</span>' : '') +
                  '</div>'
              )
              .join('') +
            '</div></td>',
        })
      );
    }
    table.append(body);
    host.append(table);
  }

  function renderTiles(stats) {
    const d = stats.devices || {};
    const host = document.querySelector('#tiles');
    host.innerHTML = '';
    host.append(
      tile('Devices reporting', fmt.int(d.trackedUsers), {
        note: d.stale ? d.stale + ' stale (>15 min quiet)' : 'all reporting recently',
        tone: d.stale ? 'warning' : undefined,
        href: '/users.html',
      }),
      tile('On the clock', fmt.int(d.clockedIn), { note: d.clockedOut + ' clocked out', href: '/users.html?clockedIn=true' }),
      tile('Inside a fence', fmt.int(d.insideGeofence), {
        tone: 'good',
        note: d.geofenceUnknown ? d.geofenceUnknown + ' with no fence flag' : 'device-reported',
        href: '/users.html?insideGeofence=true',
      }),
      tile('Outside a fence', fmt.int(d.outsideGeofence), {
        tone: d.outsideGeofence ? 'critical' : undefined,
        note: d.outsideButClockedIn ? d.outsideButClockedIn + ' of them still clocked in' : 'none clocked in outside',
        href: '/users.html?insideGeofence=false',
      }),
      tile('Median accuracy', fmt.accuracy(d.medianAccuracy), {
        note: 'avg ' + fmt.accuracy(d.avgAccuracy) + ' · worst ' + fmt.accuracy(d.worstAccuracy),
        tone: d.medianAccuracy > 50 ? 'warning' : undefined,
      }),
      tile('Poor fixes', fmt.int(d.poorAccuracy), {
        note: 'devices over ±50 m right now',
        tone: d.poorAccuracy ? 'serious' : undefined,
        href: '/users.html?accuracyMin=50',
      }),
      tile('Low battery', fmt.int(d.lowBattery), {
        note: 'at or under 20%',
        tone: d.lowBattery ? 'warning' : undefined,
        href: '/users.html?batteryMax=20',
      }),
      tile('Offline devices', fmt.int(d.offline), {
        note: 'no connectivity on last ping',
        tone: d.offline ? 'critical' : undefined,
        href: '/users.html?connected=false',
      }),
      tile('Permission gaps', fmt.int(d.permissionGaps), {
        note: d.locationBackgroundMissing + ' missing background location',
        tone: d.locationBackgroundMissing ? 'critical' : d.permissionGaps ? 'warning' : undefined,
        href: '/users.html?permissionMissing=LOCATION_BACKGROUND',
      }),
      tile('Face checks pending', fmt.int(d.facialPending), { note: 'required but not completed' })
    );
  }

  function renderMap(rows) {
    PMMap.clear(mapLayers);
    mapLayers = [];
    const plotted = (rows || []).filter((r) => r.location);
    const seenSites = new Map();
    for (const row of plotted) {
      if (row.site && row.site.lat != null && !seenSites.has(row.site.siteId)) seenSites.set(row.site.siteId, row.site);
    }
    for (const site of seenSites.values()) mapLayers.push(PMMap.siteCircle(liveMap, site));
    for (const row of plotted) {
      mapLayers.push(PMMap.deviceMarker(liveMap, row, { pulse: row.ageMinutes !== null && row.ageMinutes < 5, onClick: openUser }));
      if (row.guide && row.fence) {
        mapLayers.push(
          PMMap.guideLine(liveMap, row.location, row.fence, {
            text: fmt.metres(row.guide.distanceMetres) + ' ' + (row.guide.compass || '') + ' of the fence',
          })
        );
      }
    }
    PMMap.fit(
      liveMap,
      plotted.map((r) => r.location)
    );
    document.querySelector('#map-sub').textContent =
      plotted.length + ' of ' + (rows || []).length + ' devices have a fix · ' + seenSites.size + ' fence(s) drawn';
  }

  function openUser(row) {
    location.href = '/users.html?search=' + encodeURIComponent(row.name || row.userId || '');
  }

  function renderCharts(stats) {
    const timeline = PM.padBuckets(stats.timeline || [], stats.granularity, {
      zero: ['count', 'inside', 'outside', 'unknown', 'clockedIn', 'offline', 'users'],
      nulls: ['avgAccuracy', 'worstAccuracy'],
    });
    const labels = timeline.map((t) => fmt.dayTime(t.at));

    PMChart.stackedTime(document.querySelector('#chart-geo'), {
      labels,
      yTitle: 'snapshots',
      datasets: [
        { label: 'Inside fence', data: timeline.map((t) => t.inside), color: C.in },
        { label: 'Outside fence', data: timeline.map((t) => t.outside), color: C.out },
        { label: 'No fence flag', data: timeline.map((t) => t.unknown), color: C.unknown },
      ],
    });

    PMChart.lineTime(document.querySelector('#chart-acc'), {
      labels,
      yTitle: 'metres',
      series: [
        { label: 'Average accuracy', data: timeline.map((t) => t.avgAccuracy), color: C.series[0] },
        { label: 'Worst accuracy', data: timeline.map((t) => t.worstAccuracy), color: C.series[3], dashed: true },
      ],
    });

    const hist = stats.accuracyHistogram || [];
    const bounds = [0, 5, 10, 20, 30, 50, 75, 100, 200, 500];
    PMChart.bars(document.querySelector('#chart-hist'), {
      labels: hist.map((b) => {
        if (b.from === 'none') return 'no fix';
        const index = bounds.indexOf(b.from);
        const next = bounds[index + 1];
        return next ? b.from + '-' + next + ' m' : b.from + '+ m';
      }),
      values: hist.map((b) => b.count),
      color: C.in,
      yTitle: 'snapshots',
      unit: 'snapshots',
    });

    const devices = Object.entries(stats.deviceSplit || {});
    PMChart.bars(document.querySelector('#chart-device'), {
      labels: devices.map(([k]) => k),
      values: devices.map(([, v]) => v),
      color: C.series[1],
      horizontal: true,
      unit: 'snapshots',
    });

    const sites = (stats.topSites || []).filter((s) => s.siteId !== null);
    PMChart.groupedBars(document.querySelector('#chart-sites'), {
      labels: sites.map((s) => 'Site ' + s.siteId),
      horizontal: true,
      datasets: [
        { label: 'Inside fence', data: sites.map((s) => s.inside), color: C.in },
        { label: 'Outside fence', data: sites.map((s) => s.outside), color: C.out },
      ],
    });
  }

  function renderUserTable(perUser) {
    const host = document.querySelector('#user-table');
    host.innerHTML = '';
    if (!perUser.length) {
      host.append(el('div', { class: 'empty', text: 'No snapshots in this range.' }));
      return;
    }
    const maxSnapshots = Math.max(...perUser.map((u) => u.snapshots));
    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>User</th><th class="num">Snapshots</th><th>Inside / outside</th><th class="num">Avg accuracy</th><th class="num">Worst</th><th class="num">Min battery</th><th>Last seen</th></tr></thead>';
    const body = el('tbody');
    for (const u of perUser) {
      const total = u.inside + u.outside || 1;
      body.append(
        el('tr', {
          class: 'clickable',
          title: 'Open this user',
          onclick: (event) =>
            PM.openRow('/user.html?userId=' + (u.userId === null ? 'anonymous' : u.userId), event),
          html:
            '<td><div class="person"><div class="avatar">' +
            esc(fmt.initials(u.name)) +
            '</div><div class="person-main"><div class="person-name">' +
            esc(u.name) +
            '</div><div class="person-sub">' +
            (u.userId === null ? 'no session' : 'id ' + u.userId) +
            (u.offline ? ' · ' + u.offline + ' offline pings' : '') +
            '</div></div></div></td>' +
            '<td class="num">' +
            fmt.int(u.snapshots) +
            ' ' +
            PM.meter(u.snapshots, maxSnapshots, C.series[6]) +
            '</td>' +
            '<td><span style="font-variant-numeric:tabular-nums">' +
            fmt.int(u.inside) +
            ' / ' +
            fmt.int(u.outside) +
            '</span> ' +
            PM.meter(u.inside, total, C.in) +
            '</td>' +
            '<td class="num">' +
            fmt.accuracy(u.avgAccuracy) +
            '</td><td class="num">' +
            fmt.accuracy(u.worstAccuracy) +
            '</td><td class="num">' +
            (u.minBattery === null ? '--' : u.minBattery + '%') +
            '</td><td>' +
            fmt.ago(u.lastSeenAt) +
            '</td>',
        })
      );
    }
    table.append(body);
    host.append(table);
  }

  function renderChecks(stats) {
    const g = stats.geofenceChecks;
    const host = document.querySelector('#check-tiles');
    host.innerHTML = '';
    if (!g) {
      host.append(el('div', { class: 'empty', text: stats.geofenceChecksUnavailable || 'No geofence checks available.' }));
      return;
    }
    host.append(
      tile('Checks made', fmt.int(g.total), { note: g.users + ' user(s) across ' + g.sites + ' site(s)' }),
      tile('Compliance', fmt.pct(g.complianceRate), {
        tone: g.complianceRate !== null && g.complianceRate < 95 ? 'warning' : 'good',
        note: fmt.int(g.actualOutside) + ' failed the raw geometry',
      }),
      tile('Saved by accuracy grace', fmt.int(g.grace), {
        tone: g.grace ? 'warning' : undefined,
        note: 'avg padding ' + fmt.metres(g.avgRadiusPadding),
      }),
      tile('Auto clock-outs', fmt.int(g.clockOuts), { tone: g.clockOuts ? 'serious' : undefined, note: 'triggered by leaving a fence' }),
      tile('Unmapped clock-ins', fmt.int(g.unmapped), { note: 'no site geofence attached' }),
      tile('Check accuracy', fmt.accuracy(g.avgAccuracy), { note: 'best ' + fmt.accuracy(g.bestAccuracy) + ' · worst ' + fmt.accuracy(g.worstAccuracy) })
    );

    const timeline = PM.padBuckets(stats.geofenceTimeline || [], stats.granularity, {
      zero: ['total', 'within', 'outside', 'clockOuts'],
      nulls: ['avgAccuracy'],
    });
    PMChart.stackedTime(document.querySelector('#chart-checks'), {
      labels: timeline.map((t) => fmt.dayTime(t.at)),
      yTitle: 'checks',
      datasets: [
        { label: 'Passed', data: timeline.map((t) => t.within), color: C.in },
        { label: 'Failed geometry', data: timeline.map((t) => t.outside), color: C.out },
        { label: 'Auto clock-outs', data: timeline.map((t) => t.clockOuts), color: C.series[3] },
      ],
    });
  }
})();
