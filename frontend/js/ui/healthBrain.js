// Shared Health Brain (RHI) display pieces. Band colour is never the only signal: every band
// is shown with its name and an icon, and "not assessed" is always written out.
import { h } from './dom.js';
import { icon } from './icons.js';
import { fmtDateTime, fmtShort } from './format.js';

const Chart = window.Chart;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const NS = 'http://www.w3.org/2000/svg';

export const BAND_ICON = { green: 'checkCircle', yellow: 'info', orange: 'attention', red: 'urgent' };
export const bandColor = (band) => css(`--band-${band}`);

function s(tag, attrs, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c);
  return el;
}

export function bandChip(a, { size = '' } = {}) {
  return h('span', { class: ['hb-band', a.band, size] }, icon(BAND_ICON[a.band]), a.bandLabel);
}

/** Ring gauge: outer ring shows the four band zones, inner arc the score in its band colour. */
export function rhiDial(a, { size = 176 } = {}) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const ro = 61;
  const co = 2 * Math.PI * ro;
  const zones = [['green', 0, 25], ['yellow', 25, 50], ['orange', 50, 75], ['red', 75, 100]];
  const gap = 1.2;
  const svg = s('svg', { viewBox: '0 0 140 140', width: size, height: size, role: 'img', class: 'hb-dial-svg',
    'aria-label': `RHI ${a.score} of 100, ${a.bandLabel} band${a.triggers.length ? ', set by a hard trigger' : ''}` },
  s('circle', { cx: 70, cy: 70, r, fill: 'none', class: 'hb-dial-track', 'stroke-width': 11 }),
  s('circle', { cx: 70, cy: 70, r, fill: 'none', class: `hb-dial-arc ${a.band}`, 'stroke-width': 11, 'stroke-linecap': a.score > 0 ? 'round' : 'butt',
    'stroke-dasharray': `${(c * Math.max(a.score, 0.5)) / 100} ${c}`, transform: 'rotate(-90 70 70)' }),
  ...zones.map(([band, from, to]) => s('circle', { cx: 70, cy: 70, r: ro, fill: 'none', class: `hb-dial-zone ${band}${band === a.band ? ' on' : ''}`, 'stroke-width': 3,
    'stroke-dasharray': `${(co * (to - from - gap)) / 100} ${co}`, transform: `rotate(${-90 + ((from + gap / 2) * 360) / 100} 70 70)` })));
  const score = s('text', { x: 70, y: 76, 'text-anchor': 'middle', class: 'hb-dial-score' });
  score.textContent = String(a.score);
  const label = s('text', { x: 70, y: 94, 'text-anchor': 'middle', class: 'hb-dial-label' });
  label.textContent = 'RHI · 0–100';
  svg.append(score, label);
  return h('div', { class: 'hb-dial' }, svg);
}

/** One row per component: weight, sub-score bar, points, and (optionally) the plain-language inputs. */
export function componentRows(a, { detail = true } = {}) {
  return h('div', { class: 'hb-comps' }, a.components.map((c) => {
    const fill = h('div', { class: 'hb-comp-fill' });
    fill.style.width = `${c.assessed ? c.subScore : 0}%`;
    return h('div', { class: ['hb-comp', c.key, !c.assessed && 'na'] },
      h('div', { class: 'hb-comp-head' },
        h('span', { class: 'hb-comp-name' }, h('span', { class: 'hb-dot' }), c.label, h('span', { class: 'hb-weight' }, `${c.weight}%`)),
        h('span', { class: 'hb-comp-pts num' }, c.assessed ? `${c.points} of ${c.weight} pts` : 'Not assessed')),
      h('div', { class: 'hb-comp-track', role: 'img', 'aria-label': c.assessed ? `${c.label} sub-score ${c.subScore} of 100` : `${c.label} not assessed` }, fill),
      detail ? h('div', { class: 'hb-comp-sum' }, c.summary) : null);
  }));
}

export function triggerList(a) {
  if (!a.triggers.length) return null;
  return h('div', { class: 'hb-triggers', role: 'alert' },
    h('div', { class: 'hb-triggers-head' }, icon('urgent'), 'Hard trigger overrides the score'),
    h('ul', { class: 'plain' }, a.triggers.map((t) => h('li', null, h('strong', null, t.label), ' — ', t.detail))));
}

export function coverageNote(a) {
  if (a.coverage.complete) return h('span', { class: 'hb-cov' }, icon('checkCircle'), 'All four components assessed');
  return h('span', { class: 'hb-cov partial' }, icon('unknown'),
    `Partial: ${a.coverage.notAssessed.join(', ')} not assessed (adds 0 points — the index may understate)`);
}

/** Compact strip of the latest assessments: bar height = score, colour + title = band. */
export function historyStrip(history, tz, { max = 14 } = {}) {
  const items = history.slice(-max);
  return h('div', { class: 'hb-strip', role: 'img', 'aria-label': `Last ${items.length} RHI assessments: ${items.map((a) => `${a.score} ${a.bandLabel}`).join(', ')}` },
    items.map((a) => {
      const bar = h('span', { class: ['hb-strip-bar', a.band], title: `${fmtDateTime(a.measuredAt, tz)} — RHI ${a.score}, ${a.bandLabel}${a.triggers.length ? ' (hard trigger)' : ''}` });
      bar.style.height = `${Math.max(8, a.score)}%`;
      return h('span', { class: 'hb-strip-cell' }, bar, a.triggers.length ? h('span', { class: 'hb-strip-flag', 'aria-hidden': 'true' }) : null);
    }));
}

const zonePlugin = {
  id: 'hbZones',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea: area, scales: { y } } = chart;
    if (!area) return;
    const zones = [['green', 0, 25], ['yellow', 25, 50], ['orange', 50, 75], ['red', 75, 100]];
    ctx.save();
    for (const [band, from, to] of zones) {
      const top = y.getPixelForValue(to);
      const bottom = y.getPixelForValue(from);
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = bandColor(band);
      ctx.fillRect(area.left, top, area.right - area.left, bottom - top);
      ctx.globalAlpha = 0.75;
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(band.toUpperCase(), area.right - 6, top + 5);
    }
    ctx.restore();
  },
};

/**
 * RHI over time. Only assessed check-ins are plotted (no interpolation between them beyond the
 * connecting line); point colour and shape show the band, diamonds mark hard triggers.
 */
export function rhiChart(canvas, history, tz, { onSelect, selected } = {}) {
  if (typeof Chart !== 'function') return null;
  const text = css('--text-2');
  const grid = css('--chart-grid');
  const points = history.map((a, i) => ({ x: new Date(a.measuredAt).getTime(), y: a.score, i }));
  return new Chart(canvas, {
    type: 'line',
    plugins: [zonePlugin],
    data: {
      datasets: [{
        label: 'RHI', data: points, parsing: false, borderColor: css('--text-3'), borderWidth: 1.5, tension: 0, spanGaps: false,
        pointBackgroundColor: (c) => (c.raw ? bandColor(history[c.raw.i].band) : text),
        pointBorderColor: (c) => (c.raw && c.raw.i === selected?.() ? css('--text') : css('--surface')),
        pointBorderWidth: (c) => (c.raw && c.raw.i === selected?.() ? 2.5 : 1.5),
        pointStyle: (c) => (c.raw && history[c.raw.i].triggers.length ? 'rectRot' : 'circle'),
        pointRadius: (c) => (c.raw && history[c.raw.i].triggers.length ? 8 : 6),
        pointHoverRadius: 9, pointHitRadius: 14,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 250 },
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      layout: { padding: { top: 8, right: 8 } },
      onClick: (_e, els) => { if (els[0] && onSelect) onSelect(points[els[0].index].i); },
      scales: {
        x: { type: 'linear', grid: { color: grid, drawTicks: false }, border: { color: grid }, ticks: { maxRotation: 0, autoSkipPadding: 24, padding: 8, callback: (v) => fmtShort(v, tz) } },
        y: { min: 0, max: 100, grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { padding: 8, stepSize: 25 },
          title: { display: true, text: 'RHI (0–100)', color: text, font: { size: 12, weight: '500' } } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1628', borderColor: '#2e4166', borderWidth: 1, padding: 10, cornerRadius: 8,
          titleColor: '#f2ede4', bodyColor: '#b8c0ce', titleFont: { weight: '600' }, displayColors: false,
          callbacks: {
            title: (items) => (items[0] ? fmtDateTime(items[0].raw.x, tz) : ''),
            label: (item) => {
              const a = history[item.raw.i];
              return [`RHI ${a.score} — ${a.bandLabel}${a.triggers.length ? ' (hard trigger)' : ''}`,
                ...a.components.map((c) => `${c.label}: ${c.assessed ? `${c.points} of ${c.weight}` : 'not assessed'}`),
                ...a.triggers.map((t) => `Trigger: ${t.label}`)];
            },
          },
        },
      },
    },
  });
}
