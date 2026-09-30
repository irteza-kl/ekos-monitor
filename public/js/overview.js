/*
 * Overview: what needs attention now.
 *
 * The problems, and the current state they are measured against - nothing
 * else. It used to carry everything, fifteen blocks deep; the workforce
 * sections moved to Attendance, the charts to Trends, and the map and the
 * validation-call card were dropped because the Live Map and Geofence Checks
 * pages already are those things, with more in them.
 */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const { tile, panelFailed } = PMPanel;

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
      { kind: 'multi', key: 'jobSiteId', label: 'Site', options: PM.optionsFrom(meta.jobSiteIds || [], 'id', 'label', 'snapshots') },
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
      // Who these people are and where they are standing live on their own
      // pages now; the links keep them one click from the numbers.
      el('div', { class: 'section-title has-link' }, [
        el('span', { text: 'Current state' }),
        el('div', { class: 'spacer' }),
        el('a', { class: 'section-link', href: PM.withWindow('/attendance.html'), text: 'Attendance ↗' }),
        el('a', { class: 'section-link', href: PM.withWindow('/map.html'), text: 'Live map ↗' }),
      ]),
      el('div', { class: 'tiles', id: 'tiles' }),
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
          el('a', { class: 'btn btn-sm', href: PM.withWindow('/users.html'), text: 'All users ↗' }),
        ]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'worst-users' })]),
      ])
    );

    await load();
    window.addEventListener('pm:filters', load);
    window.addEventListener('pm:refresh', load);
  });

  /**
   * Bumped by every load, so a response that returns after a newer load has
   * started - a filter changed while it was out - is dropped instead of
   * overwriting the newer answer.
   */
  let loadSeq = 0;

  async function load() {
    const seq = ++loadSeq;
    PM.showSkeleton({
      '#issue-summary': 'tiles:4',
      '#issues-people': 'table:5x2',
      '#issues-app': 'table:5x2',
      '#worst-users': 'table:5x3',
      '#tiles': 'tiles:8',
    });
    const qs = queryString();
    // allSettled, not all: these are independent questions, and Promise.all
    // threw away the good answer whenever the other failed - so one slow
    // aggregation timing out blanked the entire page.
    // compare=1 adds the same detection over the previous window of equal
    // length, so every count can say which way it is moving.
    const [stats, problems] = (
      await Promise.allSettled([api('/api/stats?' + qs), api('/api/issues?' + qs + '&compare=1')])
    ).map((r) => (r.status === 'fulfilled' ? r.value : null));
    if (seq !== loadSeq) return;

    const failed = [];
    if (!problems) failed.push('problem detection');
    if (!stats) failed.push('statistics');

    if (problems) {
      renderIssues(problems);
      renderWorstUsers(problems);
    } else {
      panelFailed('#issue-summary', '#issues-people', '#issues-app', '#worst-users');
    }
    if (stats) {
      renderTiles(stats);
    } else {
      panelFailed('#tiles');
    }
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
        href: PM.withWindow('/users.html'),
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
        href: PM.withWindow('/users.html'),
      }),
      // To Attendance, which says who they are and whether each device is
      // still reporting - the question this number always raises next.
      tile('On the clock', fmt.int(d.clockedIn), { note: d.clockedOut + ' clocked out', href: PM.withWindow('/attendance.html') }),
      tile('Inside a fence', fmt.int(d.insideGeofence), {
        tone: 'good',
        note: d.geofenceUnknown ? d.geofenceUnknown + ' with no fence flag' : 'device-reported',
        href: PM.withWindow('/users.html?insideGeofence=true'),
      }),
      tile('Outside a fence', fmt.int(d.outsideGeofence), {
        tone: d.outsideGeofence ? 'critical' : undefined,
        note: d.outsideButClockedIn ? d.outsideButClockedIn + ' of them still clocked in' : 'none clocked in outside',
        href: PM.withWindow('/users.html?insideGeofence=false'),
      }),
      tile('Median accuracy', fmt.accuracy(d.medianAccuracy), {
        note: 'avg ' + fmt.accuracy(d.avgAccuracy) + ' · worst ' + fmt.accuracy(d.worstAccuracy),
        tone: d.medianAccuracy > 50 ? 'warning' : undefined,
      }),
      tile('Poor fixes', fmt.int(d.poorAccuracy), {
        note: 'devices over ±50 m right now',
        tone: d.poorAccuracy ? 'serious' : undefined,
        href: PM.withWindow('/users.html?accuracyMin=50'),
      }),
      tile('Low battery', fmt.int(d.lowBattery), {
        note: 'at or under 20%',
        tone: d.lowBattery ? 'warning' : undefined,
        href: PM.withWindow('/users.html?batteryMax=20'),
      }),
      tile('Offline devices', fmt.int(d.offline), {
        note: 'no connectivity on last ping',
        tone: d.offline ? 'critical' : undefined,
        href: PM.withWindow('/users.html?connected=false'),
      }),
      tile('Permission gaps', fmt.int(d.permissionGaps), {
        note: d.locationBackgroundMissing + ' missing background location',
        tone: d.locationBackgroundMissing ? 'critical' : d.permissionGaps ? 'warning' : undefined,
        href: PM.withWindow('/users.html?permissionMissing=LOCATION_BACKGROUND'),
      }),
      tile('Face checks pending', fmt.int(d.facialPending), { note: 'required but not completed' })
    );
  }

})();
