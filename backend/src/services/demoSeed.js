// Demo scenario data. Every demo account starts with two FICTIONAL crew profiles that already
// hold a scripted history, so the Health Brain, trends, observations and follow-up screens can be
// explored immediately.
//
// What is real and what is scripted:
//  - REAL: the radiation dose rates of "Demo Crew Member A" are archived NASA measurements —
//    MSL Curiosity RAD detector E absorbed dose rate from 4–11 September 2017 (the solar particle
//    event of 10–11 September 2017), read from MONICA's imported copy of the PDS archive and
//    shifted in time so the event ends "now". Each value records its original observation time
//    and PDS product. They are environmental measurements, not anyone's personal dosimeter.
//  - SCRIPTED: all vital signs, symptoms, lymphocyte counts and wellbeing ratings are invented
//    for the fictional profiles to demonstrate the logic. The real 2017 event was far too small
//    to cause symptoms; the scripted symptoms are not a claim about its health effects.
//
// Rows are produced with the same validator and rules engine as real check-ins, then written
// with a few multi-row inserts so starting a demo stays fast.
import { randomUUID, randomBytes } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { validateCheckIn, fingerprintCheckIn } from '../validation/checkIn.js';
import { EXPOSURE_INPUT } from '../content/metrics.js';
import { evaluateCheckIn, RULES_VERSION } from './rulesEngine.js';
import { BASELINE_METHODS, median } from './baselineService.js';

const HOUR = 3600_000;
const RAD_FROM = '2017-09-04T00:00:00Z';
const RAD_NOW = Date.parse('2017-09-11T21:00:00Z');   // archive time that maps to "now"
const RAD_MAX_GAP_MS = 2 * HOUR;

export const DEMO_SCENARIO_NOTE = 'Fictional demo identity with a scripted history. Dose rates replay archived NASA MSL RAD measurements (Mars surface, 4–11 Sep 2017) shifted in time; vital signs, symptoms and lymphocyte counts are invented to demonstrate the logic. No real person\'s data.';

let radCache = null;

/** Archived RAD detector E dose rates for the replay window (cached: historical data never changes). */
async function loadRadReplay() {
  if (radCache) return radCache;
  const { rows } = await query(
    `SELECT observation_start_utc AS t, value, product_id
       FROM radiation_observations
      WHERE detector = 'E' AND quantity = 'absorbed_dose_rate' AND quality_status = 'no_issues_identified'
        AND value IS NOT NULL AND unit = $1 AND observation_start_utc >= $2 AND observation_start_utc <= $3
      ORDER BY observation_start_utc`,
    [EXPOSURE_INPUT.unit, RAD_FROM, new Date(RAD_NOW).toISOString()],
  );
  const list = rows.map((r) => ({ t: new Date(r.t).getTime(), value: Number(r.value), productId: r.product_id }));
  if (list.length) radCache = list;
  return list;
}

function nearestRad(list, t) {
  let best = null;
  for (const r of list) {
    if (!best || Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
  }
  return best && Math.abs(best.t - t) <= RAD_MAX_GAP_MS ? best : null;
}

const manual = { sourceType: 'manual', quality: 'good' };
const vitals = (hr, spo2, temp, sys, dia, rr) => [
  { metric: 'heart_rate', value: hr, unit: 'beats/min', ...manual },
  { metric: 'spo2', value: spo2, unit: '%', sourceType: 'device_reported', deviceLabel: 'Fingertip pulse oximeter', quality: 'good' },
  { metric: 'temperature', value: temp, unit: 'degC', method: 'oral', ...manual },
  { metric: 'bp_systolic', value: sys, unit: 'mmHg', ...manual },
  { metric: 'bp_diastolic', value: dia, unit: 'mmHg', ...manual },
  { metric: 'respiratory_rate', value: rr, unit: 'breaths/min', ...manual },
];
const wb = (sleepDurationHours, sleepQuality, fatigueRating, moodRating) => {
  const o = { sleepDurationHours, sleepQuality, fatigueRating, moodRating };
  for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
  return o;
};
const sym = (code, severity, extra = {}) => ({ code, severity, ...extra });

/** Profile A — Mars surface. `rad` is the archive time whose RAD reading is replayed. */
const SCENARIO_A = [
  { rad: '2017-09-04T08:00:00Z', v: vitals(62, 98, 36.6, 118, 76, 14), w: wb(7, 4, 2, 4), lymph: 2.1 },
  { rad: '2017-09-05T08:00:00Z', v: vitals(64, 97, 36.7, 120, 78, 14), w: wb(6.5, 4, 3, 4) },
  { rad: '2017-09-06T08:00:00Z', v: vitals(61, 98, 36.5, 116, 74, 13), w: wb(7.25, 5, 2, 5) },
  { rad: '2017-09-07T08:00:00Z', v: vitals(66, 98, 36.8, 122, 79, 15), w: wb(6, 3, 4, 3), lymph: 2.0 },
  { rad: '2017-09-08T08:00:00Z', v: vitals(63, 99, 36.6, 119, 77, 14), w: wb(7, 4, 2, 4) },
  { rad: '2017-09-09T08:00:00Z', v: vitals(62, 98, 36.6, 118, 76, 14), w: wb(7.5, 4, 2, 4), lymph: 2.2, baselineAfter: true },
  { rad: '2017-09-10T08:00:00Z', v: vitals(65, 98, 36.7, 120, 78, 14), w: wb(5.5, 2, 5, 3), s: [sym('headache', 'mild')], notes: 'Slept poorly.' },
  { rad: '2017-09-10T19:00:00Z', v: vitals(72, 98, 36.8, 124, 80, 15), w: wb(null, null, 5, 3), s: [sym('nausea', 'mild'), sym('headache', 'mild')], notes: 'Area dose rate rising since mid-afternoon.' },
  { rad: '2017-09-10T22:00:00Z', v: vitals(78, 97, 36.9, 128, 82, 16), w: wb(null, null, 6, 3), s: [sym('nausea', 'moderate'), sym('headache', 'mild')],
    ack: true, action: 'Moved to the habitat shelter area following the mission radiation procedure and informed the crew medical officer.' },
  { rad: '2017-09-11T00:30:00Z', v: vitals(84, 97, 37.6, 130, 84, 18), w: wb(null, null, 7, 2), s: [sym('vomiting', 'moderate', { onsetMinutesBefore: 40 }), sym('nausea', 'moderate'), sym('headache', 'moderate')],
    notes: 'Vomited once about 40 minutes ago.', ack: true, action: 'Remained in the shelter area. Reported vomiting and its time to the crew medical officer; sipping water.' },
  { rad: '2017-09-11T09:00:00Z', v: vitals(80, 97, 37.4, 126, 82, 17), w: wb(3.5, 2, 7, 2), s: [sym('nausea', 'moderate'), sym('unusual_fatigue', 'moderate')], lymph: 1.7 },
  { rad: '2017-09-11T20:00:00Z', v: vitals(74, 98, 37.1, 122, 80, 15), w: wb(null, null, 6, 3), s: [sym('nausea', 'mild'), sym('unusual_fatigue', 'moderate')], lymph: 1.5,
    followUp: { inHours: 5, description: 'Repeat check-in with dose-rate reading, symptoms and temperature' } },
];

/** Profile B — transit. No dosimeter readings recorded, so Exposure stays "not assessed". */
const SCENARIO_B = [
  { hoursAgo: 122, v: vitals(58, 98, 36.4, 112, 72, 13), w: wb(7.5, 4, 2, 4) },
  { hoursAgo: 97, v: vitals(60, 98, 36.5, 114, 74, 13), w: wb(7, 4, 2, 4) },
  { hoursAgo: 75, v: vitals(63, 97, 36.6, 116, 74, 14), w: wb(4.5, 2, 6, 2), s: [sym('back_pain', 'moderate'), sym('sleep_difficulty', 'moderate')], notes: 'Back ache after the exercise session; hard to fall asleep.', ack: true },
  { hoursAgo: 50, v: vitals(61, 98, 36.5, 114, 72, 13), w: wb(6.5, 3, 4, 3), s: [sym('back_pain', 'mild')] },
  { hoursAgo: 5, v: vitals(59, 98, 36.4, 112, 72, 13), w: wb(7.5, 4, 2, 4) },
];

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Builds all rows for one profile in memory. */
function buildProfileRows({ profileId, userId, steps, now, rad }) {
  const rows = { checkIns: [], vitals: [], symptoms: [], baselines: [], observations: [], actions: [], audits: [] };
  const prior = [];
  let baselines = new Map();

  for (const step of steps) {
    const radTime = step.rad ? Date.parse(step.rad) : null;
    const t = radTime !== null ? now - (RAD_NOW - radTime) : now - step.hoursAgo * HOUR;
    const body = {
      measuredAt: iso(t), activityContext: 'resting', vitals: step.v, wellbeing: step.w,
      symptoms: (step.s || []).map(({ onsetMinutesBefore, ...s }) => (onsetMinutesBefore ? { ...s, onsetAt: iso(t - onsetMinutesBefore * 60_000) } : s)),
      symptomStatus: step.s?.length ? 'reported' : 'none_reported',
      notes: step.notes,
    };
    if (step.lymph !== undefined) body.biomarkers = { lymphocyteCount: step.lymph };
    const data = validateCheckIn(body);
    const reading = radTime !== null ? nearestRad(rad, radTime) : null;
    if (reading) {
      data.exposure = {
        doseRate: Math.round(reading.value * 100) / 100,
        unit: EXPOSURE_INPUT.unit,
        sourceType: 'nasa_replay',
        sourceNote: `Scenario replay of NASA MSL RAD detector E, observed ${iso(reading.t)} (PDS product ${reading.productId}). Environmental measurement, not personal dosimetry.`,
      };
    }

    const id = randomUUID();
    const at = new Date(t);
    const recentSymptoms = prior.filter((p) => t - p.measuredAt.getTime() <= 72 * HOUR)
      .flatMap((p) => p.symptoms.map((s) => ({ code: s.code, measuredAt: p.measuredAt })));
    const generated = evaluateCheckIn(data, { baselines, recentSymptoms, priorCheckIns: prior });

    rows.checkIns.push({
      id, profile_id: profileId, user_id: userId, idempotency_key: `demo-seed-${randomBytes(9).toString('hex')}`,
      request_fingerprint: fingerprintCheckIn(data), measured_at: at, activity_context: data.activityContext, context_note: data.contextNote,
      sleep_duration_hours: data.wellbeing.sleepDurationHours, sleep_quality: data.wellbeing.sleepQuality,
      fatigue_rating: data.wellbeing.fatigueRating, mood_rating: data.wellbeing.moodRating, notes: data.notes,
      rules_version: RULES_VERSION, symptom_status: data.symptomStatus,
      exposure_dose_rate: data.exposure?.doseRate ?? null, exposure_unit: data.exposure?.unit ?? null,
      exposure_source_type: data.exposure?.sourceType ?? null, exposure_source_note: data.exposure?.sourceNote ?? null,
      lymphocyte_count: data.biomarkers?.lymphocyteCount ?? null, created_at: at,
    });
    for (const r of data.vitals) {
      rows.vitals.push({ check_in_id: id, profile_id: profileId, metric: r.metric, value: r.value, unit: r.unit, method: r.method, source_type: r.sourceType, device_label: r.deviceLabel, quality: r.quality, measured_at: at, created_at: at });
    }
    for (const s of data.symptoms) {
      rows.symptoms.push({ check_in_id: id, profile_id: profileId, symptom_code: s.code, label: s.label, severity: s.severity, onset_at: s.onsetAt, onset_note: s.onsetNote, user_marked_urgent: Boolean(s.markedUrgent), notes: s.notes, created_at: at });
    }
    rows.audits.push({ user_id: userId, profile_id: profileId, entity_type: 'check_in', entity_id: id, action: 'check_in.created', created_at: at,
      metadata: JSON.stringify({ vitals: data.vitals.length, symptoms: data.symptoms.length, observations: generated.length, rulesVersion: RULES_VERSION, demoScenario: true }) });

    const isLatest = step === steps[steps.length - 1];
    const ackAt = new Date(t + 20 * 60_000);
    // Older observations are shown as already acknowledged so the open list reflects the present.
    const acknowledged = step.ack || (!isLatest && !step.keepOpen && now - t > 24 * HOUR);
    let headline = null;
    for (const o of generated) {
      const obsId = randomUUID();
      if (!headline && (o.ruleId === 'HB-002' || o.ruleId === 'HB-001')) headline = { id: obsId, ruleId: o.ruleId };
      rows.observations.push({
        id: obsId, profile_id: profileId, check_in_id: id, category: o.category, level: o.level, rule_id: o.ruleId, rule_version: o.ruleVersion,
        is_demonstration_rule: o.isDemonstrationRule, title: o.title, explanation: o.explanation,
        triggering_inputs: JSON.stringify(o.triggeringInputs), missing_information: JSON.stringify(o.missingInformation || []),
        suggested_next_step: o.suggestedNextStep, reference: o.reference ? JSON.stringify(o.reference) : null,
        status: acknowledged ? 'acknowledged' : 'open', acknowledged_at: acknowledged ? ackAt : null, acknowledged_by: acknowledged ? userId : null, created_at: at,
      });
      rows.audits.push({ user_id: userId, profile_id: profileId, entity_type: 'observation', entity_id: obsId, action: 'observation.generated', created_at: at,
        metadata: JSON.stringify({ ruleId: o.ruleId, level: o.level, checkInId: id }) });
      if (acknowledged) {
        rows.audits.push({ user_id: userId, profile_id: profileId, entity_type: 'observation', entity_id: obsId, action: 'observation.acknowledged', created_at: ackAt, metadata: JSON.stringify({ ruleId: o.ruleId }) });
      }
    }
    if (step.action && headline) {
      const actionId = randomUUID();
      const when = new Date(t + 25 * 60_000);
      rows.actions.push({ id: actionId, profile_id: profileId, observation_id: headline.id, kind: 'action_taken', description: step.action, scheduled_for: null, status: 'recorded', created_by: userId, created_at: when, updated_at: when });
      rows.audits.push({ user_id: userId, profile_id: profileId, entity_type: 'observation', entity_id: headline.id, action: 'observation.action_recorded', created_at: when, metadata: JSON.stringify({ actionId }) });
    }
    if (step.followUp && headline) {
      const actionId = randomUUID();
      const when = new Date(t + 10 * 60_000);
      rows.actions.push({ id: actionId, profile_id: profileId, observation_id: headline.id, kind: 'follow_up', description: step.followUp.description, scheduled_for: new Date(now + step.followUp.inHours * HOUR), status: 'planned', created_by: userId, created_at: when, updated_at: when });
      rows.audits.push({ user_id: userId, profile_id: profileId, entity_type: 'observation', entity_id: headline.id, action: 'observation.follow_up_scheduled', created_at: when, metadata: JSON.stringify({ actionId }) });
    }

    prior.push({ ...data, id });

    if (step.baselineAfter) {
      const def = BASELINE_METHODS.median_of_resting_readings;
      const established = new Date(t + 30 * 60_000);
      const metrics = [...new Set(prior.flatMap((p) => p.vitals.map((r) => r.metric)))];
      baselines = new Map();
      for (const metric of metrics) {
        const readings = prior.flatMap((p) => p.vitals.filter((r) => r.metric === metric));
        if (readings.length < def.minSamples) continue;
        const value = Math.round(median(readings.map((r) => r.value)) * 100) / 100;
        const baselineId = randomUUID();
        rows.baselines.push({
          id: baselineId, profile_id: profileId, metric, method: 'median_of_resting_readings', value, unit: readings[0].unit, sample_count: readings.length,
          window_start: new Date(prior[0].measuredAt.getTime() - HOUR), window_end: established, source_note: null, method_version: def.version,
          established_by: userId, established_at: established,
        });
        rows.audits.push({ user_id: userId, profile_id: profileId, entity_type: 'baseline', entity_id: baselineId, action: 'baseline.established', created_at: established,
          metadata: JSON.stringify({ metric, method: 'median_of_resting_readings', sampleCount: readings.length }) });
        baselines.set(metric, { metric, value, unit: readings[0].unit, method: 'median_of_resting_readings', sampleCount: readings.length });
      }
    }
  }
  return rows;
}

async function bulkInsert(client, table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const params = [];
  const tuples = rows.map((r) => `(${cols.map((c) => { params.push(r[c] ?? null); return `$${params.length}`; }).join(',')})`);
  // Table and column names are fixed constants in this file, never user input.
  await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
}

/**
 * Seeds the two fictional demo profiles. `profiles` = { a: profileRow, b: profileRow }.
 * Returns counts, including whether NASA RAD data was available for the exposure replay.
 */
export async function seedDemoData({ userId, profiles, now = Date.now() }) {
  const rad = await loadRadReplay().catch(() => []);
  const sets = [
    buildProfileRows({ profileId: profiles.a.id, userId, steps: SCENARIO_A, now, rad }),
    buildProfileRows({ profileId: profiles.b.id, userId, steps: SCENARIO_B, now, rad: [] }),
  ];
  const all = (key) => sets.flatMap((s) => s[key]);
  await withTransaction(async (client) => {
    await bulkInsert(client, 'check_ins', all('checkIns'));
    await bulkInsert(client, 'vital_readings', all('vitals'));
    await bulkInsert(client, 'symptom_reports', all('symptoms'));
    await bulkInsert(client, 'baselines', all('baselines'));
    await bulkInsert(client, 'observations_or_alerts', all('observations'));
    await bulkInsert(client, 'follow_up_actions', all('actions'));
    await bulkInsert(client, 'audit_events', all('audits'));
  });
  return { checkIns: all('checkIns').length, observations: all('observations').length, radReplay: rad.length > 0 };
}
