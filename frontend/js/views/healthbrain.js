import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fmtDateTime, fmtRelative, plural } from '../ui/format.js';
import { panel, emptyState, loadingBlock, errorBlock, linkButton, callout, badge } from '../ui/components.js';
import { destroyChart } from '../ui/charts.js';
import { bandChip, rhiDial, componentRows, triggerList, coverageNote, rhiChart, BAND_ICON } from '../ui/healthBrain.js';
import { get } from '../api.js';
import { currentProfile } from '../state.js';
import { noProfileState } from './overview.js';

const SOURCE_LABEL = {
  manual: 'Manual entry', device_reported: 'Device-reported', nasa_replay: 'NASA MSL RAD replay (demo scenario)',
};

export async function render(root, ctx) {
  const profile = currentProfile();
  if (!profile) { mount(root, noProfileState()); return null; }
  mount(root, loadingBlock('Loading Health Brain…'));

  let data;
  try {
    data = await get(`/profiles/${profile.id}/health-brain`);
  } catch (err) {
    if (err.status === 401) throw err;
    mount(root, errorBlock(err, () => ctx.rerender()));
    return null;
  }
  if (!ctx.isCurrent()) return null;

  const tz = profile.timezone;
  const { model, history } = data;
  let chart = null;
  let sel = history.length - 1;

  const head = h('div', { class: 'page-head' },
    h('div', null,
      h('div', { class: 'row' }, h('h1', null, 'Health Brain'), badge('Prototype weights', 'outline', 'flask')),
      h('p', null, `One number that says how closely ${profile.displayName} needs watching right now. The Radiation Health Index (RHI) runs from 0 to 100 and is rebuilt from every check-in: ${model.components.map((c) => `${c.label} ${c.weight}%`).join(', ')}. Hard triggers override the score.`)),
    h('div', { class: 'page-actions' }, linkButton('New check-in', '#/check-in', { variant: 'primary', iconName: 'plus' })));

  // ---- How it works (always shown, also when there is no data yet) ----
  const howPanel = panel({
    title: 'How the index is built', iconName: 'layers', id: 'hb-how',
    sub: `Model ${model.version}. Deterministic: the same entries always give the same result.`,
    children: h('div', { class: 'hb-how-grid' },
      h('div', { class: 'stack' }, h('div', { class: 'hb-weights' }, model.components.map((c) => h('div', { class: ['hb-weight-row', c.key] },
        h('div', { class: 'hb-weight-head' }, h('span', { class: 'hb-dot' }), h('strong', null, c.label), h('span', { class: 'num' }, `${c.weight}%`)),
        h('p', { class: 'small muted' }, c.method))))),
      h('div', { class: 'stack' }, h('div', { class: 'divider-label' }, 'Bands'),
      h('div', { class: 'hb-bands' }, model.bands.map((b) => h('div', { class: ['hb-band-row', b.key] },
        h('span', { class: ['hb-band', b.key] }, icon(BAND_ICON[b.key]), b.label),
        h('span', { class: 'hb-band-action' }, b.action),
        h('span', { class: 'hb-band-range num' }, b.range)))),
      h('div', { class: 'divider-label' }, 'Hard triggers — any one sets RED'),
      h('ul', { class: 'plain hb-trigger-defs' }, model.triggers.map((t) => h('li', null, h('strong', null, t.label), h('span', { class: 'small muted' }, ` — ${t.rule}`)))),
      callout({ tone: 'attention', iconName: 'flask', title: 'Prototype — not a clinical score',
        children: h('ul', { class: 'plain small' }, model.disclaimers.map((d) => h('li', null, d))) }))),
  });

  if (!history.length) {
    mount(root, head,
      h('div', { class: 'grid grid-12' },
        h('div', { class: 'span-7' }, panel({
          title: 'No assessment yet', iconName: 'gauge',
          children: emptyState({ iconName: 'checkin', title: 'Record a check-in to calculate RHI',
            body: 'The index needs at least one check-in. Components you do not record are shown as "not assessed" — never as normal.',
            action: linkButton('Start health check-in', '#/check-in', { variant: 'primary', iconName: 'plus' }) }) })),
        h('div', { class: 'span-5' }, howPanel)));
    return null;
  }

  const heroSlot = h('div', { class: 'span-7' });
  const compSlot = h('div', { class: 'span-5' });
  const tableBody = h('tbody');

  function drawSelected() {
    const a = history[sel];
    const latest = sel === history.length - 1;
    mount(heroSlot, panel({
      title: latest ? 'Current assessment' : 'Selected assessment', iconName: 'gauge', id: 'hb-hero', className: `hb-hero-panel ${a.band}`,
      sub: `From the check-in measured ${fmtDateTime(a.measuredAt, tz)} (${fmtRelative(a.measuredAt)}).`,
      actions: latest ? null : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => select(history.length - 1) }, icon('reset'), 'Back to latest'),
      children: h('div', { class: 'hb-hero' },
        rhiDial(a, { size: 196 }),
        h('div', { class: 'hb-hero-body' },
          h('div', { class: 'row' }, bandChip(a, { size: 'lg' }), a.bandReason === 'hard_trigger' ? badge(`Score alone: ${a.scoreBand.toUpperCase()}`, 'outline') : null),
          h('p', { class: 'hb-action' }, a.action),
          triggerList(a),
          h('p', { class: 'small muted' }, a.band === 'green'
            ? 'Nothing in this check-in raised the index. That is not a statement that the crew member is healthy.'
            : 'MONICA has not contacted anyone. Follow your mission\'s own procedures; use Actions & follow-up to record what was done.'),
          coverageNote(a),
          h('div', { class: 'row' },
            linkButton('Actions & follow-up', '#/actions', { size: 'sm', iconName: 'actions' }),
            linkButton('Prepare review summary', '#/reports', { size: 'sm', iconName: 'reports' })))),
    }));
    mount(compSlot, panel({
      title: 'What moved the index', iconName: 'chart', id: 'hb-comp',
      sub: 'Each component scores 0–100 and contributes up to its weight.',
      children: h('div', { class: 'stack' },
        componentRows(a),
        a.exposureSource ? h('p', { class: 'small faint' }, icon('database', { size: 13 }), ` Dose-rate source: ${SOURCE_LABEL[a.exposureSource.sourceType] || a.exposureSource.sourceType}${a.exposureSource.sourceNote ? ` — ${a.exposureSource.sourceNote}` : ''}`) : null),
    }));
    for (const tr of tableBody.children) tr.classList.toggle('is-selected', Number(tr.dataset.i) === sel);
    chart?.update('none');
  }

  function select(i) {
    sel = i;
    drawSelected();
  }

  // ---- History chart ----
  const canvas = h('canvas', { role: 'img', 'aria-label': `RHI history: ${history.map((a) => `${fmtDateTime(a.measuredAt, tz)} ${a.score} ${a.bandLabel}`).join('; ')}` });
  const counts = data.summary.bandCounts;
  const chartPanel = panel({
    title: 'RHI over time', iconName: 'trends', id: 'hb-history',
    sub: `${plural(history.length, 'assessment')} — one per check-in. Select a point or a table row to inspect it.`,
    children: [
      h('div', { class: 'chart-legend' },
        ['green', 'yellow', 'orange', 'red'].map((b) => h('span', { class: 'key' }, h('span', { class: ['swatch dot hb-swatch', b] }), `${b.toUpperCase()} ${counts[b]}`)),
        h('span', { class: 'key' }, h('span', { class: 'swatch hb-diamond' }), 'Hard trigger')),
      h('div', { class: 'chart-box sm' }, canvas),
      data.summary.usesNasaReplay
        ? callout({ tone: 'teal', iconName: 'satellite', title: 'What is real in this demo profile',
          body: 'The dose rates are archived NASA measurements: Curiosity rover RAD detector E on the Mars surface during the solar particle event of 10–11 September 2017, shifted in time. Vital signs, symptoms and lymphocyte counts are invented to demonstrate the logic — the real event was far too small to cause symptoms.',
          children: h('a', { href: '#/environment', class: 'small' }, 'See the original measurements') })
        : h('p', { class: 'chart-caption' }, 'Only recorded check-ins are plotted. Nothing is interpolated or predicted.'),
    ],
  });

  // ---- History table ----
  const pts = (a, key) => { const c = a.components.find((x) => x.key === key); return c.assessed ? c.points : '—'; };
  [...history].reverse().forEach((a) => {
    const i = history.indexOf(a);
    const btn = h('button', { class: 'link-btn', type: 'button', onclick: () => { select(i); document.getElementById('hb-hero')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }, fmtDateTime(a.measuredAt, tz));
    tableBody.append(h('tr', { dataset: { i: String(i) } },
      h('td', null, btn),
      h('td', { class: 'num' }, h('strong', null, a.score)),
      h('td', null, bandChip(a)),
      h('td', { class: 'num' }, pts(a, 'exposure')), h('td', { class: 'num' }, pts(a, 'symptoms')),
      h('td', { class: 'num' }, pts(a, 'biomarkers')), h('td', { class: 'num' }, pts(a, 'wellbeing')),
      h('td', null, a.triggers.length ? a.triggers.map((t) => t.label).join('; ') : h('span', { class: 'faint' }, '—'))));
  });
  const tablePanel = panel({
    title: 'Assessment history', iconName: 'table', id: 'hb-table',
    sub: 'Points contributed by each component. "—" means not assessed.',
    children: h('div', { class: 'table-wrap' }, h('table', { class: 'data hb-table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Check-in'), h('th', { scope: 'col', class: 'num' }, 'RHI'), h('th', { scope: 'col' }, 'Band'),
        h('th', { scope: 'col', class: 'num' }, 'Exposure /35'), h('th', { scope: 'col', class: 'num' }, 'Symptoms /30'),
        h('th', { scope: 'col', class: 'num' }, 'Biomarkers /20'), h('th', { scope: 'col', class: 'num' }, 'Wellbeing /15'),
        h('th', { scope: 'col' }, 'Hard triggers'))),
      tableBody)),
  });

  mount(root, head,
    h('div', { class: 'grid grid-12' },
      heroSlot, compSlot,
      h('div', { class: 'span-12' }, chartPanel),
      h('div', { class: 'span-12' }, tablePanel),
      h('div', { class: 'span-12' }, howPanel)));

  chart = rhiChart(canvas, history, tz, { onSelect: select, selected: () => sel });
  drawSelected();
  return () => destroyChart(chart);
}
