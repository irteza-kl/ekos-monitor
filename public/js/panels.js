/*
 * Tiles and panel states shared by the Overview, Attendance and Trends pages.
 *
 * These were the Overview's own until it was split into three pages, and three
 * copies of the tile would drift apart the first time one of them changed.
 */
(function () {
  'use strict';
  const { el } = PM;

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

  window.PMPanel = { tile, panelFailed };
})();
