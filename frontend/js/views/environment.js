import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fmtDateTime, fmtNum, plural } from '../ui/format.js';
import { panel, emptyState, loadingBlock, errorBlock, callout, historicalBadge, badge, segmented } from '../ui/components.js';
import { timeChart, destroyChart, SERIES, chartsAvailable } from '../ui/charts.js';
import { get } from '../api.js';

const GAP_MS = 2 * 3600_000; // display convention for RAD: break lines at gaps > 2 h
const TYPE_LABEL = { FLR: 'Solar flare', SEP: 'Solar energetic particles', CME: 'Coronal mass ejection', GST: 'Geomagnetic storm', IPS: 'Interplanetary shock' };
const PAGE = 100;

export async function render(root, ctx) {
  let chart = null;
  let timer = null;
  const view = ctx.params.view === 'table' ? 'table' : 'chart';
  const swMode = ctx.params.sw === 'recent' ? 'recent' : 'stored';

  mount(root,
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', null, 'Radiation & space weather'),
        h('p', null, 'Historical NASA measurements of the Mars surface radiation environment, and NASA space-weather event records shown separately for context.')),
      historicalBadge()),
    callout({ tone: 'teal', iconName: 'shield', title: 'Environmental measurements are not personal dosimetry',
      body: 'Curiosity\'s Radiation Assessment Detector measured the environment at the rover on the surface of Mars. These values are absorbed dose rates (µGy/h) from specific detectors — not an astronaut\'s personal dose, not effective dose (Sv), and not a basis for career-exposure calculations. MONICA never adds detector channels together.' }),
    h('div', { id: 'rad-slot', class: 'env-slot' }, loadingBlock('Loading NASA RAD observations…')),
    h('div', { id: 'sw-slot', class: 'env-slot' }, loadingBlock('Loading DONKI events…')));

  const radSlot = root.querySelector('#rad-slot');
  const swSlot = root.querySelector('#sw-slot');

  // ---------------- RAD ----------------
  let rad;
  try {
    rad = await get('/radiation', { timeoutMs: 30_000 });
  } catch (err) {
    mount(radSlot, panel({ title: 'Curiosity RAD dose rate', iconName: 'radiation', children: err.status === 503
      ? emptyState({ iconName: 'database', title: 'NASA data unavailable', body: err.message })
      : errorBlock(err, () => ctx.rerender()) }));
    rad = null;
  }
  if (!ctx.isCurrent()) return null;

  if (rad) {
    const all = [...rad.series.B || [], ...rad.series.E || []];
    if (all.length === 0) {
      mount(radSlot, panel({ title: 'Curiosity RAD dose rate', iconName: 'radiation',
        children: emptyState({ iconName: 'satellite', title: 'No NASA RAD observations imported', body: 'An administrator imports a verified historical interval with `npm run import:rad`. Nothing is shown until real archive data exist — MONICA never generates sample curves.' }) }));
    } else {
      chart = drawRad(radSlot, rad, view, ctx, (t) => { timer = t; });
    }
  }

  // ---------------- DONKI ----------------
  drawSpaceWeather(swSlot, swMode, ctx);

  return () => { if (timer) clearInterval(timer.id); destroyChart(chart?.current); };
}

function drawRad(slot, rad, view, ctx, setTimer) {
  const c = SERIES();
  const state = { detectors: { B: true, E: true }, showFlagged: false, cursor: null, playing: false, speed: 6, page: 0 };
  const chartRef = { current: null };
  const cov = rad.coverage;
  const first = Math.min(...cov.map((x) => new Date(x.firstObservation).getTime()));
  const last = Math.max(...cov.map((x) => new Date(x.lastObservation).getTime()));
  const colors = { B: c.s1, E: c.s2 };

  const isFlagged = (p) => p.quality !== 'no_issues_identified' && p.quality !== 'instrument_mode_flagged';

  function buildDatasets(cursor) {
    const ds = [];
    for (const det of ['B', 'E']) {
      if (!state.detectors[det]) continue;
      const pts = [];
      const flagged = [];
      let prev = null;
      for (const p of rad.series[det]) {
        const x = new Date(p.t).getTime();
        if (cursor !== null && x > cursor) break;
        const valid = p.value !== null && !isFlagged(p);
        if (prev !== null && x - prev > GAP_MS) pts.push({ x: (x + prev) / 2, y: null });
        if (valid) pts.push({ x, y: p.value, raw: p, det });
        else {
          pts.push({ x, y: null }); // rejected or missing sample → gap
          if (state.showFlagged && p.value !== null) flagged.push({ x, y: p.value, raw: p, det, hollow: true });
        }
        prev = x;
      }
      // Dense series: line only, with an enlarged hover/hit target per observation.
      ds.push({ label: `Detector ${det}`, color: colors[det], points: pts, pointRadius: 0, borderWidth: 1.25 });
      if (state.showFlagged && flagged.length) ds.push({ label: `Detector ${det} — flagged (QC)`, color: c.grey, points: flagged, showLine: false, pointRadius: 4 });
    }
    return ds;
  }

  function stats(det) {
    const s = rad.series[det] || [];
    const valid = s.filter((p) => p.value !== null && !isFlagged(p));
    const flagged = s.filter((p) => p.value !== null && isFlagged(p)).length;
    const gaps = s.filter((p) => p.value === null).length;
    const min = valid.reduce((m, p) => (m === null || p.value < m.value ? p : m), null);
    const max = valid.reduce((m, p) => (m === null || p.value > m.value ? p : m), null);
    return { total: s.length, valid: valid.length, flagged, gaps, min, max };
  }

  const chartBox = h('div', { class: 'chart-box tall' });
  const legend = h('div', { class: 'chart-legend', 'aria-hidden': 'true' });
  const replayInfo = h('div', { class: 'replay-info', 'aria-live': 'polite' });
  const tableSlot = h('div');

  function drawLegend() {
    mount(legend,
      ['B', 'E'].filter((d) => state.detectors[d]).map((d) => h('span', { class: 'key' }, h('span', { class: 'swatch line', style: { background: colors[d] } }), `Detector ${d} (µGy/h)`)),
      state.showFlagged ? h('span', { class: 'key' }, h('span', { class: 'swatch hollow' }), 'Flagged by QC (not in line)') : null);
  }

  function drawChart() {
    drawLegend();
    if (!chartsAvailable()) { mount(chartBox, callout({ tone: 'attention', body: 'The charting library did not load. Use the table view.' })); return; }
    destroyChart(chartRef.current);
    const canvas = h('canvas', { role: 'img', 'aria-label': `Curiosity RAD absorbed dose rate, detectors ${['B', 'E'].filter((d) => state.detectors[d]).join(' and ')}, ${fmtDateTime(first, 'UTC')} to ${fmtDateTime(last, 'UTC')}. Table view available.` });
    mount(chartBox, canvas);
    chartRef.current = timeChart(canvas, {
      datasets: buildDatasets(state.cursor), tz: 'UTC', yTitle: 'Absorbed dose rate (µGy/h)', xMin: first, xMax: last,
      tooltipLines: (raw, label) => {
        const p = raw.raw;
        if (!p) return `${label}: ${raw.y}`;
        return [`${label}: ${p.valueText} µGy/h`, `Sol ${p.sol} · obs ${p.obs} · ${p.lmst || ''}`, `QC ${p.qc ?? '—'} · ${rad.qualityLabels[p.quality]?.split(' — ')[0] || p.quality}`];
      },
    });
  }

  function updateChartData() {
    const ch = chartRef.current;
    if (!ch) return;
    const ds = buildDatasets(state.cursor);
    ch.data.datasets.forEach((d, i) => { if (ds[i]) d.data = ds[i].points; });
    ch.update('none');
  }

  // Replay controls (historical data, clearly labelled).
  const playBtn = h('button', { class: 'btn btn-sm', type: 'button' }, icon('play'), 'Play replay');
  const resetBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, icon('reset'), 'Show all');
  const timerHolder = { id: null };
  setTimer(timerHolder);
  function setPlaying(on) {
    state.playing = on;
    mount(playBtn, icon(on ? 'pause' : 'play'), on ? 'Pause replay' : (state.cursor !== null ? 'Resume replay' : 'Play replay'));
    if (timerHolder.id) { clearInterval(timerHolder.id); timerHolder.id = null; }
    if (on) {
      if (state.cursor === null || state.cursor >= last) state.cursor = first;
      timerHolder.id = setInterval(() => {
        state.cursor = Math.min(last, state.cursor + state.speed * 3600_000);
        updateChartData();
        drawReplayInfo();
        if (state.cursor >= last) setPlaying(false);
      }, 250);
    }
    drawReplayInfo();
  }
  playBtn.addEventListener('click', () => setPlaying(!state.playing));
  resetBtn.addEventListener('click', () => { setPlaying(false); state.cursor = null; mount(playBtn, icon('play'), 'Play replay'); updateChartData(); drawReplayInfo(); });

  function drawReplayInfo() {
    mount(replayInfo, state.cursor === null
      ? h('span', null, `Showing all imported observations: ${fmtDateTime(first, 'UTC')} → ${fmtDateTime(last, 'UTC')}`)
      : h('span', null, h('strong', null, 'Historical NASA data replay'), ` — observations up to ${fmtDateTime(state.cursor, 'UTC')} (recorded in ${new Date(state.cursor).getUTCFullYear()}, not live)`));
  }

  const detChips = h('div', { class: 'chip-grid' }, ['B', 'E'].map((d) => {
    const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true' }, h('span', { class: 'chip-dot', style: { background: colors[d] } }), `Detector ${d}`);
    b.addEventListener('click', () => {
      const next = !state.detectors[d];
      if (!next && Object.values(state.detectors).filter(Boolean).length === 1) return; // keep at least one
      state.detectors[d] = next;
      b.setAttribute('aria-pressed', String(next));
      if (view === 'chart') drawChart(); else drawTable();
    });
    return b;
  }));
  const flaggedToggle = h('input', { type: 'checkbox' });
  flaggedToggle.addEventListener('change', () => { state.showFlagged = flaggedToggle.checked; if (view === 'chart') drawChart(); else drawTable(); });

  function drawTable() {
    const rows = ['B', 'E'].filter((d) => state.detectors[d]).flatMap((d) => rad.series[d].map((p) => ({ ...p, det: d })))
      .filter((p) => state.showFlagged || (p.value !== null && !isFlagged(p)) || p.value === null)
      .sort((a, b) => new Date(a.t) - new Date(b.t) || a.det.localeCompare(b.det));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * PAGE, state.page * PAGE + PAGE);
    mount(tableSlot,
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('caption', null, `${plural(rows.length, 'sample')} · page ${state.page + 1} of ${pages}. Values exactly as archived; flagged samples ${state.showFlagged ? 'included' : 'hidden (gaps still listed)'}.`),
        h('thead', null, h('tr', null, ['Observation start (UTC)', 'LMST', 'Sol', 'Obs', 'Detector', 'Dose rate (µGy/h)', 'QC', 'Status'].map((t, i) => h('th', { scope: 'col', class: i === 5 ? 'num' : undefined }, t)))),
        h('tbody', null, slice.map((p) => h('tr', null,
          h('td', null, fmtDateTime(p.t, 'UTC', { seconds: true })), h('td', null, p.lmst || '—'), h('td', { class: 'num' }, p.sol), h('td', { class: 'num' }, p.obs),
          h('td', null, p.det), h('td', { class: 'num' }, p.value === null ? 'Gap' : p.valueText), h('td', { class: 'mono' }, p.qc ?? '—'),
          h('td', null, statusBadge(p.quality))))))),
      h('div', { class: 'row pager' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: state.page === 0, onclick: () => { state.page -= 1; drawTable(); } }, icon('chevronLeft'), 'Previous'),
        h('span', { class: 'faint small' }, `Page ${state.page + 1} / ${pages}`),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: state.page >= pages - 1, onclick: () => { state.page += 1; drawTable(); } }, 'Next', icon('chevronRight'))));
  }

  const dsInfo = rad.dataset;
  const source = dsInfo.source;
  const runs = rad.importRuns || [];
  const st = { B: stats('B'), E: stats('E') };

  const statTable = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('caption', null, 'Descriptive statistics of archived values in the imported interval (excluding gaps and QC-flagged samples). No thresholds are applied.'),
    h('thead', null, h('tr', null, ['Detector', 'Samples', 'Usable', 'QC-flagged', 'Gaps', 'Lowest (µGy/h)', 'Highest (µGy/h)'].map((t, i) => h('th', { scope: 'col', class: i > 0 ? 'num' : undefined }, t)))),
    h('tbody', null, ['B', 'E'].map((d) => h('tr', null,
      h('th', { scope: 'row' }, `Detector ${d}`),
      h('td', { class: 'num' }, st[d].total), h('td', { class: 'num' }, st[d].valid), h('td', { class: 'num' }, st[d].flagged), h('td', { class: 'num' }, st[d].gaps),
      h('td', { class: 'num' }, st[d].min ? h('span', { title: fmtDateTime(st[d].min.t, 'UTC') }, `${st[d].min.valueText}`) : '—'),
      h('td', { class: 'num' }, st[d].max ? h('span', { title: fmtDateTime(st[d].max.t, 'UTC') }, `${st[d].max.valueText}`) : '—'))))));

  const provenancePanel = h('div', { class: 'provenance-grid' },
    h('dl', { class: 'kv' },
      h('dt', null, 'Dataset'), h('dd', null, source?.title || dsInfo.id),
      h('dt', null, 'Dataset ID'), h('dd', { class: 'mono' }, dsInfo.id),
      h('dt', null, 'Archive'), h('dd', null, source ? h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.organisation, ' ', icon('external', { size: 12 })) : '—'),
      h('dt', null, 'Observation dates'), h('dd', null, `${fmtDateTime(first, 'UTC')} → ${fmtDateTime(last, 'UTC')}`),
      h('dt', null, 'Sols'), h('dd', { class: 'num' }, `${cov[0].firstSol}–${cov[0].lastSol}`),
      h('dt', null, 'Quantity & unit'), h('dd', null, `Total absorbed dose rate, archived unit "${dsInfo.unit}" (µGy/h)`),
      h('dt', null, 'Channels'), h('dd', null, h('ul', { class: 'plain' }, dsInfo.channels.map((ch) => h('li', null, ch.description)))),
      h('dt', null, 'Quality (QC)'), h('dd', null, 'Interpreted from the 8-bit QC field per RAD_RDR_SIS §4.2.1.2. Bit 0 ("unknown quality-control issues may exist") excludes a sample from the line. The SIS notes QC was a placeholder when written, so "no issues identified" is not a guarantee.'),
      h('dt', null, 'Imported'), h('dd', null, runs.length ? h('ul', { class: 'plain' }, runs.slice(0, 3).map((r) => h('li', null, `${fmtDateTime(r.finishedAt || r.startedAt, 'UTC')} — ${r.status}, ${r.recordsInserted} new / ${r.recordsSkippedDuplicate} duplicate (sols ${r.parameters.fromSol}–${r.parameters.toSol})`))) : '—')),
    h('details', { class: 'disclosure' },
      h('summary', null, `Archive files used (${rad.products.length})`),
      h('div', { class: 'disclosure-body' }, h('ul', { class: 'plain files' }, rad.products.map((p) => h('li', null,
        h('span', { class: 'mono' }, p.productId), ' · ',
        h('a', { href: p.labelFileUrl, target: '_blank', rel: 'noopener noreferrer' }, 'label'), ' · ',
        h('a', { href: p.dataFileUrl, target: '_blank', rel: 'noopener noreferrer' }, 'data file (~86 MB)')))))));

  const viewToggle = segmented({ name: 'radview', label: 'View', value: view, options: [{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }], onChange: (v) => ctx.navigate('/environment', { view: v, sw: ctx.params.sw }) });

  mount(slot, panel({
    title: 'Curiosity RAD — total absorbed dose rate', iconName: 'radiation', id: 'rad',
    sub: `${dsInfo.id} · observed ${fmtDateTime(first, 'UTC')} → ${fmtDateTime(last, 'UTC')} · imported ${fmtDateTime(cov[0].lastImportedAt, 'UTC')}`,
    actions: [historicalBadge('Historical'), viewToggle],
    children: [
      h('div', { class: 'rad-toolbar' },
        detChips,
        h('label', { class: 'switch' }, flaggedToggle, 'Show QC-flagged samples'),
        view === 'chart' ? h('div', { class: 'replay' }, h('span', { class: 'replay-label' }, icon('history'), 'Historical NASA data replay'), playBtn,
          segmented({ name: 'speed', label: 'Replay speed', value: String(state.speed), options: [{ value: '2', label: '2 h/step' }, { value: '6', label: '6 h/step' }, { value: '24', label: '1 day/step' }], onChange: (v) => { state.speed = Number(v); } }),
          resetBtn) : null),
      view === 'chart' ? [legend, chartBox, replayInfo, h('p', { class: 'chart-caption' }, 'Each point is one RAD observation, plotted at its start time (UTC) with the value exactly as archived. Lines break at missing or QC-flagged samples and where consecutive observations are more than 2 hours apart (display convention).')] : tableSlot,
      h('div', { class: 'divider-label' }, 'Summary'),
      statTable,
      h('div', { class: 'divider-label' }, 'Provenance'),
      provenancePanel,
    ],
  }));
  if (view === 'chart') { drawChart(); drawReplayInfo(); } else drawTable();
  return chartRef;
}

function statusBadge(q) {
  const map = {
    no_issues_identified: ['QC clear', 'teal'], issues_may_exist: ['QC flagged', 'attention'],
    instrument_mode_flagged: ['Instrument mode', 'info'], missing: ['Missing', 'unknown'], invalid_value: ['Invalid', 'unknown'],
  };
  const [t, cls] = map[q] || [q, 'unknown'];
  return badge(t, cls);
}

async function drawSpaceWeather(slot, mode, ctx) {
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'DONKI event source' },
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === 'stored'), onclick: () => ctx.navigate('/environment', { view: ctx.params.view, sw: 'stored' }) }, 'Imported events'),
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === 'recent'), onclick: () => ctx.navigate('/environment', { view: ctx.params.view, sw: 'recent' }) }, 'Recent 30 days'));
  const body = h('div', null, loadingBlock(mode === 'recent' ? 'Requesting recent events from api.nasa.gov…' : 'Loading imported events…'));
  mount(slot, panel({ title: 'Space-weather events (NASA DONKI)', iconName: 'sun', id: 'sw', sub: 'Context only — separate from Mars surface measurements.', children: [tabs, body] }));

  let data;
  try {
    data = await get(`/space-weather${mode === 'recent' ? '?mode=recent' : ''}`, { timeoutMs: 45_000 });
  } catch (err) {
    mount(body, err.status === 503 ? emptyState({ iconName: 'database', title: 'Unavailable', body: err.message }) : errorBlock(err, () => ctx.rerender()));
    return;
  }
  if (!ctx.isCurrent()) return;

  const statusBadges = {
    historical: badge('Historical (imported)', 'historical', 'clock'),
    live: badge('Retrieved from NASA', 'teal', 'satellite'),
    partial: badge('Partially retrieved', 'attention', 'attention'),
    cached: badge('Cached server-side', 'outline', 'database'),
    stale_cache: badge('Cached — NASA currently unreachable', 'attention', 'attention'),
    unavailable: badge('Unavailable', 'unknown', 'unknown'),
    not_imported: badge('Not imported', 'unknown', 'unknown'),
  };

  const meta = h('div', { class: 'row sw-meta' },
    statusBadges[data.status] || null,
    data.fetchedAt ? h('span', { class: 'faint small' }, `Retrieved ${fmtDateTime(data.fetchedAt, 'UTC')}`) : null,
    data.coverage ? h('span', { class: 'faint small' }, `Events ${fmtDateTime(data.coverage.firstEvent, 'UTC')} → ${fmtDateTime(data.coverage.lastEvent, 'UTC')}`) : null,
    data.window ? h('span', { class: 'faint small' }, `Window ${fmtDateTime(data.window.start, 'UTC')} → ${fmtDateTime(data.window.end, 'UTC')}`) : null);

  const notes = [];
  if (data.importRuns?.length) {
    const r = data.importRuns[0];
    const failed = (r.messages || []).filter((m) => /FAILED/.test(m));
    if (failed.length) notes.push(callout({ tone: 'attention', title: `Last import: ${r.status}`, body: failed.join(' ') + ' Events of that type are absent from this list — not "none occurred".' }));
  }
  if (data.errors?.length) notes.push(callout({ tone: 'attention', title: 'Some requests to api.nasa.gov failed', body: data.errors.map((e) => `${e.type}: ${e.message}`).join(' · ') }));

  const allEvents = data.events || [];
  const counts = allEvents.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
  const view = { type: 'all', expanded: false };
  const listSlot = h('div');
  const filterSlot = h('div', { class: 'chip-grid event-filter', role: 'group', 'aria-label': 'Filter events by type' });
  const LIMIT = 20;

  function drawFilter() {
    mount(filterSlot, [['all', `All (${allEvents.length})`], ...Object.keys(counts).sort().map((t) => [t, `${TYPE_LABEL[t] || t} (${counts[t]})`])].map(([t, label]) =>
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(view.type === t), onclick: () => { view.type = t; view.expanded = false; drawFilter(); drawList(); } }, label)));
  }

  function drawList() {
    const events = view.type === 'all' ? allEvents : allEvents.filter((e) => e.type === view.type);
    const shown = view.expanded ? events : events.slice(0, LIMIT);
    mount(listSlot, events.length === 0 ? emptyState({ iconName: 'sun', title: data.status === 'unavailable' ? 'NASA DONKI could not be reached' : 'No events in this list',
      body: data.status === 'unavailable' ? 'No recent events can be shown right now. This is an availability problem, not a statement that no space weather occurred.' : (mode === 'stored' ? 'No DONKI events have been imported. An administrator runs `npm run import:donki`.' : 'DONKI returned no events of the requested types for this window.') })
      : [renderEvents(shown), events.length > LIMIT ? h('div', { class: 'row show-more' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { view.expanded = !view.expanded; drawList(); } }, view.expanded ? 'Show fewer' : `Show all ${events.length} events`),
        h('span', { class: 'faint small' }, `Showing ${shown.length} of ${events.length}`)) : null]);
  }

  const renderEvents = (events) => h('ol', { class: 'event-list' }, events.map((e) => h('li', { class: 'event' },
      h('div', { class: 'event-time' }, h('span', { class: 'badge outline' }, e.type), h('time', { datetime: new Date(e.time).toISOString() }, fmtDateTime(e.time, 'UTC'))),
      h('div', { class: 'event-main' },
        h('div', { class: 'event-title' }, TYPE_LABEL[e.type] || e.type,
          e.summary?.classType ? h('span', { class: 'faint' }, ` · class ${e.summary.classType}`) : null,
          e.summary?.sourceLocation ? h('span', { class: 'faint' }, ` · source ${e.summary.sourceLocation}`) : null,
          e.summary?.maxKpIndex !== undefined && e.summary?.maxKpIndex !== null ? h('span', { class: 'faint' }, ` · max Kp ${e.summary.maxKpIndex}`) : null,
          e.summary?.analysis?.speedKmPerS ? h('span', { class: 'faint' }, ` · ${fmtNum(e.summary.analysis.speedKmPerS)} km/s`) : null),
        h('div', { class: 'event-meta' },
          e.summary?.observingLocation ? h('span', null, `Observing location: ${e.summary.observingLocation}`) : null,
          h('span', null, e.observedBy?.length ? `Observed by: ${e.observedBy.join(', ')}` : 'Instruments not listed in record'),
          e.summary?.linkedEvents?.length ? h('span', null, plural(e.summary.linkedEvents.length, 'linked event')) : null),
        e.summary?.note ? h('p', { class: 'event-note' }, e.summary.note) : null),
      e.link ? h('a', { class: 'btn btn-sm btn-ghost', href: e.link, target: '_blank', rel: 'noopener noreferrer' }, 'DONKI', icon('external')) : null)));

  drawFilter();
  drawList();
  mount(body,
    meta,
    callout({ tone: 'info', iconName: 'info', body: data.contextNote }),
    notes,
    allEvents.length ? filterSlot : null,
    listSlot,
    data.source ? h('p', { class: 'faint small source-line' }, 'Source: ', h('a', { href: data.source.url, target: '_blank', rel: 'noopener noreferrer' }, data.source.title), ` — ${data.source.organisation}, via api.nasa.gov.`) : null);
}
