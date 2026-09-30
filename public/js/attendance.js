/*
 * Attendance: who is working, when they clocked in, and how long they were on
 * site. Split out of the Overview, which kept the problems and the current
 * state; these three sections answer the workforce questions instead.
 */
(function () {
  'use strict';
  const { el, fmt, api, queryString, esc } = PM;
  const { tile, panelFailed } = PMPanel;

  PM.boot('attendance.html', async ({ root, meta }) => {
    // The GPS-accuracy and inside-fence filters are left off: they describe one
    // heartbeat, not a shift, and the clock-ins cannot honour them.
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
      { kind: 'tri', key: 'clockedIn', label: 'Clocked in', yes: 'On the clock', no: 'Off the clock' },
      { kind: 'text', key: 'search', label: 'Search', placeholder: 'name, email, employee ref' },
    ]);

    root.append(
      el('div', { class: 'section-title', text: 'On the clock' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Who is working, and whether their device agrees' }),
          el('span', { class: 'sub', id: 'now-sub' }),
          el('div', { class: 'spacer' }),
          el('a', { class: 'btn btn-sm', href: PM.withWindow('/users.html'), text: 'All users ↗' }),
        ]),
        el('div', { class: 'card-body' }, [el('div', { class: 'tiles tiles-4', id: 'now-tiles' })]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'now-table' })]),
      ]),
      el('div', { class: 'section-title', text: 'Clock-ins' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Who clocked in, when, and how the shift ended' }),
          el('span', { class: 'sub', id: 'clockin-sub' }),
          el('div', { class: 'spacer' }),
          el('button', {
            class: 'btn btn-sm',
            text: '↓ CSV',
            onclick: () => window.open('/api/clockins.csv?' + queryString(), '_blank'),
          }),
        ]),
        el('div', { class: 'card-body' }, [el('div', { class: 'tiles', id: 'clockin-tiles' })]),
        el('div', { class: 'card-body tight' }, [el('div', { class: 'table-scroll', id: 'clockin-table' })]),
        el('div', { class: 'card-body' }, [el('div', { class: 'pager', id: 'clockin-pager' })]),
      ]),
      el('div', { class: 'section-title', text: 'Time on site' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'How long people were actually inside a fence' }),
          el('span', { class: 'sub', id: 'fence-sub' }),
          el('div', { class: 'spacer' }),
          el('button', {
            class: 'btn btn-sm',
            text: '↓ CSV',
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
      ])
    );

    await load();
    // New filters are a new answer, so they start at its first page; a refresh
    // is the same question again and keeps the page being read.
    window.addEventListener('pm:filters', () => {
      clockInPage = 1;
      load();
    });
    window.addEventListener('pm:refresh', load);
  });

  /**
   * Bumped by every load. A response that comes back after a newer load has
   * started is dropped: without this, changing a filter while the previous
   * load was still out let the older answer land last and overwrite the new.
   */
  let loadSeq = 0;
  let pageSeq = 0;

  async function load() {
    const seq = ++loadSeq;
    pageSeq += 1; // and any page turn still in flight is now stale
    PM.showSkeleton({
      '#now-tiles': 'tiles:4',
      '#now-table': 'table:6x7',
      '#clockin-tiles': 'tiles:6',
      '#clockin-table': 'table:8x9',
      '#fence-tiles': 'tiles:4',
      '#fence-table': 'table:5x5',
    });
    const qs = queryString();
    // allSettled: three independent questions, and one slow aggregation must
    // not blank the other two.
    const [users, clockIns, fence] = (
      await Promise.allSettled([
        api('/api/users?' + qs + '&limit=200'),
        api(clockInsUrl(qs, clockInPage)),
        api('/api/fence-time?' + qs),
      ])
    ).map((r) => (r.status === 'fulfilled' ? r.value : null));
    if (seq !== loadSeq) return;

    const failed = [];
    if (users) {
      renderNow(users.rows);
    } else {
      failed.push('who is on the clock');
      panelFailed('#now-tiles', '#now-table');
    }
    if (clockIns) {
      // The server may have moved the page back if the answer shrank.
      clockInPage = Math.floor((clockIns.offset || 0) / CLOCKIN_PAGE_SIZE) + 1;
      renderClockIns(clockIns);
    } else {
      failed.push('clock-ins');
      panelFailed('#clockin-tiles', '#clockin-table');
      clearPager();
    }
    if (fence) {
      renderFenceTime(fence);
    } else {
      failed.push('time on site');
      panelFailed('#fence-tiles', '#fence-table');
    }

    const t = (clockIns && clockIns.totals) || null;
    PM.setSubtitle(
      t ? fmt.int(t.total) + ' clock-ins · ' + fmt.int(t.open) + ' still on the clock · ' + fmt.int(t.users) + ' people in range' : ''
    );
    if (failed.length) {
      PM.markStale('Could not load ' + failed.join(', ') + '. Everything else on this page is current.');
    } else {
      PM.markLoaded();
    }
  }

  /* ------------------------------------------------------ on the clock
     The Overview's tiles count how many people are clocked in. This says
     WHO, and - the part that matters - whether the claim is still true.

     "Clocked in" is a flag on a heartbeat, not a live fact. A device that
     dies mid-shift, or an app that never sends the clock-out, leaves a
     person flagged on the clock indefinitely. This store has one right now:
     clocked in yesterday afternoon, last heartbeat 21 hours ago, still
     counted in the total. Counting it is not wrong, but presenting it
     without the silence is, so the roster grades every row by how recently
     the device actually reported.

     Everything here comes from the newest heartbeat per person, as
     /api/users returns it - the same rows the Live Map is drawn from, so
     the two can never disagree. It is therefore scoped to the
     page`s time range like everything else, which the subtitle says out
     loud: narrow the range and people who have not reported inside it drop
     out of the roster entirely. */

  /** Minutes since the last heartbeat, and what that means. */
  const REPORTING = [
    { key: 'live', upTo: 5, label: 'reporting', tone: 'good' },
    { key: 'quiet', upTo: 60, label: 'quiet', tone: 'info' },
    { key: 'silent', upTo: Infinity, label: 'silent', tone: 'serious' },
  ];

  function reportingState(row) {
    const age = row.ageMinutes;
    if (age === null || age === undefined) return { key: 'unknown', label: 'no readable clock', tone: 'warning' };
    return REPORTING.find((r) => age < r.upTo);
  }

  function renderNow(users) {
    const host = document.querySelector('#now-table');
    const tiles = document.querySelector('#now-tiles');
    const sub = document.querySelector('#now-sub');
    if (!host || !tiles) return;
    host.innerHTML = '';
    tiles.innerHTML = '';

    const rows = (users || []).slice();
    if (!rows.length) {
      host.append(el('div', { class: 'empty', text: 'No device reported in this range.' }));
      if (sub) sub.textContent = '';
      return;
    }

    const onClock = rows.filter((r) => r.clockedIn);
    const live = rows.filter((r) => reportingState(r).key === 'live');
    const silentOnClock = onClock.filter((r) => reportingState(r).key === 'silent');
    const outside = onClock.filter((r) => r.isInsideGeofence === false || r.computedVerdict === 'out');
    const offClockButLive = live.filter((r) => !r.clockedIn);

    tiles.append(
      tile('On the clock', fmt.int(onClock.length), {
        note: onClock.length ? insideNote(onClock) : 'nobody is clocked in',
      }),
      tile('Reporting now', fmt.int(live.length), {
        note: 'a heartbeat in the last 5 minutes',
        tone: live.length ? undefined : 'warning',
      }),
      tile('On the clock but silent', fmt.int(silentOnClock.length), {
        note: silentOnClock.length ? 'flagged working, no heartbeat for over an hour' : 'every working device is reporting',
        tone: silentOnClock.length ? 'serious' : undefined,
      }),
      tile('Outside their fence', fmt.int(outside.length), {
        note: offClockButLive.length ? fmt.int(offClockButLive.length) + ' more reporting off the clock' : 'of the people on the clock',
        tone: outside.length ? 'warning' : undefined,
      })
    );

    if (sub) {
      // "in the last 3 hours" / "in all time" / "in 08 Sep 09:00 to now" -
      // rangeLabel returns the phrase without a preposition.
      sub.textContent =
        'newest heartbeat per person in ' + PM.rangeLabel() + ' · ' + fmt.int(rows.length) + ' device(s)';
    }

    // On the clock first, then the quietest - a working device that has gone
    // silent is the row somebody needs to see, so it sorts to the top of its
    // group rather than being buried by whoever reported most recently.
    rows.sort((a, b) => {
      if (!!b.clockedIn !== !!a.clockedIn) return b.clockedIn ? 1 : -1;
      return (b.ageMinutes || 0) - (a.ageMinutes || 0);
    });

    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>Person</th><th>Clock</th><th>Site</th><th>Fence</th><th>Last heartbeat</th>' +
      '<th class="num">Battery</th><th class="num">Accuracy</th></tr></thead>';
    const body = el('tbody');
    for (const r of rows) {
      const state = reportingState(r);
      body.append(
        el('tr', {
          class: 'clickable',
          title: 'Open this user',
          onclick: (event) =>
            PM.openRow('/user.html?userId=' + (r.userId === null ? 'anonymous' : r.userId), event),
          html:
            personCell(r) +
            '<td>' + clockCell(r) + '</td>' +
            '<td>' + siteCell(r) + '</td>' +
            '<td>' + fenceCell(r) + '</td>' +
            '<td><span class="badge badge-' + state.tone + '">' + esc(state.label) + '</span>' +
            '<div class="person-sub">' + esc(fmt.ago(r.capturedAt)) + '</div></td>' +
            '<td class="num">' + PM.batteryBadge(r.battery) + '</td>' +
            '<td class="num">' + PM.accuracyBadge(r.accuracyBand, r.accuracy) + '</td>',
        })
      );
    }
    table.append(body);
    host.append(table);
  }

  /** "3 of 5 inside their fence" - the shape of the shift in one line. */
  function insideNote(onClock) {
    const inside = onClock.filter((r) => r.isInsideGeofence === true).length;
    return inside + ' of ' + onClock.length + ' inside their fence';
  }

  function personCell(r) {
    return (
      '<td><div class="person"><div class="avatar">' +
      esc(fmt.initials(r.name)) +
      '</div><div class="person-main"><div class="person-name">' +
      esc(r.name || 'Unidentified device') +
      '</div><div class="person-sub">' +
      esc(r.employeeRef || r.tenantName || (r.userId === null ? 'no session' : 'id ' + r.userId)) +
      (r.offline ? ' · <span class="hint">offline</span>' : '') +
      '</div></div></div></td>'
    );
  }

  /**
   * On the clock, and for how long.
   *
   * The duration is measured from the clock-in on the time entry, not from
   * the heartbeat, so it keeps counting while a device is silent - which is
   * precisely the case worth seeing: "on the clock 22 h" beside "silent"
   * says the shift was never closed.
   */
  function clockCell(r) {
    if (!r.clockedIn) return '<span class="badge badge-neutral">off</span>';
    const since = r.timeEntry && r.timeEntry.clockIn;
    const minutes = since ? (Date.now() - new Date(since).getTime()) / 60000 : null;
    return (
      '<span class="badge badge-info">on</span>' +
      (minutes !== null && Number.isFinite(minutes)
        ? '<div class="person-sub" title="clocked in ' + esc(fmt.date(since)) + '">' +
          esc(fmt.duration(minutes)) + '</div>'
        : '')
    );
  }

  function siteCell(r) {
    const site = r.site;
    const name = site && (site.name || site.label);
    if (!name && r.jobSiteId == null) return '<span class="hint">not clocked into a site</span>';
    if (!name) return 'Site ' + r.jobSiteId;
    return (
      '<span title="' +
      esc([name, site.address].filter(Boolean).join(' - ')) +
      '">' +
      esc(name) +
      '</span>'
    );
  }

  /**
   * The verdict, and how far outside when it is outside.
   *
   * Nothing at all when there is no site to be inside or outside OF. The device
   * keeps its last geofence flag after a clock-out, so a row could otherwise
   * read "not clocked into a site" and "inside" side by side - a verdict about
   * a fence the row has just said it does not have.
   */
  function fenceCell(r) {
    const hasSite = !!(r.site || r.jobSiteId != null);
    if (!hasSite && !r.computedVerdict) {
      return '<span class="hint" title="the device still carries its last geofence flag, but it is not clocked into a site for that flag to be about">no fence to judge</span>';
    }
    const badge = PM.geofenceBadge(r.isInsideGeofence, r.computedVerdict, r.verdictReason);
    if (!r.relation) return badge;
    const d = r.relation.distanceFromBoundary;
    if (d === null || d === undefined) return badge;
    return (
      badge +
      '<div class="person-sub">' +
      esc(fmt.metres(Math.abs(d))) +
      (r.relation.inside ? ' inside the boundary' : ' outside · ' + esc(r.relation.compass || '')) +
      '</div>'
    );
  }

  /* ------------------------------------------------------------ clock-ins
     The roster above is each person's newest heartbeat, so it can say who is
     on the clock now and nothing about the shifts before. This is the history:
     one row per clock-in, from the time entry the heartbeats carry, closed by
     the shift trail sealed at clock-out.

     The time entry's own clockOut is null on every heartbeat in the store -
     heartbeats stop carrying the entry once somebody clocks out - so the
     clock-out column always says where its time came from, and says "not
     recorded" rather than inventing one. See server/lib/clockIns.js. */

  /**
   * Paged on the server, which computes the answer once per filter set and
   * caches it, so turning a page is a slice rather than another aggregation.
   * The page survives an auto-refresh and resets when the filters change.
   */
  const CLOCKIN_PAGE_SIZE = 50;
  let clockInPage = 1;

  const CLOCKIN_FILTER_LABELS = { accuracyBand: 'GPS accuracy', insideGeofence: 'Inside fence', where: 'where clause' };

  function renderClockIns(data) {
    const host = document.querySelector('#clockin-table');
    const tiles = document.querySelector('#clockin-tiles');
    const sub = document.querySelector('#clockin-sub');
    if (!host || !tiles) return;
    host.innerHTML = '';
    tiles.innerHTML = '';

    const t = data.totals || {};
    const limits = data.thresholds || {};
    tiles.append(
      tile('Clock-ins', fmt.int(t.total), {
        note: fmt.int(t.users) + ' people · ' + fmt.int(t.sites) + ' site(s)',
      }),
      tile('Still on the clock', fmt.int(t.open), {
        note: t.openSilent
          ? t.openSilent + ' with no heartbeat for over ' + (limits.silentMinutes === 60 ? 'an hour' : fmt.duration(limits.silentMinutes))
          : t.open
            ? 'every open shift is reporting'
            : 'every clock-in in range has ended',
        tone: t.openSilent ? 'serious' : undefined,
      }),
      tile('Clock-out not recorded', fmt.int(t.unclosed), {
        note: fmt.int(t.closedByTrail) + ' closed by a shift trail · ' + fmt.int(t.closedByHeartbeat) + ' by a heartbeat',
        tone: t.unclosed ? 'warning' : undefined,
      }),
      tile('Offline clock-ins', fmt.int(t.offlineClockIns), {
        note: 'held on the phone and sent later - never checked by the server',
        tone: t.offlineClockIns ? 'warning' : undefined,
      }),
      tile('Outside the fence at clock-in', fmt.int(t.outsideAtClockIn), {
        note:
          fmt.int(t.insideAtClockIn) + ' inside · ' + fmt.int(t.uncertainAtClockIn) + ' uncertain, of ' +
          fmt.int(t.judgedAtClockIn) + ' with a fix and a fence',
        tone: t.outsideAtClockIn ? 'warning' : undefined,
      }),
      tile('Late for their shift', fmt.int(t.late), {
        note: t.scheduled
          ? 'of ' + fmt.int(t.scheduled) + ' with a schedule' +
            (t.afterShiftEnded ? ' · ' + t.afterShiftEnded + ' after it had ended' : '')
          : 'no clock-in in range carries a schedule',
        tone: t.late ? 'warning' : undefined,
      })
    );

    if (sub) {
      const skipped = (data.notApplied || []).map((k) => CLOCKIN_FILTER_LABELS[k] || k);
      sub.textContent =
        'time entries on heartbeats, closed by shift trails, in ' + PM.rangeLabel() +
        (skipped.length ? ' · the ' + skipped.join(' and ') + ' filter does not apply to clock-ins' : '') +
        // Only trail-only clock-ins can be missing: each entry's own trail is
        // fetched regardless of the cap.
        (data.trailsCapped ? ' · over 500 shift trails in range, so clock-ins known only from a trail may be missing - narrow the range' : '');
    }

    renderClockInPage(data);
  }

  /** Fetches one page of the same answer and draws it. */
  async function showClockInPage(page) {
    const seq = loadSeq;
    const mine = ++pageSeq;
    const host = document.querySelector('#clockin-table');
    PM.showSkeleton({ '#clockin-table': 'table:8x9' });
    let data = null;
    try {
      data = await api(clockInsUrl(queryString(), page));
    } catch (err) {
      data = null;
    }
    // Dropped if the page reloaded, or another page was asked for, meanwhile.
    if (seq !== loadSeq || mine !== pageSeq) return;
    if (!data) {
      panelFailed('#clockin-table');
      clearPager();
      return;
    }
    clockInPage = page;
    renderClockInPage(data);
    if (host) host.closest('.card').scrollIntoView({ block: 'start' });
  }

  function clearPager() {
    const pager = document.querySelector('#clockin-pager');
    if (pager) pager.innerHTML = '';
  }

  function clockInsUrl(qs, page) {
    return '/api/clockins?' + qs + '&limit=' + CLOCKIN_PAGE_SIZE + '&offset=' + (page - 1) * CLOCKIN_PAGE_SIZE;
  }

  /** One page of the clock-ins, latest first, and the pager under it. */
  function renderClockInPage(data) {
    const host = document.querySelector('#clockin-table');
    const pager = document.querySelector('#clockin-pager');
    if (!host) return;
    host.classList.remove('is-loading');
    host.innerHTML = '';
    if (pager) pager.innerHTML = '';

    const rows = data.rows || [];
    const total = data.total || 0;
    const limits = data.thresholds || {};
    if (data.unavailable) {
      host.append(el('div', { class: 'empty', text: data.unavailable }));
      return;
    }
    if (!total) {
      host.append(el('div', { class: 'empty', text: 'Nobody clocked in during ' + PM.rangeLabel() + '.' }));
      return;
    }
    const pages = Math.max(1, Math.ceil(total / CLOCKIN_PAGE_SIZE));
    const start = data.offset || 0;

    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>Person</th><th>Clocked in</th><th>Site</th><th>Clocked out</th><th class="num">Duration</th>' +
      '<th>Schedule</th><th>Fence at clock-in</th><th>Face checks</th><th>Shift trail</th></tr></thead>';
    const body = el('tbody');
    for (const r of rows) {
      const person = { ...r, name: r.name || (r.userId != null ? 'User ' + r.userId : null) };
      body.append(
        el('tr', {
          class: r.userId != null ? 'clickable' : '',
          title: r.userId != null ? 'Open this user' : '',
          onclick: (event) => {
            // The trail link is its own destination.
            if (event.target.closest('a') || r.userId == null) return;
            PM.openRow('/user.html?userId=' + r.userId, event);
          },
          html:
            personCell(person) +
            '<td>' + clockInCell(r) + '</td>' +
            // Short on purpose: this table is nine columns wide, and the
            // roster's longer wording wrapped to four lines here.
            '<td>' + (r.siteId == null && !r.site ? '<span class="hint" title="not clocked into a site">no site</span>' : esc(PM.siteName(r.site, r.siteId))) + '</td>' +
            '<td>' + clockOutCell(r, limits) + '</td>' +
            '<td class="num">' + durationCell(r) + '</td>' +
            '<td>' + scheduleCell(r, limits) + '</td>' +
            '<td>' + fenceAtClockInCell(r) + '</td>' +
            '<td>' + faceCell(r) + '</td>' +
            '<td>' + trailCell(r) + '</td>',
        })
      );
    }
    table.append(body);
    host.append(table);

    if (!pager) return;
    const page = Math.floor(start / CLOCKIN_PAGE_SIZE) + 1;
    pager.append(
      el('span', { text: fmt.int(start + 1) + '–' + fmt.int(start + rows.length) + ' of ' + fmt.int(total) }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', text: '← Newer', disabled: page <= 1 ? 'disabled' : null, onclick: () => showClockInPage(page - 1) }),
      el('span', { text: 'Page ' + page + ' of ' + pages }),
      el('button', { class: 'btn btn-sm', text: 'Older →', disabled: page >= pages ? 'disabled' : null, onclick: () => showClockInPage(page + 1) })
    );
  }

  /** The clock-in in the worker's timezone, and how it reached the server. */
  function clockInCell(r) {
    const title =
      fmt.bothZones(r.clockIn, r.timezone) +
      (r.fenceArrivalAt ? '\ngeofence clock-in ' + fmt.dateIn(r.fenceArrivalAt, r.timezone) : '') +
      (r.timeEntryId != null ? '\ntime entry ' + r.timeEntryId : '');
    const network = r.offlineClockIn
      ? '<span class="badge badge-warning" title="taken offline: the time and place are what the phone believed">offline</span>'
      : r.clockInNetwork
        ? '<span class="hint">' + esc(r.clockInNetwork.toLowerCase()) + '</span>'
        : '';
    return (
      '<span style="white-space:nowrap" title="' + esc(title) + '">' + esc(fmt.dayTimeIn(r.clockIn, r.timezone)) + '</span>' +
      (network ? '<div class="person-sub">' + network + '</div>' : '')
    );
  }

  const CLOCKOUT_SOURCES = {
    trail: 'from the shift trail',
    timeEntry: 'from the time entry',
    heartbeat: 'seen on a heartbeat',
  };

  function clockOutCell(r, limits) {
    if (r.state === 'open') {
      const silent = r.silentMinutes !== null && r.silentMinutes >= (limits.silentMinutes || 60);
      return (
        '<span class="badge badge-' + (silent ? 'serious' : 'info') + '">' + (silent ? 'on the clock · silent' : 'on the clock') + '</span>' +
        (r.lastOnClockAt ? '<div class="person-sub">last heartbeat ' + esc(fmt.ago(r.lastOnClockAt)) + '</div>' : '')
      );
    }
    if (r.state === 'unclosed') {
      return (
        '<span class="badge badge-warning" title="the shift ended, and nothing recorded when">not recorded</span>' +
        '<div class="person-sub">' +
        (r.lastOnClockAt
          ? 'last on the clock ' + esc(fmt.dayTimeIn(r.lastOnClockAt, r.timezone))
          : 'never seen on the clock by a heartbeat') +
        '</div>'
      );
    }
    // A clock-out read off a heartbeat happened between the last on-the-clock
    // heartbeat and this one, so it says how wide that gap was.
    const within =
      r.clockOutSource === 'heartbeat' && r.clockOutWithinMinutes !== null && r.clockOutWithinMinutes !== undefined
        ? ' · within ' + fmt.duration(r.clockOutWithinMinutes)
        : '';
    return (
      '<span style="white-space:nowrap" title="' + esc(fmt.bothZones(r.clockOut, r.timezone)) + '">' + esc(fmt.dayTimeIn(r.clockOut, r.timezone)) + '</span>' +
      '<div class="person-sub">' + esc((CLOCKOUT_SOURCES[r.clockOutSource] || '') + within) + '</div>'
    );
  }

  function durationCell(r) {
    if (r.durationMinutes === null || r.durationMinutes === undefined) return '--';
    if (r.state === 'open') return esc(fmt.duration(r.durationMinutes)) + '<div class="person-sub">and counting</div>';
    if (r.durationIsFloor) {
      return '<span title="to the last heartbeat that had them on the clock">≥ ' + esc(fmt.duration(r.durationMinutes)) + '</span>';
    }
    return esc(fmt.duration(r.durationMinutes));
  }

  /** The scheduled shift, and how far from its start the clock-in landed. */
  function scheduleCell(r, limits) {
    const s = r.schedule;
    if (!s) return '<span class="hint">none</span>';
    const title = s.start
      ? 'scheduled ' + fmt.dayTimeIn(s.start, r.timezone) + (s.end ? ' to ' + fmt.timeIn(s.end, r.timezone) : '')
      : '';
    let when = '';
    if (s.afterEnd) {
      when = '<span class="badge badge-warning">after the shift ended</span>';
    } else if (s.lateMinutes !== null) {
      const grace = limits.lateGraceMinutes || 5;
      if (s.lateMinutes > grace) when = '<span class="badge badge-warning">' + esc(fmt.duration(s.lateMinutes)) + ' late</span>';
      else if (s.lateMinutes < -grace) when = '<span class="hint">' + esc(fmt.duration(-s.lateMinutes)) + ' early</span>';
      else when = '<span class="badge badge-good">on time</span>';
    }
    return (
      '<span title="' + esc(title) + '">' + esc(s.name || 'Scheduled') + '</span>' +
      (when ? '<div class="person-sub">' + when + '</div>' : '')
    );
  }

  /**
   * Where the device was on its first fix after clocking in.
   *
   * A fix long after the clock-in says where somebody went, not where they
   * clocked in, so it is shown as that rather than given a verdict.
   */
  function fenceAtClockInCell(r) {
    const a = r.atClockIn || {};
    if (!a.location) return '<span class="hint">no fix after clocking in</span>';
    if (a.stale) {
      return '<span class="hint" title="' + esc(fmt.bothZones(a.at, r.timezone)) + '">first fix ' + esc(fmt.duration(a.delayMinutes)) + ' later</span>';
    }
    if (!r.site || !r.site.fence) {
      return '<span class="hint">no fence to judge</span>' + '<div class="person-sub">' + PM.accuracyBadge(a.accuracyBand, a.accuracy) + '</div>';
    }
    const d = a.distanceFromBoundary;
    const margin =
      d === null || d === undefined ? '' : fmt.metres(Math.abs(d)) + (d <= 0 ? ' inside' : ' outside' + (a.compass ? ' · ' + a.compass : ''));
    return (
      PM.geofenceBadge(a.deviceInside, a.verdict, a.verdictReason) +
      '<div class="person-sub" title="' + esc((a.source === 'trail' ? 'first trail fix' : 'first heartbeat') + ' ' + fmt.duration(a.delayMinutes) + ' after clocking in') + '">' +
      esc(margin) + (margin ? ' · ' : '') + esc(fmt.accuracy(a.accuracy)) +
      '</div>'
    );
  }

  function faceCell(r) {
    const f = r.facial || {};
    if (!f.required) return '<span class="hint">not required</span>';
    const behind = (f.completed || 0) < f.required;
    return '<span class="badge badge-' + (behind ? 'warning' : 'good') + '">' + fmt.int(f.completed || 0) + ' of ' + fmt.int(f.required) + '</span>';
  }

  function trailCell(r) {
    if (!r.trail) return '<span class="hint">' + (r.state === 'open' ? 'not sealed yet' : 'none') + '</span>';
    const href = PM.withWindow('/shift-trails.html?search=' + encodeURIComponent(r.trail.shiftKey || ''));
    const bits = [
      r.trail.coverage === null ? null : fmt.pct(r.trail.coverage, 0) + ' located',
      r.trail.runtimeStarts ? r.trail.runtimeStarts + ' restart' + (r.trail.runtimeStarts === 1 ? '' : 's') : null,
    ].filter(Boolean);
    return (
      '<a href="' + esc(href) + '" title="Open this shift">' + esc(bits[0] || 'open') + '</a>' +
      (bits[1] || r.timeEntryId === null
        ? '<div class="person-sub">' + esc([bits[1], r.timeEntryId === null ? 'trail only' : null].filter(Boolean).join(' · ')) + '</div>'
        : '')
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
  function renderFenceTime(fence) {
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
      // "person-time" is load-bearing: these totals are summed across people,
      // so eight people watched for a day gives more than 24h and would
      // otherwise read as impossible.
      sub.textContent = t.people + ' people · ' + fmt.int(t.visits) + ' crossings · totals are person-time';
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
})();
