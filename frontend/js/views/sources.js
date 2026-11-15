import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fmtDate } from '../ui/format.js';
import { panel, emptyState, loadingBlock, errorBlock, badge, callout } from '../ui/components.js';
import { get } from '../api.js';
import { state } from '../state.js';

const CATEGORY = {
  environmental_observation: ['NASA environmental observations', 'teal', 'satellite'],
  scientific_reference: ['NASA scientific reference', 'info', 'sources'],
  documentation: ['Archive & API documentation', 'outline', 'note'],
};

export async function render(root, ctx) {
  mount(root, loadingBlock('Loading sources…'));
  let data;
  try {
    data = await get('/sources');
  } catch (err) {
    mount(root, errorBlock(err, () => ctx.rerender()));
    return null;
  }
  if (!ctx.isCurrent()) return null;
  const byKey = Object.fromEntries(data.sources.map((s) => [s.key, s]));
  const search = h('input', { class: 'input', type: 'search', id: 'src-search', placeholder: 'Search sources, topics and rules…', value: ctx.params.q || '', autocomplete: 'off' });
  const cardsSlot = h('div', { class: 'learn-grid' });
  const sourcesSlot = h('div', { class: 'source-list' });
  const rulesSlot = h('div');
  const countSlot = h('span', { class: 'faint small', 'aria-live': 'polite' });

  const match = (q, ...texts) => !q || texts.join(' ').toLowerCase().includes(q);

  function draw() {
    const q = search.value.trim().toLowerCase();
    const cards = data.learning.filter((c) => match(q, c.title, c.summary, c.monicaPolicy, ...c.points.map((p) => p.text)));
    const srcs = data.sources.filter((s) => match(q, s.title, s.organisation, s.monicaUsage, s.datasetIdentifier || '', s.notes || '', s.key));
    const rules = (state.reference?.rules || []).filter((r) => match(q, r.id, r.title, r.description, r.category));
    countSlot.textContent = `${cards.length} topic(s), ${srcs.length} source(s), ${rules.length} rule(s)`;

    mount(cardsSlot, cards.length ? cards.map((c) => h('article', { class: ['learn-card', ctx.params.card === c.id && 'highlight'], id: `card-${c.id}` },
      h('h3', null, c.title),
      h('p', { class: 'learn-summary' }, c.summary),
      h('ol', { class: 'cited' }, c.points.map((p) => {
        const s = byKey[p.sourceKey];
        return h('li', null, h('p', null, p.text),
          h('p', { class: 'cite' }, icon('link', { size: 12 }), ' ',
            s ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title) : p.sourceKey, ` — ${p.locator}`));
      })),
      h('p', { class: 'policy' }, h('strong', null, 'In MONICA: '), c.monicaPolicy))) : emptyState({ iconName: 'search', title: 'No matching topics', body: 'Try a different search term.' }));

    mount(sourcesSlot, srcs.length ? srcs.map((s) => {
      const [catLabel, catCls, catIcon] = CATEGORY[s.category] || [s.category, 'outline', 'info'];
      return h('article', { class: 'source-item' },
        h('div', { class: 'row' }, badge(catLabel, catCls, catIcon), s.datasetIdentifier ? h('span', { class: 'badge outline mono' }, s.datasetIdentifier) : null),
        h('h3', null, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title, ' ', icon('external', { size: 13 }))),
        h('p', { class: 'faint small' }, s.organisation),
        h('dl', { class: 'kv' },
          h('dt', null, 'Retrieved'), h('dd', null, s.retrievedAt ? fmtDate(s.retrievedAt, 'UTC') : h('span', { class: 'text-attention' }, 'Not retrieved — see note')),
          s.observationCoverage ? [h('dt', null, 'Coverage'), h('dd', null, s.observationCoverage)] : null,
          h('dt', null, 'How MONICA uses it'), h('dd', null, s.monicaUsage),
          s.notes ? [h('dt', null, 'Notes'), h('dd', null, s.notes)] : null,
          h('dt', null, 'URL'), h('dd', { class: 'mono small' }, s.url)));
    }) : emptyState({ iconName: 'search', title: 'No matching sources', body: 'Try a different search term.' }));

    mount(rulesSlot, rules.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, ['Rule', 'What it does', 'Category', 'Type'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rules.map((r) => h('tr', null,
        h('td', { class: 'mono nowrap' }, `${r.id} v${r.version}`),
        h('td', null, h('strong', null, r.title), h('div', { class: 'small muted' }, r.description)),
        h('td', null, r.category.replace('_', ' ')),
        h('td', null, r.demonstration ? 'Demonstration' : 'Validated'))))))
      : h('p', { class: 'faint' }, 'No matching rules.'));
  }
  search.addEventListener('input', draw);

  mount(root,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Sources & learning'), h('p', null, 'Every scientific statement in MONICA links to a NASA source. MONICA is an independent prototype and is not endorsed by NASA.'))),
    h('div', { class: 'search-row' }, h('label', { class: 'visually-hidden', for: 'src-search' }, 'Search'), icon('search'), search, countSlot),
    h('section', { class: 'stack-lg', 'aria-labelledby': 'learn-h' },
      h('h2', { id: 'learn-h', class: 'section-title' }, 'Learning'),
      cardsSlot),
    panel({ title: 'Transparent rule catalogue', iconName: 'actions', id: 'rules', sub: `Rules version ${state.reference?.rulesVersion || ''}. Every observation shows its rule ID and inputs.`,
      children: [callout({ tone: 'info', body: 'All current rules are demonstration rules: they use only what was recorded, and apply no verified clinical thresholds. The Health Brain index (RHI, rules HB-001 and HB-002) uses prototype weights and cut-offs that still need calibration with NASA-STD-3001 and clinical review. No treatment protocol is configured.' }), rulesSlot] }),
    h('section', { class: 'stack-lg', 'aria-labelledby': 'src-h' },
      h('h2', { id: 'src-h', class: 'section-title' }, 'Source registry'),
      sourcesSlot));
  draw();
  if (ctx.params.card) document.getElementById(`card-${ctx.params.card}`)?.scrollIntoView({ block: 'center' });
  return null;
}
