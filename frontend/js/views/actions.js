import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { LABELS, fmtDateTime, fmtRelative, unitLabel, isoToZonedInput, zonedInputToIso, plural } from '../ui/format.js';
import { panel, emptyState, loadingBlock, errorBlock, callout, levelBadge, categoryBadge, badge, segmented, openModal, busy, toast, validationList, linkButton } from '../ui/components.js';
import { get, post, patch } from '../api.js';
import { currentProfile, state } from '../state.js';
import { noProfileState } from './overview.js';

const ACTION_LABELS = LABELS.audit;

export async function render(root, ctx) {
  const profile = currentProfile();
  if (!profile) { mount(root, noProfileState()); return null; }
  const tz = profile.timezone;
  const tab = ['observations', 'follow-ups', 'history'].includes(ctx.params.tab) ? ctx.params.tab : 'observations';
  const filter = ['open', 'acknowledged', 'resolved', 'all'].includes(ctx.params.status) ? ctx.params.status : 'open';
  const selected = ctx.params.obs || null;

  const go = (p) => ctx.navigate('/actions', { tab, status: filter, ...p });

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Actions sections' },
    [['observations', 'Observations'], ['follow-ups', 'Follow-ups & actions'], ['history', 'Event history']].map(([k, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => ctx.navigate('/actions', { tab: k }) }, label)));
  const body = h('div', null, loadingBlock());
  mount(root,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Actions & follow-up'), h('p', null, 'Review why each observation was raised, acknowledge it, record what you did and schedule follow-up check-ins. MONICA never contacts anyone on your behalf.')),
      h('div', { class: 'page-actions' }, linkButton('Prepare review summary', '#/reports', { iconName: 'reports' }))),
    tabs, body);

  try {
    if (tab === 'observations') await drawObservations(body, { profile, tz, filter, selected, go, ctx });
    else if (tab === 'follow-ups') await drawFollowUps(body, { profile, tz, ctx });
    else await drawHistory(body, { profile, tz });
  } catch (err) {
    if (err.status === 401) throw err;
    mount(body, errorBlock(err, () => ctx.rerender()));
  }
  return null;
}

// ---------------- Observations ----------------
async function drawObservations(body, { profile, tz, filter, selected, go, ctx }) {
  const qs = filter === 'all' ? '' : `?status=${filter}`;
  const { observations } = await get(`/profiles/${profile.id}/observations${qs}`);
  if (!ctx.isCurrent()) return;

  const filterBar = h('div', { class: 'row-between filter-bar' },
    segmented({ name: 'obs-status', label: 'Status filter', value: filter, options: [
      { value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'resolved', label: 'Closed' }, { value: 'all', label: 'All' }], onChange: (v) => go({ status: v, obs: undefined }) }),
    h('span', { class: 'faint small' }, plural(observations.length, 'observation')));

  const listEl = observations.length === 0
    ? emptyState({ iconName: 'checkCircle', title: filter === 'open' ? 'No open observations' : 'Nothing here', body: filter === 'open' ? 'Observations are generated from check-ins by MONICA\'s demonstration rules. An empty list is not a health assessment.' : 'No observations match this filter.' })
    : h('ul', { class: 'obs-list' }, observations.map((o) => h('li', null,
      h('a', { class: ['obs-item', o.id === selected && 'selected', o.level], href: `#/actions?tab=observations&status=${filter}&obs=${o.id}`, 'aria-current': o.id === selected ? 'true' : undefined },
        h('div', { class: 'row' }, levelBadge(o.level), h('span', { class: 'faint small' }, `${o.ruleId} · ${LABELS.obsStatus[o.status]}`)),
        h('div', { class: 'obs-title' }, o.title),
        h('div', { class: 'faint small' }, `${LABELS.category[o.category]} · ${fmtRelative(o.createdAt)}`)))));

  const detailSlot = h('div', { class: 'obs-detail-slot' });
  mount(body, h('div', { class: ['obs-layout', selected && 'has-selection'] },
    h('div', { class: 'obs-list-col' }, filterBar, listEl),
    detailSlot));

  if (selected) await drawDetail(detailSlot, { profile, tz, id: selected, go, ctx });
  else mount(detailSlot, h('div', { class: 'panel obs-placeholder' }, emptyState({ iconName: 'actions', title: 'Select an observation', body: 'Details include the rule that produced it, the exact inputs, missing information, the suggested next step and its full history.' })));
}

function renderInputs(value) {
  if (value === null || value === undefined) return h('span', { class: 'faint' }, '—');
  if (Array.isArray(value)) {
    if (value.length === 0) return h('span', { class: 'faint' }, 'none');
    return h('ul', { class: 'plain' }, value.map((v) => h('li', null, typeof v === 'object' ? renderInputs(v) : String(v))));
  }
  if (typeof value === 'object') {
    return h('dl', { class: 'kv nested' }, Object.entries(value).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, typeof v === 'object' && v !== null ? renderInputs(v) : String(v))]));
  }
  return String(value);
}

async function drawDetail(slot, { profile, tz, id, go, ctx }) {
  mount(slot, loadingBlock('Loading observation…'));
  let data;
  try {
    data = await get(`/profiles/${profile.id}/observations/${id}`);
  } catch (err) {
    mount(slot, err.status === 404 ? emptyState({ iconName: 'unknown', title: 'Observation not found', body: 'It may belong to another profile.' }) : errorBlock(err, () => ctx.rerender()));
    return;
  }
  const o = data.observation;
  const ci = data.supportingCheckIn;

  async function act(btn, fn, okMsg) {
    const restore = busy(btn, 'Saving…');
    try {
      await fn();
      toast(okMsg);
      ctx.refreshCounts();
      ctx.rerender();
    } catch (err) {
      restore();
      toast(`Not saved: ${err.message}`, { tone: 'error' });
    }
  }

  const ackBtn = o.status === 'open' ? h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, icon('check'), 'Acknowledge') : null;
  ackBtn?.addEventListener('click', () => act(ackBtn, () => post(`/profiles/${profile.id}/observations/${o.id}/acknowledge`), 'Observation acknowledged.'));
  const closeBtn = o.status !== 'resolved' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, icon('x'), 'Close observation') : null;
  closeBtn?.addEventListener('click', () => act(closeBtn, () => post(`/profiles/${profile.id}/observations/${o.id}/close`), 'Observation closed.'));
  const recordBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => actionModal({ profile, tz, kind: 'action_taken', observation: o, ctx }) }, icon('note'), 'Record action taken');
  const followBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => actionModal({ profile, tz, kind: 'follow_up', observation: o, ctx }) }, icon('calendar'), 'Schedule follow-up');

  const reportFrom = ci ? new Date(new Date(ci.measuredAt).getTime() - 7 * 86_400_000).toISOString().slice(0, 10) : undefined;
  const tone = o.level === 'urgent_review' ? 'urgent' : o.level === 'attention' ? 'attention' : 'info';

  mount(slot, h('article', { class: ['panel', 'obs-detail', o.level], 'aria-labelledby': 'obs-title' },
    h('button', { class: 'btn btn-ghost btn-sm back-btn', type: 'button', onclick: () => go({ obs: undefined }) }, icon('chevronLeft'), 'All observations'),
    h('div', { class: 'row' }, levelBadge(o.level), categoryBadge(o.category), o.isDemonstrationRule ? badge('Demonstration rule', 'outline', 'flask') : null, badge(LABELS.obsStatus[o.status], o.status === 'open' ? 'teal' : 'unknown')),
    h('h2', { id: 'obs-title', class: 'obs-detail-title' }, o.title),
    h('p', { class: 'faint small' }, `Rule ${o.ruleId} · version ${o.ruleVersion} · generated ${fmtDateTime(o.createdAt, tz)}`),
    h('div', { class: 'row action-row' }, ackBtn, recordBtn, followBtn, linkButton('Prepare review summary', `#/reports?from=${reportFrom || ''}`, { size: 'sm', iconName: 'reports' }), closeBtn),
    h('section', { class: 'obs-section' }, h('h3', null, 'Why this was raised'), h('p', null, o.explanation)),
    callout({ tone, iconName: 'arrowRight', title: 'Suggested next step', body: o.suggestedNextStep }),
    h('section', { class: 'obs-section' }, h('h3', null, 'Triggering inputs'), renderInputs(o.triggeringInputs)),
    h('section', { class: 'obs-section' }, h('h3', null, 'Missing information'),
      o.missingInformation?.length ? h('ul', { class: 'plain bullets' }, o.missingInformation.map((m) => h('li', null, m))) : h('p', { class: 'faint' }, 'None listed by the rule.')),
    h('section', { class: 'obs-section' }, h('h3', null, 'Reference'),
      o.reference ? h('a', { href: o.reference.url, target: '_blank', rel: 'noopener noreferrer' }, o.reference.title) : h('p', { class: 'faint' }, 'No external clinical reference: this demonstration rule works only from what was recorded, without clinical thresholds. See Sources & learning for the rule catalogue.')),
    ci ? h('section', { class: 'obs-section' }, h('h3', null, 'Supporting check-in'),
      h('p', { class: 'small muted' }, `${fmtDateTime(ci.measuredAt, tz)} · ${LABELS.context[ci.activityContext]} · source: user-entered`),
      ci.vitals.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Measurement', 'Value', 'Source', 'Quality'].map((t, i) => h('th', { scope: 'col', class: i === 1 ? 'num' : undefined }, t)))),
        h('tbody', null, ci.vitals.map((v) => h('tr', null,
          h('td', null, state.reference.vitalMetrics[v.metric]?.label || v.metric),
          h('td', { class: 'num' }, `${v.value} ${unitLabel(v.unit)}`),
          h('td', null, `${LABELS.source[v.sourceType]}${v.deviceLabel ? ` (${v.deviceLabel})` : ''}`),
          h('td', null, LABELS.quality[v.quality])))))) : h('p', { class: 'faint small' }, 'Vital signs not assessed in this check-in.'),
      ci.symptoms.length ? h('ul', { class: 'plain bullets' }, ci.symptoms.map((s) => h('li', null, `${s.label} — ${LABELS.severity[s.severity]}${s.markedUrgent ? ' · marked as needing prompt attention' : ''}${s.onsetNote ? ` · onset: ${s.onsetNote}` : ''}`))) : h('p', { class: 'faint small' }, LABELS.symptomStatus[ci.symptomStatus] || 'No symptoms recorded.')) : null,
    h('section', { class: 'obs-section' }, h('h3', null, `Actions & follow-ups (${data.actions.length})`),
      data.actions.length ? h('ul', { class: 'list' }, data.actions.map((a) => actionItem(a, tz, profile, ctx))) : h('p', { class: 'faint' }, 'None recorded yet.')),
    h('section', { class: 'obs-section' }, h('h3', null, 'Event history'),
      h('ol', { class: 'timeline' }, [...data.history].reverse().map((ev) => h('li', null, h('div', null, ACTION_LABELS[ev.action] || ev.action), h('div', { class: 'tl-time' }, fmtDateTime(ev.createdAt, tz, { seconds: true }))))))));
}

function actionItem(a, tz, profile, ctx) {
  const isFollow = a.kind === 'follow_up';
  const due = a.scheduledFor ? new Date(a.scheduledFor) : null;
  const passed = isFollow && a.status === 'planned' && due < new Date();
  const controls = [];
  if (isFollow && a.status === 'planned') {
    controls.push(h('a', { class: 'btn btn-sm btn-primary', href: `#/check-in?followUp=${a.id}` }, 'Complete with check-in'));
    const done = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => completeModal({ profile, action: a, ctx }) }, 'Mark complete');
    const cancel = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', async () => {
      const restore = busy(cancel, '…');
      try { await patch(`/profiles/${profile.id}/actions/${a.id}`, { status: 'cancelled' }); toast('Follow-up cancelled.'); ctx.rerender(); } catch (err) { restore(); toast(`Not saved: ${err.message}`, { tone: 'error' }); }
    });
    controls.push(done, cancel);
  }
  return h('li', null,
    h('span', { class: ['li-icon', isFollow ? (passed ? 'attention' : 'info') : 'teal'] }, icon(isFollow ? 'calendar' : 'note')),
    h('div', { class: 'li-main' },
      h('div', { class: 'li-title' }, a.description),
      h('div', { class: 'li-meta' },
        h('span', null, isFollow ? `Follow-up · ${LABELS.actionStatus[a.status]}` : 'Action taken'),
        due ? h('span', null, `Due ${fmtDateTime(due, tz)}`) : h('span', null, `Recorded ${fmtDateTime(a.createdAt, tz)}`),
        passed ? h('span', { class: 'text-attention' }, 'Due time passed') : null,
        a.completedAt ? h('span', null, `Completed ${fmtDateTime(a.completedAt, tz)}`) : null,
        a.completionCheckInId ? h('span', null, 'Linked to a check-in') : null,
        a.completionNote ? h('span', null, `Note: ${a.completionNote}`) : null,
        a.observationId ? h('a', { href: `#/actions?obs=${a.observationId}` }, 'View observation') : null),
      controls.length ? h('div', { class: 'row li-actions' }, controls) : null));
}

function actionModal({ profile, tz, kind, observation, ctx }) {
  const isFollow = kind === 'follow_up';
  const desc = h('textarea', { class: 'input', id: 'act-desc', rows: 3, maxlength: 1000, required: true },
    isFollow ? `Follow-up check-in for: ${observation?.title || ''}`.trim() : '');
  const when = isFollow ? h('input', { class: 'input', id: 'act-when', type: 'datetime-local', value: isoToZonedInput(new Date(Date.now() + 24 * 3600_000), tz), required: true }) : null;
  const err = h('div', { 'aria-live': 'assertive' });
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, isFollow ? 'Schedule follow-up' : 'Record action');
  const m = openModal({
    title: isFollow ? 'Schedule a follow-up check-in' : 'Record an action taken',
    body: [
      isFollow ? null : h('p', { class: 'muted small' }, 'Describe what was done, e.g. "Repeated measurement after 15 minutes rest" or "Shared summary with flight surgeon via mission channel". MONICA records your description; it does not perform or send anything.'),
      h('div', { class: 'field' }, h('label', { for: 'act-desc' }, 'Description'), desc),
      when ? h('div', { class: 'field' }, h('label', { for: 'act-when' }, 'Due'), when, h('span', { class: 'hint' }, `Time zone: ${tz}`)) : null,
      err],
    footer: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), save],
  });
  save.addEventListener('click', async () => {
    const restore = busy(save, 'Saving…');
    try {
      await post(`/profiles/${profile.id}/actions`, {
        kind, description: desc.value, observationId: observation?.id,
        scheduledFor: when ? zonedInputToIso(when.value, tz) : undefined,
      });
      m.close();
      toast(isFollow ? 'Follow-up scheduled.' : 'Action recorded.');
      ctx.rerender();
    } catch (e) {
      restore();
      mount(err, callout({ tone: 'urgent', title: 'Not saved', body: e.message, children: validationList(e.details) }));
    }
  });
  desc.focus();
}

function completeModal({ profile, action, ctx }) {
  const note = h('textarea', { class: 'input', id: 'done-note', rows: 3, maxlength: 1000 });
  const err = h('div', { 'aria-live': 'assertive' });
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Mark complete');
  const m = openModal({
    title: 'Complete follow-up without a check-in',
    body: [h('p', { class: 'muted small' }, 'Prefer "Complete with check-in" when you have new readings. Use this when the follow-up was completed another way.'),
      h('div', { class: 'field' }, h('label', { for: 'done-note' }, 'Completion note'), note), err],
    footer: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), save],
  });
  save.addEventListener('click', async () => {
    const restore = busy(save, 'Saving…');
    try {
      await patch(`/profiles/${profile.id}/actions/${action.id}`, { status: 'completed', completionNote: note.value || undefined });
      m.close();
      toast('Follow-up completed.');
      ctx.rerender();
    } catch (e) {
      restore();
      mount(err, callout({ tone: 'urgent', title: 'Not saved', body: e.message }));
    }
  });
}

// ---------------- Follow-ups ----------------
async function drawFollowUps(body, { profile, tz, ctx }) {
  const { actions } = await get(`/profiles/${profile.id}/actions`);
  if (!ctx.isCurrent()) return;
  const planned = actions.filter((a) => a.status === 'planned');
  const other = actions.filter((a) => a.status !== 'planned');
  const newFollow = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => actionModal({ profile, tz, kind: 'follow_up', observation: null, ctx }) }, icon('plus'), 'Schedule follow-up');
  const newAction = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => actionModal({ profile, tz, kind: 'action_taken', observation: null, ctx }) }, icon('note'), 'Record action');
  mount(body, h('div', { class: 'grid grid-2' },
    panel({ title: `Planned follow-ups (${planned.length})`, iconName: 'calendar', actions: newFollow,
      children: planned.length ? h('ul', { class: 'list' }, planned.map((a) => actionItem(a, tz, profile, ctx))) : emptyState({ iconName: 'calendar', title: 'No planned follow-ups', body: 'Schedule one from an observation, or here for a general check.' }) }),
    panel({ title: `Recorded actions & completed (${other.length})`, iconName: 'note', actions: newAction,
      children: other.length ? h('ul', { class: 'list' }, other.map((a) => actionItem(a, tz, profile, ctx))) : emptyState({ iconName: 'note', title: 'Nothing recorded yet', body: 'Recorded actions describe what was done in response to an observation.' }) })));
}

// ---------------- History ----------------
async function drawHistory(body, { profile, tz }) {
  const { history } = await get(`/profiles/${profile.id}/history?limit=200`);
  mount(body, panel({ title: 'Event history', iconName: 'history', sub: 'Every recorded change for this profile. History stores identifiers and counts only — never readings or notes.',
    children: history.length === 0 ? emptyState({ iconName: 'history', title: 'No events yet', body: 'Check-ins, acknowledgements, actions and follow-ups appear here.' })
      : h('ol', { class: 'timeline' }, history.map((ev) => h('li', null,
        h('div', null, ACTION_LABELS[ev.action] || ev.action, ev.metadata?.ruleId ? h('span', { class: 'faint' }, ` · ${ev.metadata.ruleId}`) : null),
        h('div', { class: 'tl-time' }, `${fmtDateTime(ev.createdAt, tz, { seconds: true })} · ${ev.entityType}`)))) }));
}
