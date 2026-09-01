/* ==========================================================================
   Chart factories. Chart.js is vendored locally (public/vendor/chart.umd.js).
   Rules applied here so every page inherits them:
     - one y-axis per chart, never two scales
     - stacked segments carry a 2px surface ring, so fills never touch
     - 4px rounded data-ends on the outermost stack segment only
     - 2px lines, >=8px hover targets, recessive grid, tabular axis ticks
     - a legend whenever there are 2+ series; text stays in ink tokens
   ========================================================================== */
window.PMChart = (function () {
  'use strict';

  const C = window.PM.colors;
  const registry = new Map();

  /**
   * Re-reads the palette out of the CSS variables and pushes it into Chart.js
   * defaults. Called at load and again on every theme switch (core.js), because
   * defaults are copied values rather than live references.
   */
  function applyTheme() {
    if (!window.Chart) return;
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = C.muted;
    Chart.defaults.borderColor = C.grid;
    Chart.defaults.animation = { duration: 220 };
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.plugins.legend.display = false;
    Chart.defaults.plugins.tooltip = {
      ...Chart.defaults.plugins.tooltip,
      backgroundColor: C.surface2,
      borderColor: C.border,
      borderWidth: 1,
      titleColor: C.ink,
      bodyColor: C.ink2,
      padding: 10,
      cornerRadius: 6,
      displayColors: true,
      boxWidth: 9,
      boxHeight: 9,
      boxPadding: 4,
      usePointStyle: true,
    };
  }

  applyTheme();

  /** One chart per canvas: replacing re-uses the slot instead of leaking. */
  function mount(canvas, config) {
    if (!canvas) return null;
    const key = canvas;
    if (registry.has(key)) {
      registry.get(key).destroy();
      registry.delete(key);
    }
    const chart = new Chart(canvas, config);
    registry.set(key, chart);
    return chart;
  }

  function destroyAll() {
    for (const chart of registry.values()) chart.destroy();
    registry.clear();
  }

  const gridScale = (extra) => ({
    grid: { color: C.grid, drawTicks: false, drawBorder: false },
    border: { display: false },
    ticks: { color: C.muted, padding: 6, ...(extra || {}) },
  });

  /**
   * Stacked counts over time. Segments are separated by a 2px surface ring and
   * only the top dataset gets rounded ends, so the stack reads as one column.
   */
  function stackedTime(canvas, { labels, datasets, yTitle }) {
    const last = datasets.length - 1;
    return mount(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: datasets.map((d, i) => ({
          label: d.label,
          data: d.data,
          backgroundColor: d.color,
          borderColor: C.surface,
          borderWidth: { top: 2, right: 1, bottom: 0, left: 1 },
          borderSkipped: false,
          borderRadius: i === last ? { topLeft: 4, topRight: 4 } : 0,
          barPercentage: 0.98,
          categoryPercentage: 0.96,
        })),
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, ...gridScale({ maxRotation: 0, autoSkipPadding: 18 }), grid: { display: false } },
          y: {
            stacked: true,
            beginAtZero: true,
            ...gridScale(),
            title: yTitle ? { display: true, text: yTitle, color: C.muted } : undefined,
          },
        },
        plugins: {
          tooltip: {
            callbacks: {
              footer: (items) => {
                const total = items.reduce((a, i) => a + (i.parsed.y || 0), 0);
                return 'total  ' + total.toLocaleString();
              },
            },
          },
        },
      },
    });
  }

  /** Lines over time. 2px strokes, no fill, one shared y-axis. */
  function lineTime(canvas, { labels, series, yTitle, beginAtZero }) {
    return mount(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: series.map((s) => ({
          label: s.label,
          data: s.data,
          borderColor: s.color,
          backgroundColor: s.color,
          borderWidth: 2,
          borderDash: s.dashed ? [4, 3] : undefined,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHitRadius: 12,
          tension: 0.25,
          spanGaps: true,
          fill: false,
        })),
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ...gridScale({ maxRotation: 0, autoSkipPadding: 18 }), grid: { display: false } },
          y: {
            beginAtZero: beginAtZero !== false,
            ...gridScale(),
            title: yTitle ? { display: true, text: yTitle, color: C.muted } : undefined,
          },
        },
      },
    });
  }

  /** Single-series bars (histogram or ranked categories). */
  function bars(canvas, { labels, values, color, horizontal, yTitle, unit }) {
    return mount(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: yTitle || 'value',
            data: values,
            backgroundColor: color || C.in,
            borderColor: C.surface,
            borderWidth: 2,
            borderSkipped: false,
            borderRadius: horizontal ? { topRight: 4, bottomRight: 4 } : { topLeft: 4, topRight: 4 },
            barPercentage: 0.9,
            categoryPercentage: 0.86,
          },
        ],
      },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: horizontal
            ? { beginAtZero: true, ...gridScale() }
            : { ...gridScale({ maxRotation: 0, autoSkipPadding: 12 }), grid: { display: false } },
          y: horizontal
            ? { ...gridScale(), grid: { display: false } }
            : { beginAtZero: true, ...gridScale(), title: yTitle ? { display: true, text: yTitle, color: C.muted } : undefined },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (item) => {
                const v = horizontal ? item.parsed.x : item.parsed.y;
                return ' ' + v.toLocaleString() + (unit ? ' ' + unit : '');
              },
            },
          },
        },
      },
    });
  }

  /** Grouped bars, e.g. per-user inside vs outside. */
  function groupedBars(canvas, { labels, datasets, horizontal }) {
    return mount(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: datasets.map((d) => ({
          label: d.label,
          data: d.data,
          backgroundColor: d.color,
          borderColor: C.surface,
          borderWidth: 2,
          borderSkipped: false,
          borderRadius: horizontal ? { topRight: 4, bottomRight: 4 } : { topLeft: 4, topRight: 4 },
          barPercentage: 0.92,
          categoryPercentage: 0.78,
        })),
      },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: horizontal ? { beginAtZero: true, ...gridScale() } : { ...gridScale(), grid: { display: false } },
          y: horizontal ? { ...gridScale(), grid: { display: false } } : { beginAtZero: true, ...gridScale() },
        },
      },
    });
  }

  /**
   * Scatter of accuracy against distance from the fence boundary. The boundary
   * itself is drawn as an annotation line at x = 0.
   */
  function scatter(canvas, { points, xTitle, yTitle }) {
    const boundaryLine = {
      id: 'boundary',
      afterDatasetsDraw(chart) {
        const scale = chart.scales.x;
        const x = scale.getPixelForValue(0);
        // Only mark the boundary when zero is actually on screen; otherwise the
        // line lands on the axis and reads as data.
        if (!Number.isFinite(x) || scale.min > 0 || scale.max < 0) return;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = C.ink2;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.muted;
        ctx.font = '10px system-ui';
        ctx.fillText('fence boundary', x + 5, chartArea.top + 11);
        ctx.restore();
      },
    };

    return mount(canvas, {
      type: 'scatter',
      data: {
        datasets: (points || []).map((group) => ({
          label: group.label,
          data: group.data,
          backgroundColor: group.color,
          borderColor: C.surface,
          borderWidth: 1.5,
          pointRadius: 4.5,
          pointHoverRadius: 7,
          pointHitRadius: 10,
        })),
      },
      options: {
        scales: {
          x: { ...gridScale(), title: { display: !!xTitle, text: xTitle, color: C.muted } },
          y: { ...gridScale(), beginAtZero: true, title: { display: !!yTitle, text: yTitle, color: C.muted } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = item.raw;
                return [
                  ' ' + (p.label || item.dataset.label),
                  ' distance ' + p.x.toFixed(1) + ' m from boundary',
                  ' accuracy ±' + p.y.toFixed(1) + ' m',
                ];
              },
            },
          },
        },
      },
      plugins: [boundaryLine],
    });
  }

  /** Legend markup - identity is never colour alone, every swatch has a label. */
  function legend(items) {
    return (
      '<div class="legend">' +
      items
        .map((i) => '<span><i style="background:' + i.color + '"></i>' + window.PM.esc(i.label) + '</span>')
        .join('') +
      '</div>'
    );
  }

  return { mount, destroyAll, applyTheme, stackedTime, lineTime, bars, groupedBars, scatter, legend };
})();
