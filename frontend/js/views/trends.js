import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { LABELS, fmtDateTime, fmtNum, unitLabel, plural } from '../ui/format.js';
import { panel, emptyState, loadingBlock, errorBlock, segmented, linkButton, callout } from '../ui/components.js';
import { timeChart, withGaps, destroyChart, SERIES, chartsAvailable } from '../ui/charts.js';
import { get, query } from '../api.js';
import { currentProfile, state } from '../state.js';
import { noProfileState } from './overview.js';

const GAP_MS = 48 * 3600_000; // display convention: lines join readings < 48 h apart
const RANGES = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'all', label: 'All' }];
const CONTEXT_GROUPS = [
  { key: 'resting', label: 'Resting', match: (c) => c === 'resting', color: 's1' },
  { key: 'post_exercise', label: 'After exercise', match: (c) => c === 'post_exercise', color: 's2' },
  { key: 'other', label: 'Other or unknown context', match: (c) => c !== 'resting' && c !== 'post_exercise', color: 's3' },
];

export async function render(root, ctx) {
  const profile = currentProfile();
  if (!profile) { mount(root, noProfileState()); return null; }
  const tz = profile.timezone;
  const params = { metric: ctx.params.metric || 'heart_rate', range: ctx.params.range || 'all', view: ctx.params.view || 'chart' };
  let chart = null;

  const controls = h('div', { class: 'trend-controls' });
  const content = h('div', { class: 'stack-lg' });
  mount(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Health trends'), h('p', null, 'Recorded observations over time. Points are actual entries only — nothing is interpolated or smoothed.'))),
    controls, content);

  function setParam(k, v) {
    params[k] = v;
    ctx.navigate('/trends', params);
  }

  const ref = state.reference;
  const metrics = ref ? [
    ...Object.entries(ref.vitalMetrics).map(([key, d]) => ({ key, label: d.label, kind: 'vital' })),
    ...Object.entries(ref.wellbeingMetrics).map(([key, d]) => ({ key, label: d.label, kind: 'wellbeing' })),
  ] : null;

  function drawControls(metricList) {
    const sel = h('select', { class: 'input', id: 'trend-metric' },
      h('optgroup', { label: 'Vital signs' }, metricList.filter((m) => m.kind === 'vital').map((m) => h('option', { value: m.key, selected: m.key === params.metric }, m.label))),
      h('optgroup', { label: 'Sleep & wellbeing (self-reported)' }, metricList.filter((m) => m.kind === 'wellbeing').map((m) => h('option', { value: m.key, selected: m.key === params.metric }, m.label))));
    sel.addEventListener('change', () => setParam('metric', sel.value));
    mount(controls,
      h('div', { class: 'field' }, h('label', { for: 'trend-metric' }, 'Measurement'), sel),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Period'), segmented({ name: 'range', label: 'Period', value: params.range, options: RANGES, onChange: (v) => setParam('range', v) })),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'View'), segmented({ name: 'view', label: 'View', value: params.view, options: [{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }], onChange: (v) => setParam('view', v) })));
  }

  if (!metrics) {
    mount(content, errorBlock({ message: 'Could not load trend data.' }, () => ctx.rerender()));
    return null;
  }
  drawControls(metrics);
  mount(content, loadingBlock('Loading trend…'));

  const from = params.range === 'all' ? undefined : new Date(Date.now() - Number(params.range) * 86_400_000).toISOString().slice(0, 10);
  let data;
  try {
    data = await get(`/profiles/${profile.id}/trends${query({ metric: params.metric, from })}`);
  } catch (err) {
    mount(content, errorBlock(err, () => ctx.rerender()));
    return null;
  }
  if (!ctx.isCurrent()) return null;

  const unit = data.kind === 'vital' ? unitLabel(data.unit) : data.unit;
  const pts = data.points;

  // ---- Summary ----
  const summary = h('div', { class: 'trend-summary' },
    stat('Readings in period', String(data.counts.total)),
    data.kind === 'vital' ? stat('Resting', String(data.counts.byContext.resting || 0)) : null,
    data.kind === 'vital' ? stat('Manual / device', `${data.counts.bySource.manual || 0} / ${data.counts.bySource.device_reported || 0}`) : null,
    data.kind === 'vital' ? stat('Uncertain or poor quality', String((data.counts.byQuality.uncertain || 0) + (data.counts.byQuality.poor || 0))) : null);

  const baselineBlock = data.baseline
    ? callout({ tone: 'teal', iconName: 'trends', title: `Baseline: ${fmtNum(data.baseline.displayValue)} ${unit}`,
      body: `${data.baseline.method === 'median_of_resting_readings' ? `Median of ${data.baseline.sampleCount} resting readings (${fmtDateTime(data.baseline.windowStart, tz)} – ${fmtDateTime(data.baseline.windowEnd, tz)})` : `Recorded value — ${data.baseline.sourceNote || 'source noted'}`}. Applies to resting readings of good or unstated quality. Method ${data.baseline.methodVersion}.` })
    : callout({ tone: 'info', iconName: 'unknown', title: 'Comparison unavailable', body: data.baselineUnavailableReason, children: data.kind === 'vital' ? linkButton('Establish a baseline', '#/settings', { size: 'sm' }) : null });

  if (pts.length === 0) {
    mount(content, summary, baselineBlock,
      emptyState({ iconName: 'trends', center: true, title: `No ${data.label.toLowerCase()} readings in this period`,
        body: 'Trends appear once check-ins include this measurement. Missing periods are shown as gaps, never filled in.',
        action: linkButton('Start health check-in', '#/check-in', { variant: 'primary', iconName: 'plus' }) }));
    return null;
  }

  // Latest resting comparison (descriptive only).
  let comparison = null;
  if (data.baseline) {
    const lastResting = [...pts].reverse().find((p) => p.activityContext === 'resting' && (p.quality === 'good' || p.quality === 'not_stated'));
    if (lastResting) {
      const diff = Math.round((lastResting.value - data.baseline.displayValue) * 100) / 100;
      comparison = h('p', { class: 'comparison' }, icon('info', { size: 14 }),
        `Latest eligible resting reading ${fmtNum(lastResting.value)} ${unit} (${fmtDateTime(lastResting.t, tz)}) differs from the baseline by ${diff > 0 ? '+' : ''}${fmtNum(diff)} ${unit}. This is an observation, not a diagnosis; no clinical threshold is configured.`);
    }
  }

  const c = SERIES();
  const toPoint = (p) => ({
    x: new Date(p.t).getTime(), y: p.value, raw: p,
    pointStyle: p.sourceType === 'device_reported' ? 'triangle' : 'circle',
    hollow: p.quality === 'uncertain' || p.quality === 'poor',
  });

  const groups = data.kind === 'vital'
    ? CONTEXT_GROUPS.map((g) => ({ ...g, points: pts.filter((p) => g.match(p.activityContext)).map(toPoint) })).filter((g) => g.points.length)
    : [{ key: 'self', label: 'Self-reported', color: 's1', points: pts.map(toPoint) }];

  const xs = pts.map((p) => new Date(p.t).getTime());
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const pad = Math.max((xMax - xMin) * 0.04, 3600_000);

  const datasets = groups.map((g) => ({ label: g.label, color: c[g.color], points: withGaps(g.points, GAP_MS) }));
  if (data.baseline) {
    datasets.push({ label: 'Baseline (resting)', color: c.baseline, dashed: true, pointRadius: 0, points: [{ x: xMin - pad, y: data.baseline.displayValue }, { x: xMax + pad, y: data.baseline.displayValue }], order: 5 });
  }

  const legend = h('div', { class: 'chart-legend', 'aria-hidden': 'true' },
    groups.map((g) => h('span', { class: 'key' }, h('span', { class: 'swatch', style: { background: c[g.color] } }), `${g.label} (${g.points.length})`)),
    data.kind === 'vital' ? [
      h('span', { class: 'key' }, h('span', { class: 'swatch dot' }), 'Manual'),
      h('span', { class: 'key' }, h('span', { class: 'swatch tri' }), 'Device-reported'),
      h('span', { class: 'key' }, h('span', { class: 'swatch hollow' }), 'Uncertain / poor quality'),
    ] : null,
    data.baseline ? h('span', { class: 'key' }, h('span', { class: 'swatch dash' }), 'Baseline') : null);

  const canvas = h('canvas', { role: 'img', 'aria-label': `${data.label} over time: ${pts.length} readings. A table view is available.` });
  const tableView = h('div', { class: 'table-wrap' },
    h('table', { class: 'data' },
      h('caption', null, `${data.label} — ${plural(pts.length, 'reading')}, times in ${tz}.`),
      h('thead', null, h('tr', null, ['Measured', 'Value', 'Context', 'Source', 'Quality', 'Detail'].map((t, i) => h('th', { scope: 'col', class: i === 1 ? 'num' : undefined }, t)))),
      h('tbody', null, [...pts].reverse().map((p) => h('tr', null,
        h('td', null, fmtDateTime(p.t, tz)),
        h('td', { class: 'num' }, p.convertedFrom ? `${fmtNum(p.value)} ${unit} (entered ${p.originalValue} °F)` : `${fmtNum(p.value)} ${unit}`),
        h('td', null, LABELS.context[p.activityContext]),
        h('td', null, LABELS.source[p.sourceType] || p.sourceType),
        h('td', null, LABELS.quality[p.quality] || '—'),
        h('td', null, [p.method ? LABELS.tempMethod[p.method] : null, p.deviceLabel].filter(Boolean).join(' · ') || '—'))))));

  const chartPanel = panel({
    title: `${data.label}`, iconName: 'trends', id: 'trend',
    sub: `${unit} · ${plural(pts.length, 'reading')}${pts.some((p) => p.convertedFrom) ? ' · °F readings converted exactly to °C for the chart' : ''}`,
    children: params.view === 'table' || !chartsAvailable()
      ? [!chartsAvailable() ? callout({ tone: 'attention', body: 'The charting library did not load; showing the table view.' }) : null, tableView]
      : [legend, h('div', { class: 'chart-box' }, canvas),
        h('p', { class: 'chart-caption' }, 'Lines join readings less than 48 hours apart within the same context; longer gaps are left open. Times in ', tz, '.')],
  });

  mount(content, summary, baselineBlock, comparison, chartPanel);

  if (params.view !== 'table' && chartsAvailable()) {
    chart = timeChart(canvas, {
      datasets, tz, yTitle: unit, xMin: xMin - pad, xMax: xMax + pad,
      tooltipLines: (raw, label) => {
        if (!raw.raw) return `${label}: ${fmtNum(raw.y)} ${unit}`;
        const p = raw.raw;
        return [
          `${fmtNum(p.value)} ${unit}${p.convertedFrom ? ` (entered ${p.originalValue} °F)` : ''}`,
          `${LABELS.context[p.activityContext]} · ${LABELS.source[p.sourceType] || p.sourceType}`,
          `Quality: ${LABELS.quality[p.quality] || '—'}`,
        ];
      },
    });
  }
  return () => destroyChart(chart);
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));
}
