import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { LABELS, fmtDateTime, fmtDate, unitLabel, plural } from '../ui/format.js';
import { emptyState, loadingBlock, errorBlock, callout, busy, toast } from '../ui/components.js';
import { get, query } from '../api.js';
import { currentProfile, state } from '../state.js';
import { noProfileState } from './overview.js';

function isoDay(d) { return d.toISOString().slice(0, 10); }

export async function render(root, ctx) {
  const profile = currentProfile();
  if (!profile) { mount(root, noProfileState()); return null; }
  const tz = profile.timezone;
  const to = ctx.params.to || isoDay(new Date());
  const from = ctx.params.from || isoDay(new Date(Date.now() - 30 * 86_400_000));

  const fromIn = h('input', { class: 'input', type: 'date', id: 'rep-from', value: from, max: to });
  const toIn = h('input', { class: 'input', type: 'date', id: 'rep-to', value: to });
  const genBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('reports'), 'Prepare review summary');
  genBtn.addEventListener('click', () => ctx.navigate('/reports', { from: fromIn.value, to: toIn.value, run: '1' }));
  const reportSlot = h('div');

  mount(root,
    h('div', { class: 'page-head no-print' },
      h('div', null, h('h1', null, 'Reports'), h('p', null, 'Prepare an organised summary for medical review. MONICA does not send it anywhere — print it, save it as PDF, or export structured JSON and share it through your mission\'s channels.'))),
    h('div', { class: 'panel report-controls no-print' },
      h('div', { class: 'field' }, h('label', { for: 'rep-from' }, 'From'), fromIn),
      h('div', { class: 'field' }, h('label', { for: 'rep-to' }, 'To (inclusive)'), toIn),
      genBtn),
    reportSlot);

  if (!ctx.params.run) {
    mount(reportSlot, emptyState({ iconName: 'reports', center: true, title: 'Choose a reporting period', body: `The summary includes ${profile.displayName}'s readings, symptoms, observations, actions, follow-up history, missing-data notes, sources and prototype limitations for the period.` }));
    return null;
  }

  mount(reportSlot, loadingBlock('Preparing summary…'));
  let report;
  try {
    report = await get(`/profiles/${profile.id}/report${query({ from, to })}`);
  } catch (err) {
    mount(reportSlot, errorBlock(err, () => ctx.rerender()));
    return null;
  }
  if (!ctx.isCurrent()) return null;

  const printBtn = h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, icon('printer'), 'Print / save as PDF');
  const jsonBtn = h('button', { class: 'btn', type: 'button' }, icon('download'), 'Export JSON');
  jsonBtn.addEventListener('click', () => {
    const restore = busy(jsonBtn, 'Exporting…');
    try {
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `monica-review-${profile.displayName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${from}-to-${to}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('JSON exported — contains only this profile\'s records.');
    } finally { restore(); }
  });

  mount(reportSlot,
    h('div', { class: 'row report-toolbar no-print' }, printBtn, jsonBtn, h('span', { class: 'faint small' }, 'The export contains only records for this profile in your account.')),
    renderReport(report, tz));
  return null;
}

function section(title, ...children) {
  return h('section', { class: 'report-section' }, h('h2', null, title), children);
}

export function renderReport(r, tz) {
  const ref = state.reference;
  const p = r.profile;
  const levelOrder = { urgent_review: 0, attention: 1, info: 2 };
  const obs = [...r.observations].sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  return h('article', { class: 'report', 'aria-label': 'Health review summary' },
    h('header', { class: 'report-head' },
      h('div', { class: 'report-brand' }, 'MONICA · Health review summary'),
      h('h1', null, p.displayName, p.isFictional ? h('span', { class: 'report-tag' }, 'Fictional demo identity') : null),
      h('p', { class: 'report-sub' }, [p.roleTitle, p.missionName, p.missionPhase].filter(Boolean).join(' · ') || 'No mission context recorded'),
      h('dl', { class: 'kv report-meta' },
        h('dt', null, 'Reporting period'), h('dd', null, `${r.period.from ? fmtDate(r.period.from, tz) : 'Start'} – ${r.period.to ? fmtDate(r.period.to, tz) : 'Now'} (${tz})`),
        h('dt', null, 'Prepared'), h('dd', null, `${fmtDateTime(r.generatedAt, tz, { seconds: true })} by ${r.generatedFor.userDisplayName}`),
        h('dt', null, 'Rules version'), h('dd', { class: 'mono' }, r.rulesVersion),
        h('dt', null, 'Distribution'), h('dd', null, 'Prepared by MONICA. Not sent to anyone; share through your mission\'s own channels.'))),

    h('div', { class: 'report-limitations' }, h('strong', null, 'Prototype limitations. '), r.limitations.join(' ')),

    section(`Observations (${obs.length})`,
      obs.length === 0 ? h('p', { class: 'muted' }, 'No observations were generated in this period. This is not a health assessment.')
        : h('table', { class: 'data' },
          h('thead', null, h('tr', null, ['Level', 'Observation', 'Rule', 'Status', 'Generated'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, obs.map((o) => h('tr', null,
            h('td', null, LABELS.level[o.level]),
            h('td', null, h('strong', null, o.title), h('div', { class: 'small' }, o.explanation), h('div', { class: 'small muted' }, `Next step: ${o.suggestedNextStep}`)),
            h('td', { class: 'mono' }, `${o.ruleId}${o.isDemonstrationRule ? ' (demo)' : ''}`),
            h('td', null, LABELS.obsStatus[o.status]),
            h('td', null, fmtDateTime(o.createdAt, tz))))))),

    section(`Recorded check-ins (${r.checkIns.length})`,
      r.checkIns.length === 0 ? h('p', { class: 'muted' }, 'No check-ins recorded in this period.')
        : r.checkIns.map((c) => h('div', { class: 'report-checkin' },
          h('h3', null, `${fmtDateTime(c.measuredAt, tz)} · ${LABELS.context[c.activityContext]}`, c.contextNote ? h('span', { class: 'muted' }, ` — ${c.contextNote}`) : null),
          c.vitals.length ? h('table', { class: 'data compact' },
            h('thead', null, h('tr', null, ['Measurement', 'Value', 'Method', 'Source', 'Quality'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, c.vitals.map((v) => h('tr', null,
              h('td', null, ref.vitalMetrics[v.metric]?.label || v.metric), h('td', { class: 'num' }, `${v.value} ${unitLabel(v.unit)}`),
              h('td', null, v.method ? LABELS.tempMethod[v.method] : '—'), h('td', null, `${LABELS.source[v.sourceType]}${v.deviceLabel ? ` (${v.deviceLabel})` : ''}`), h('td', null, LABELS.quality[v.quality])))))
            : h('p', { class: 'small muted' }, 'Vital signs: not assessed.'),
          h('p', { class: 'small' }, h('strong', null, 'Symptoms: '), c.symptoms.length ? c.symptoms.map((s) => `${s.label} (${s.severity}${s.markedUrgent ? ', marked for prompt attention' : ''}${s.onsetNote ? `, onset ${s.onsetNote}` : s.onsetAt ? `, onset ${fmtDateTime(s.onsetAt, tz)}` : ''})`).join('; ') : LABELS.symptomStatus[c.symptomStatus]),
          h('p', { class: 'small' }, h('strong', null, 'Sleep & wellbeing (self-rated): '), [
            c.wellbeing.sleepDurationHours !== null ? `sleep ${c.wellbeing.sleepDurationHours} h` : null,
            c.wellbeing.sleepQuality !== null ? `sleep quality ${c.wellbeing.sleepQuality}/5` : null,
            c.wellbeing.fatigueRating !== null ? `fatigue ${c.wellbeing.fatigueRating}/10` : null,
            c.wellbeing.moodRating !== null ? `mood ${c.wellbeing.moodRating}/5` : null].filter(Boolean).join(', ') || 'not assessed'),
          c.medications.length ? h('p', { class: 'small' }, h('strong', null, 'Medications (as reported): '), c.medications.map((m) => `${m.name}${m.amount ? ` (${m.amount})` : ''}`).join('; ')) : null,
          c.notes ? h('p', { class: 'small' }, h('strong', null, 'Notes: '), c.notes) : null))),

    section(`Actions & follow-up (${r.actions.length})`,
      r.actions.length === 0 ? h('p', { class: 'muted' }, 'No actions or follow-ups recorded in this period.')
        : h('table', { class: 'data' },
          h('thead', null, h('tr', null, ['Type', 'Description', 'Status', 'Due / recorded', 'Completed'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, r.actions.map((a) => h('tr', null,
            h('td', null, a.kind === 'follow_up' ? 'Follow-up' : 'Action taken'), h('td', null, a.description, a.completionNote ? h('div', { class: 'small muted' }, `Completion note: ${a.completionNote}`) : null),
            h('td', null, LABELS.actionStatus[a.status]), h('td', null, fmtDateTime(a.scheduledFor || a.createdAt, tz)), h('td', null, a.completedAt ? fmtDateTime(a.completedAt, tz) : '—')))))),

    section('Baselines',
      r.baselines.length === 0 ? h('p', { class: 'muted' }, 'No baselines established; no baseline comparisons are included.')
        : h('ul', { class: 'plain bullets' }, r.baselines.map((b) => h('li', null,
          `${ref.vitalMetrics[b.metric]?.label}: ${b.value} ${unitLabel(b.unit)} — ${b.method === 'median_of_resting_readings' ? `median of ${b.sampleCount} resting readings` : `recorded value (${b.sourceNote || 'source noted'})`}, ${b.retiredAt ? `retired ${fmtDate(b.retiredAt, tz)}` : 'active'}, method ${b.methodVersion}.`)))),

    section('Missing-data notes', h('ul', { class: 'plain bullets' }, r.missingDataNotes.map((m) => h('li', null, m)))),

    section('Data sources & measurement context',
      h('p', { class: 'small' }, r.dataProvenance.healthRecords),
      h('p', { class: 'small' }, r.dataProvenance.calculatedValues),
      r.dataProvenance.nasaSources.length ? h('ul', { class: 'plain bullets small' }, r.dataProvenance.nasaSources.map((s) => h('li', null, `${s.title} — ${s.organisation}. ${s.url}`))) : null,
      h('p', { class: 'small muted' }, 'NASA radiation data are historical environmental measurements and are not part of this person\'s health record.')),

    section(`Event history (${r.eventHistory.length})`,
      r.eventHistory.length === 0 ? h('p', { class: 'muted' }, 'No events in this period.')
        : h('ul', { class: 'plain small history-list' }, r.eventHistory.slice(0, 80).map((e) => h('li', null, `${fmtDateTime(e.createdAt, tz)} — ${LABELS.audit[e.action] || e.action}${e.metadata?.ruleId ? ` (${e.metadata.ruleId})` : ''}`)))),

    h('footer', { class: 'report-foot' }, `MONICA research prototype · ${plural(r.checkIns.length, 'check-in')} · generated ${fmtDateTime(r.generatedAt, tz)} · not a medical record system and not affiliated with or endorsed by NASA.`));
}

export { callout };
