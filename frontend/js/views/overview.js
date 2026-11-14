import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fmtDateTime, fmtLongDate, fmtRelative, fmtNum, unitLabel, LABELS, tzName, plural } from '../ui/format.js';
import { panel, emptyState, loadingBlock, errorBlock, levelBadge, categoryBadge, linkButton, provenance, historicalBadge, badge } from '../ui/components.js';
import { get } from '../api.js';
import { state, currentProfile, setOpenCounts } from '../state.js';

export const METRIC_ICON = {
  heart_rate: 'heart', spo2: 'droplet', temperature: 'thermometer', bp_systolic: 'gauge', bp_diastolic: 'gauge', respiratory_rate: 'wind',
  sleep_duration_hours: 'moon', sleep_quality: 'moon', fatigue_rating: 'battery', mood_rating: 'smile',
};

export function noProfileState() {
  return emptyState({
    iconName: 'user', center: true, title: 'No profile yet',
    body: 'Create a profile to start recording check-ins. A profile holds one person\'s readings, baselines and follow-up history.',
    action: linkButton('Create a profile', '#/settings', { variant: 'primary', iconName: 'plus' }),
  });
}

/** Systolic and diastolic come from one measurement, so they share one tile. */
function bpTile(sys, dia, tz) {
  const label = 'Blood pressure';
  const hasBaseline = sys.hasBaseline || dia.hasBaseline;
  if (!sys.reading || !dia.reading) {
    return h('div', { class: 'metric is-empty' },
      h('div', { class: 'metric-head' }, icon('gauge'), label),
      h('div', { class: 'metric-empty' }, icon('unknown'), 'No reading recorded'),
      h('div', { class: 'metric-meta' }, hasBaseline ? 'Baseline established' : 'No baseline'));
  }
  const r = sys.reading;
  return h('div', { class: 'metric' },
    h('div', { class: 'metric-head' }, icon('gauge'), label),
    h('div', { class: 'metric-value num' }, `${fmtNum(sys.reading.value)}/${fmtNum(dia.reading.value)}`, h('span', { class: 'unit' }, 'mmHg')),
    h('div', { class: 'metric-meta' },
      h('span', { title: fmtDateTime(r.measuredAt, tz) }, fmtRelative(r.measuredAt)),
      h('span', null, LABELS.context[r.activityContext] || r.activityContext),
      h('span', null, LABELS.source[r.sourceType]),
      r.quality !== 'good' ? h('span', null, LABELS.quality[r.quality]) : null));
}

function vitalTile(v, tz) {
  const r = v.reading;
  if (!r) {
    return h('div', { class: 'metric is-empty' },
      h('div', { class: 'metric-head' }, icon(METRIC_ICON[v.metric]), v.label),
      h('div', { class: 'metric-empty' }, icon('unknown'), 'No reading recorded'),
      h('div', { class: 'metric-meta' }, v.hasBaseline ? 'Baseline established' : 'No baseline'));
  }
  return h('div', { class: 'metric' },
    h('div', { class: 'metric-head' }, icon(METRIC_ICON[v.metric]), v.label),
    h('div', { class: 'metric-value num' }, fmtNum(r.value), h('span', { class: 'unit' }, unitLabel(r.unit))),
    h('div', { class: 'metric-meta' },
      h('span', { title: fmtDateTime(r.measuredAt, tz) }, fmtRelative(r.measuredAt)),
      h('span', null, LABELS.context[r.activityContext] || r.activityContext),
      h('span', null, LABELS.source[r.sourceType]),
      r.quality !== 'good' ? h('span', null, LABELS.quality[r.quality]) : null));
}

function wellbeingTile(w, tz) {
  if (!w.reading) {
    return h('div', { class: 'metric is-empty mini' },
      h('div', { class: 'metric-head' }, icon(METRIC_ICON[w.metric]), w.label),
      h('div', { class: 'metric-empty' }, icon('unknown'), 'Not assessed'));
  }
  const anchor = w.anchors?.[w.reading.value];
  return h('div', { class: 'metric mini' },
    h('div', { class: 'metric-head' }, icon(METRIC_ICON[w.metric]), w.label),
    h('div', { class: 'metric-value num' }, fmtNum(w.reading.value), h('span', { class: 'unit' }, w.metric === 'sleep_duration_hours' ? 'h' : w.unit.replace(' self-rating', ''))),
    h('div', { class: 'metric-meta' }, anchor ? h('span', null, anchor) : null, h('span', { title: fmtDateTime(w.reading.measuredAt, tz) }, fmtRelative(w.reading.measuredAt)), h('span', null, 'Self-reported')));
}

export async function render(root, ctx) {
  const profile = currentProfile();
  if (!profile) { mount(root, noProfileState()); return null; }
  mount(root, loadingBlock('Loading overview…'));

  let data;
  try {
    data = await get(`/profiles/${profile.id}/overview`);
  } catch (err) {
    if (err.status === 401) throw err;
    mount(root, errorBlock(err, () => ctx.rerender()));
    return null;
  }
  if (!ctx.isCurrent()) return null;
  setOpenCounts(data.observations.openByLevel);

  const tz = data.profile.timezone;
  const p = data.profile;
  const lastUpdate = data.checkIns.lastMeasuredAt;

  // ---- Header ----
  const header = h('div', { class: 'overview-head' },
    h('div', { class: 'overview-id' },
      h('div', { class: 'row' },
        h('h1', null, p.displayName),
        p.isFictional ? badge('Fictional demo identity', 'outline', 'user') : null),
      h('p', { class: 'muted' }, [p.roleTitle, p.missionName, p.missionPhase].filter(Boolean).join(' · ') || 'No mission context recorded — add it in Profile & settings.'),
      h('div', { class: 'overview-meta' },
        h('span', null, icon('calendar'), fmtLongDate(new Date(), tz), ` · ${tzName(tz)}`),
        h('span', null, icon('clock'), lastUpdate ? `Last check-in ${fmtRelative(lastUpdate)} (${fmtDateTime(lastUpdate, tz)})` : 'No check-ins yet'),
        h('span', null, icon('database'), `Data loaded ${fmtDateTime(data.generatedAt, tz)}`))),
    h('div', { class: 'page-actions' },
      linkButton('Start health check-in', '#/check-in', { variant: 'primary', iconName: 'plus', size: 'lg' })));

  // ---- Vital signs ----
  const anyVitals = data.vitals.some((v) => v.reading);
  const vitalsPanel = panel({
    title: 'Latest vital signs', iconName: 'heart', id: 'ov-vitals',
    sub: 'Most recent value of each measurement, with its time, context and source. Values are user-entered or user-reported from a device.',
    actions: anyVitals ? linkButton('View trends', '#/trends', { size: 'sm', iconName: 'trends' }) : null,
    children: [
      !anyVitals ? h('div', { class: 'callout-slim' }, icon('info'), 'No vital signs have been recorded for this profile. Nothing below is assumed to be normal.') : null,
      h('div', { class: 'metric-grid vitals' }, data.vitals.map((v) => {
        if (v.metric === 'bp_diastolic') return null;
        if (v.metric === 'bp_systolic') return bpTile(v, data.vitals.find((x) => x.metric === 'bp_diastolic'), tz);
        return vitalTile(v, tz);
      })),
      h('div', { class: 'divider-label wb-label' }, 'Sleep & wellbeing (self-reported)'),
      h('div', { class: 'metric-grid compact' }, data.wellbeing.map((w) => wellbeingTile(w, tz))),
    ],
  });

  // ---- Health observations ----
  const obs = data.observations;
  const obsPanel = panel({
    title: 'Health observations', iconName: 'actions', id: 'ov-obs',
    sub: 'Generated by transparent, versioned rules. No combined health score is calculated.',
    children: obs.open.length === 0
      ? emptyState({ iconName: 'checkCircle', title: 'No open observations', body: data.checkIns.total ? 'Rules found nothing to raise in recorded check-ins. This is not a statement that the crew member is healthy.' : 'Observations appear after check-ins are recorded.' })
      : h('div', { class: 'stack' },
        h('div', { class: 'row level-counts' },
          obs.openByLevel.urgent_review ? h('span', { class: 'badge urgent' }, icon('urgent'), `${obs.openByLevel.urgent_review} urgent review`) : null,
          obs.openByLevel.attention ? h('span', { class: 'badge attention' }, icon('attention'), `${obs.openByLevel.attention} attention`) : null,
          obs.openByLevel.info ? h('span', { class: 'badge info' }, icon('info'), `${obs.openByLevel.info} information`) : null),
        h('ul', { class: 'list' }, obs.open.slice(0, 4).map((o) => h('li', null,
          h('span', { class: ['li-icon', o.level === 'urgent_review' ? 'urgent' : o.level === 'attention' ? 'attention' : 'info'] }, icon(o.level === 'urgent_review' ? 'urgent' : o.level === 'attention' ? 'attention' : 'info')),
          h('div', { class: 'li-main' },
            h('a', { class: 'li-title', href: `#/actions?obs=${o.id}` }, o.title),
            h('div', { class: 'li-meta' }, h('span', null, `${o.ruleId} · ${LABELS.category[o.category]}`), h('span', null, fmtRelative(o.createdAt)))))))),
    actions: obs.open.length ? linkButton('View all', '#/actions', { size: 'sm' }) : null,
  });

  // ---- Radiation environment ----
  const rad = data.environment.radiation;
  const radPanel = panel({
    title: 'Radiation environment', iconName: 'radiation', id: 'ov-rad',
    sub: 'Mars surface environment measured by the Curiosity rover — not personal dosimetry.',
    children: rad.length === 0
      ? emptyState({ iconName: 'satellite', title: 'NASA data not imported', body: 'No historical RAD observations are stored yet. An administrator imports them with the documented CLI.' })
      : h('div', { class: 'stack' },
        h('div', { class: 'row' }, historicalBadge(), h('span', { class: 'badge outline' }, 'MSL RAD · PDS')),
        h('dl', { class: 'kv stacked' },
          h('dt', null, 'Observation dates'), h('dd', null, `${fmtDateTime(rad[0].firstObservation, 'UTC')} → ${fmtDateTime(rad[0].lastObservation, 'UTC')}`),
          h('dt', null, 'Sols'), h('dd', { class: 'num' }, `${rad[0].firstSol}–${rad[0].lastSol}`),
          h('dt', null, 'Channels'), h('dd', null, rad.map((r) => `Detector ${r.detector} (${plural(r.samplesWithValue, 'sample')})`).join(' · ')),
          h('dt', null, 'Quantity'), h('dd', null, `Absorbed dose rate, ${unitLabel(rad[0].unit)}`),
          h('dt', null, 'Imported'), h('dd', null, fmtDateTime(rad[0].lastImportedAt, tz))),
        data.environment.spaceWeather ? provenance(`${plural(data.environment.spaceWeather.events, 'DONKI event')} stored for context`, 'sun') : null),
    actions: linkButton('Open', '#/environment', { size: 'sm' }),
  });

  // ---- Data quality ----
  const dq = data.dataQuality;
  const totalReadings = Object.values(dq.readingsBySource).reduce((a, b) => a + b, 0);
  const dqPanel = panel({
    title: 'Data quality', iconName: 'database', id: 'ov-dq',
    sub: 'Where readings came from and what is missing.',
    children: h('div', { class: 'stack' },
      totalReadings === 0
        ? h('p', { class: 'muted small' }, 'No vital-sign readings recorded yet.')
        : h('div', { class: 'dq-bars' },
          dqBar('Manual entry', dq.readingsBySource.manual, totalReadings),
          dqBar('Device-reported', dq.readingsBySource.device_reported, totalReadings),
          dqBar('Marked uncertain or poor', dq.readingsByQuality.uncertain + dq.readingsByQuality.poor, totalReadings, 'attention')),
      h('dl', { class: 'kv stacked' },
        h('dt', null, 'Never recorded'), h('dd', null, dq.metricsNeverRecorded.length === data.vitals.length ? 'All vital signs — no readings yet' : (dq.metricsNeverRecorded.length ? dq.metricsNeverRecorded.join(', ') : 'Every measurement has at least one reading')),
        h('dt', null, 'Baselines'), h('dd', null, data.baselines.length ? `${data.baselines.length} established — others: comparison unavailable` : 'None established — comparison unavailable'))),
    actions: linkButton('Baselines', '#/settings', { size: 'sm' }),
  });

  // ---- Recent check-ins ----
  const recent = panel({
    title: 'Recent check-ins', iconName: 'checkin', id: 'ov-recent',
    children: data.recentCheckIns.length === 0
      ? emptyState({ iconName: 'checkin', title: 'No check-ins yet', body: 'A check-in records vital signs, symptoms, sleep and wellbeing at a moment in time. Every field is optional.', action: linkButton('Start health check-in', '#/check-in', { variant: 'primary', iconName: 'plus' }) })
      : h('ul', { class: 'list' }, data.recentCheckIns.map((c) => h('li', null,
        h('span', { class: 'li-icon teal' }, icon('checkin')),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title' }, fmtDateTime(c.measuredAt, tz)),
          h('div', { class: 'li-meta' },
            h('span', null, LABELS.context[c.activityContext]),
            h('span', null, c.vitalsCount ? plural(c.vitalsCount, 'vital sign') : 'Vitals not assessed'),
            h('span', null, c.symptomsCount ? c.symptoms.map((s) => `${s.label} (${s.severity})`).join(', ') : LABELS.symptomStatus[c.symptomStatus]))),
        c.symptoms.some((s) => s.markedUrgent) ? levelBadge('urgent_review') : null))),
  });

  // ---- Follow-ups ----
  const follow = panel({
    title: 'Open follow-ups', iconName: 'calendar', id: 'ov-follow',
    children: data.followUps.length === 0
      ? emptyState({ iconName: 'calendar', title: 'Nothing scheduled', body: 'Schedule a follow-up check-in from any observation on the Actions page.' })
      : h('ul', { class: 'list' }, data.followUps.map((a) => {
        const overdue = new Date(a.scheduledFor) < new Date();
        return h('li', null,
          h('span', { class: ['li-icon', overdue ? 'attention' : 'info'] }, icon('calendar')),
          h('div', { class: 'li-main' },
            h('div', { class: 'li-title' }, a.description),
            h('div', { class: 'li-meta' }, h('span', null, `Due ${fmtDateTime(a.scheduledFor, tz)}`), overdue ? h('span', { class: 'text-attention' }, 'Due time passed') : null)),
          h('a', { class: 'btn btn-sm', href: `#/check-in?followUp=${a.id}` }, 'Complete'));
      })),
  });

  // ---- Learning card ----
  const card = data.learningCard;
  const learn = panel({
    title: 'Learn', iconName: 'sources', id: 'ov-learn', className: 'learn-panel',
    children: h('div', { class: 'stack' },
      h('h3', { class: 'learn-title' }, card.title),
      h('p', { class: 'muted' }, card.summary),
      h('p', { class: 'small' }, card.points[0].text),
      provenance(`Source: ${card.points[0].sourceTitle || card.points[0].sourceKey} — ${card.points[0].locator}`, 'link')),
    actions: linkButton('More', `#/sources?card=${card.id}`, { size: 'sm' }),
  });

  mount(root,
    header,
    h('div', { class: 'grid grid-12' },
      h('div', { class: 'span-12' }, vitalsPanel),
      h('div', { class: 'span-4' }, obsPanel),
      h('div', { class: 'span-4' }, radPanel),
      h('div', { class: 'span-4' }, dqPanel),
      h('div', { class: 'span-5' }, recent),
      h('div', { class: 'span-4' }, follow),
      h('div', { class: 'span-3 span-learn' }, learn)));
  return null;
}

function dqBar(label, n, total, tone) {
  const pct = total ? Math.round((n / total) * 100) : 0;
  const bar = h('div', { class: ['dq-track', tone] }, h('div', { class: 'dq-fill' }));
  bar.firstChild.style.width = `${pct}%`;
  return h('div', { class: 'dq-row' }, h('div', { class: 'row-between' }, h('span', null, label), h('span', { class: 'num muted' }, `${n} of ${total}`)), bar);
}
