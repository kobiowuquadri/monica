import { createHash } from 'node:crypto';
import { Validator, rejectUnknownKeys } from './validate.js';
import { HttpError } from '../middleware/errors.js';
import {
  VITAL_METRICS, ACTIVITY_CONTEXTS, SOURCE_TYPES, QUALITY_VALUES, SEVERITIES, SYMPTOMS, SYMPTOM_CODES, WELLBEING_METRICS,
} from '../content/metrics.js';

const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,100}$/;

export function validateIdempotencyKey(value) {
  if (!value || !IDEMPOTENCY_RE.test(value)) {
    throw new HttpError(400, 'idempotency_key_required', 'An Idempotency-Key header (16–100 letters, digits, "-" or "_") is required so retries cannot create duplicate check-ins.');
  }
  return value;
}

/**
 * Validates and normalises a check-in payload. Returns a plain object ready for storage.
 * Only structure and plausible input ranges are checked; nothing here interprets health.
 */
export function validateCheckIn(body) {
  const v = new Validator();
  const b = v.object('body', body);
  rejectUnknownKeys(v, '', b, ['measuredAt', 'activityContext', 'contextNote', 'vitals', 'symptoms', 'symptomStatus', 'wellbeing', 'medications', 'notes']);

  const measuredAt = v.timestamp('measuredAt', b.measuredAt, { required: true, notFutureMinutes: 5, notOlderThanDays: 365 });
  const activityContext = v.enumValue('activityContext', b.activityContext, ACTIVITY_CONTEXTS, { required: true });
  const contextNote = v.string('contextNote', b.contextNote, { max: 300 });
  const notes = v.string('notes', b.notes, { max: 2000 });

  // ---- Vitals ----
  const vitals = [];
  const seen = new Set();
  v.array('vitals', b.vitals, { max: 12 }).forEach((raw, i) => {
    const f = `vitals[${i}]`;
    const r = v.object(f, raw);
    rejectUnknownKeys(v, f, r, ['metric', 'value', 'unit', 'method', 'sourceType', 'deviceLabel', 'quality']);
    const metric = v.enumValue(`${f}.metric`, r.metric, Object.keys(VITAL_METRICS), { required: true });
    if (!metric) return;
    if (seen.has(metric)) { v.add(`${f}.metric`, 'Each measurement can appear once per check-in.'); return; }
    seen.add(metric);
    const def = VITAL_METRICS[metric];
    const unit = v.enumValue(`${f}.unit`, r.unit, def.units, { required: true });
    const range = unit && def.inputRange[unit] ? def.inputRange[unit] : def.inputRange;
    const value = v.number(`${f}.value`, r.value, { required: true, min: range.min, max: range.max, maxDecimals: def.maxDecimals });
    let method = null;
    if (def.methods.length) {
      method = v.enumValue(`${f}.method`, r.method, def.methods, { required: Boolean(def.methodRequired) });
    } else if (r.method !== undefined && r.method !== null && r.method !== '') {
      v.add(`${f}.method`, 'Not applicable for this measurement.');
    }
    const sourceType = v.enumValue(`${f}.sourceType`, r.sourceType, SOURCE_TYPES, { required: true });
    const deviceLabel = v.string(`${f}.deviceLabel`, r.deviceLabel, { max: 120 });
    if (sourceType === 'manual' && deviceLabel) {
      // A device label is still allowed for manual entry of a device display (e.g. read from a cuff).
    }
    const quality = v.enumValue(`${f}.quality`, r.quality, QUALITY_VALUES, { required: true });
    vitals.push({ metric, value, unit, method, sourceType, deviceLabel, quality });
  });

  // Blood pressure components belong together and must be structurally consistent.
  const sys = vitals.find((x) => x.metric === 'bp_systolic');
  const dia = vitals.find((x) => x.metric === 'bp_diastolic');
  if (Boolean(sys) !== Boolean(dia)) {
    v.add('vitals', 'Enter both systolic and diastolic blood pressure, or neither.');
  } else if (sys && dia && sys.value !== null && dia.value !== null && sys.value <= dia.value) {
    v.add('vitals', 'Systolic value must be higher than diastolic — check the order of the two numbers.');
  }
  if (sys && dia && (sys.sourceType !== dia.sourceType || sys.quality !== dia.quality)) {
    v.add('vitals', 'Systolic and diastolic values come from one measurement: use the same source and quality.');
  }

  // ---- Symptoms ----
  const symptoms = [];
  const seenSymptoms = new Set();
  v.array('symptoms', b.symptoms, { max: 25 }).forEach((raw, i) => {
    const f = `symptoms[${i}]`;
    const s = v.object(f, raw);
    rejectUnknownKeys(v, f, s, ['code', 'severity', 'onsetAt', 'onsetNote', 'markedUrgent', 'notes']);
    const code = v.enumValue(`${f}.code`, s.code, SYMPTOM_CODES, { required: true });
    if (code && code !== 'other' && seenSymptoms.has(code)) v.add(`${f}.code`, 'Symptom already listed.');
    if (code) seenSymptoms.add(code);
    const severity = v.enumValue(`${f}.severity`, s.severity, SEVERITIES, { required: true });
    const onsetAt = v.timestamp(`${f}.onsetAt`, s.onsetAt, { notFutureMinutes: 5, notOlderThanDays: 3650 });
    const onsetNote = v.string(`${f}.onsetNote`, s.onsetNote, { max: 200 });
    const markedUrgent = v.boolean(`${f}.markedUrgent`, s.markedUrgent);
    const sNotes = v.string(`${f}.notes`, s.notes, { max: 1000 });
    if (code === 'other' && !sNotes) v.add(`${f}.notes`, 'Describe the symptom when choosing "Other".');
    if (onsetAt && measuredAt && onsetAt.getTime() > measuredAt.getTime() + 5 * 60_000) {
      v.add(`${f}.onsetAt`, 'Onset cannot be after the check-in time.');
    }
    if (code) symptoms.push({ code, label: SYMPTOMS[code], severity, onsetAt, onsetNote, markedUrgent, notes: sNotes });
  });

  // Explicit symptom assessment state: an empty list alone never means "no symptoms".
  let symptomStatus = v.enumValue('symptomStatus', b.symptomStatus, ['reported', 'none_reported', 'not_assessed']);
  if (symptoms.length > 0) {
    if (symptomStatus && symptomStatus !== 'reported') v.add('symptomStatus', 'Symptoms are listed, so the status must be "reported".');
    symptomStatus = 'reported';
  } else if (symptomStatus === 'reported') {
    v.add('symptomStatus', 'No symptoms are listed. Choose "none_reported" or "not_assessed".');
  }
  symptomStatus ||= 'not_assessed';

  // ---- Wellbeing ----
  const w = v.object('wellbeing', b.wellbeing);
  rejectUnknownKeys(v, 'wellbeing', w, ['sleepDurationHours', 'sleepQuality', 'fatigueRating', 'moodRating']);
  const wd = WELLBEING_METRICS;
  const wellbeing = {
    sleepDurationHours: v.number('wellbeing.sleepDurationHours', w.sleepDurationHours, { ...wd.sleep_duration_hours.range, maxDecimals: 2 }),
    sleepQuality: v.number('wellbeing.sleepQuality', w.sleepQuality, { ...wd.sleep_quality.range, integer: true }),
    fatigueRating: v.number('wellbeing.fatigueRating', w.fatigueRating, { ...wd.fatigue_rating.range, integer: true }),
    moodRating: v.number('wellbeing.moodRating', w.moodRating, { ...wd.mood_rating.range, integer: true }),
  };

  // ---- Medications (self-reported log; never recommended by MONICA) ----
  const medications = [];
  v.array('medications', b.medications, { max: 20 }).forEach((raw, i) => {
    const f = `medications[${i}]`;
    const m = v.object(f, raw);
    rejectUnknownKeys(v, f, m, ['name', 'amount', 'takenAt']);
    const name = v.string(`${f}.name`, m.name, { required: true, max: 120 });
    const amount = v.string(`${f}.amount`, m.amount, { max: 120 });
    const takenAt = v.timestamp(`${f}.takenAt`, m.takenAt, { notFutureMinutes: 5, notOlderThanDays: 365 });
    if (name) medications.push({ name, amount, takenAt });
  });

  const hasWellbeing = Object.values(wellbeing).some((x) => x !== null);
  if (v.ok() && vitals.length === 0 && symptoms.length === 0 && !hasWellbeing && medications.length === 0 && !notes) {
    v.add('body', 'A check-in needs at least one entry: a measurement, symptom, wellbeing rating, medication or note.');
  }

  v.throwIfInvalid();
  return { measuredAt, activityContext, contextNote, notes, vitals, symptoms, symptomStatus, wellbeing, medications };
}

/** Stable fingerprint of the normalised payload; detects idempotency-key reuse with different data. */
export function fingerprintCheckIn(normalised) {
  const canonical = JSON.stringify(normalised, (_k, val) => (val instanceof Date ? val.toISOString() : val));
  return createHash('sha256').update(canonical).digest('hex');
}
