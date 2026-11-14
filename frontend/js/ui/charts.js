// Chart.js wrappers styled for MONICA. Charts plot observed values only: no interpolation,
// smoothing or synthetic points. Line segments are broken at gaps (spanGaps: false).
import { fmtShort, fmtDateTime } from './format.js';

const Chart = window.Chart;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const SERIES = () => ({
  s1: css('--series-1'), s2: css('--series-2'), s3: css('--series-3'),
  baseline: css('--series-baseline'), grid: css('--chart-grid'), axis: css('--chart-axis'),
  text: css('--text-2'), surface: css('--surface'), grey: css('--grey'),
});

export function chartsAvailable() {
  return typeof Chart === 'function';
}

function applyDefaults() {
  if (!chartsAvailable() || Chart.__monica) return;
  const c = SERIES();
  Chart.defaults.font.family = css('--font-sans') || 'Inter, system-ui, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = c.axis;
  Chart.defaults.borderColor = c.grid;
  Chart.__monica = true;
}

/**
 * Inserts null points where the time gap between consecutive points exceeds maxGapMs,
 * so Chart.js draws a break instead of a connecting line.
 */
export function withGaps(points, maxGapMs) {
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0 && points[i].x - points[i - 1].x > maxGapMs) out.push({ x: (points[i].x + points[i - 1].x) / 2, y: null, gap: true });
    out.push(points[i]);
  }
  return out;
}

/**
 * Time-series line chart on a linear millisecond axis (no date adapter needed).
 * datasets: [{ label, color, points:[{x,y,...}], pointStyle, dashed, hollowWhen(point), showLine }]
 */
export function timeChart(canvas, { datasets, tz = 'UTC', yTitle, yMin, yMax, xMin, xMax, tooltipLines, annotationsText }) {
  applyDefaults();
  const c = SERIES();
  const cfg = {
    type: 'line',
    data: {
      datasets: datasets.map((d) => ({
        label: d.label,
        data: d.points,
        parsing: false,
        borderColor: d.color,
        backgroundColor: d.color,
        borderWidth: d.borderWidth ?? (d.dashed ? 1.5 : 2),
        borderDash: d.dashed ? [6, 5] : undefined,
        pointRadius: d.pointRadius ?? ((ctx) => (ctx.raw?.y == null ? 0 : 4)),
        pointHoverRadius: 6,
        pointHitRadius: 10,
        pointStyle: d.pointStyle || ((ctx) => ctx.raw?.pointStyle || 'circle'),
        pointBackgroundColor: (ctx) => (ctx.raw?.hollow ? c.surface : d.color),
        pointBorderColor: d.color,
        pointBorderWidth: (ctx) => (ctx.raw?.hollow ? 2 : 1.5),
        showLine: d.showLine !== false,
        spanGaps: false,
        tension: 0,
        order: d.order ?? 0,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reduceMotion() ? false : { duration: 250 },
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      layout: { padding: { top: 6, right: 8 } },
      scales: {
        x: {
          type: 'linear',
          min: xMin, max: xMax,
          grid: { color: c.grid, drawTicks: false },
          border: { color: c.grid },
          ticks: { maxRotation: 0, autoSkipPadding: 24, padding: 8, callback: (v) => fmtShort(v, tz) },
        },
        y: {
          min: yMin, max: yMax,
          grid: { color: c.grid, drawTicks: false },
          border: { display: false },
          ticks: { padding: 8 },
          title: yTitle ? { display: true, text: yTitle, color: c.text, font: { size: 12, weight: '500' } } : undefined,
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1628', borderColor: '#2e4166', borderWidth: 1, padding: 10, cornerRadius: 8,
          titleColor: '#f2ede4', bodyColor: '#b8c0ce', titleFont: { weight: '600' }, displayColors: true, boxPadding: 4,
          filter: (item) => item.raw && item.raw.y !== null && item.raw.y !== undefined,
          callbacks: {
            title: (items) => (items[0] ? fmtDateTime(items[0].raw.x, tz) : ''),
            label: (item) => (tooltipLines ? tooltipLines(item.raw, item.dataset.label) : `${item.dataset.label}: ${item.raw.y}`),
          },
        },
      },
    },
  };
  return new Chart(canvas, cfg);
}

export function destroyChart(chart) {
  try { chart?.destroy(); } catch { /* ignore */ }
}
