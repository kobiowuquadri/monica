import { query } from '../db/pool.js';

export async function findByIdempotencyKey(clientOrNull, profileId, key) {
  const q = clientOrNull ? clientOrNull.query.bind(clientOrNull) : query;
  const { rows } = await q('SELECT id, request_fingerprint FROM check_ins WHERE profile_id = $1 AND idempotency_key = $2', [profileId, key]);
  return rows[0] || null;
}

export async function insertCheckIn(client, { profileId, userId, idempotencyKey, fingerprint, data, rulesVersion }) {
  const w = data.wellbeing;
  const { rows } = await client.query(
    `INSERT INTO check_ins (profile_id, user_id, idempotency_key, request_fingerprint, measured_at, activity_context, context_note,
        sleep_duration_hours, sleep_quality, fatigue_rating, mood_rating, notes, rules_version, symptom_status,
        exposure_dose_rate, exposure_unit, exposure_source_type, exposure_source_note, lymphocyte_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id, created_at`,
    [profileId, userId, idempotencyKey, fingerprint, data.measuredAt, data.activityContext, data.contextNote,
      w.sleepDurationHours, w.sleepQuality, w.fatigueRating, w.moodRating, data.notes, rulesVersion, data.symptomStatus || 'not_assessed',
      data.exposure?.doseRate ?? null, data.exposure ? data.exposure.unit : null, data.exposure?.sourceType ?? null, data.exposure?.sourceNote ?? null,
      data.biomarkers?.lymphocyteCount ?? null],
  );
  const checkInId = rows[0].id;
  for (const r of data.vitals) {
    await client.query(
      `INSERT INTO vital_readings (check_in_id, profile_id, metric, value, unit, method, source_type, device_label, quality, measured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [checkInId, profileId, r.metric, r.value, r.unit, r.method, r.sourceType, r.deviceLabel, r.quality, data.measuredAt],
    );
  }
  for (const s of data.symptoms) {
    await client.query(
      `INSERT INTO symptom_reports (check_in_id, profile_id, symptom_code, label, severity, onset_at, onset_note, user_marked_urgent, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [checkInId, profileId, s.code, s.label, s.severity, s.onsetAt, s.onsetNote, s.markedUrgent, s.notes],
    );
  }
  for (const m of data.medications) {
    await client.query(
      `INSERT INTO medication_reports (check_in_id, profile_id, name_as_reported, amount_as_reported, taken_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [checkInId, profileId, m.name, m.amount, m.takenAt],
    );
  }
  return { id: checkInId, createdAt: rows[0].created_at };
}

/** Symptom codes from this profile's earlier check-ins in a time window (for HC-003). */
export async function recentSymptomCodes(client, profileId, from, to) {
  const { rows } = await client.query(
    `SELECT s.symptom_code AS code, c.measured_at
       FROM symptom_reports s JOIN check_ins c ON c.id = s.check_in_id
      WHERE s.profile_id = $1 AND c.measured_at >= $2 AND c.measured_at <= $3`,
    [profileId, from, to],
  );
  return rows.map((r) => ({ code: r.code, measuredAt: r.measured_at }));
}

function checkInRowToDto(c) {
  return {
    id: c.id,
    measuredAt: c.measured_at,
    recordedAt: c.created_at,
    activityContext: c.activity_context,
    contextNote: c.context_note,
    symptomStatus: c.symptom_status,
    wellbeing: {
      sleepDurationHours: c.sleep_duration_hours,
      sleepQuality: c.sleep_quality,
      fatigueRating: c.fatigue_rating,
      moodRating: c.mood_rating,
    },
    exposure: c.exposure_dose_rate === null || c.exposure_dose_rate === undefined ? null : {
      doseRate: c.exposure_dose_rate, unit: c.exposure_unit, sourceType: c.exposure_source_type, sourceNote: c.exposure_source_note,
    },
    biomarkers: c.lymphocyte_count === null || c.lymphocyte_count === undefined ? null : { lymphocyteCount: c.lymphocyte_count },
    notes: c.notes,
    rulesVersion: c.rules_version,
  };
}

function vitalRowToDto(r) {
  return {
    id: r.id, checkInId: r.check_in_id, metric: r.metric, value: r.value, unit: r.unit, method: r.method,
    sourceType: r.source_type, deviceLabel: r.device_label, quality: r.quality, measuredAt: r.measured_at,
  };
}

function symptomRowToDto(s) {
  return {
    id: s.id, checkInId: s.check_in_id, code: s.symptom_code, label: s.label, severity: s.severity,
    onsetAt: s.onset_at, onsetNote: s.onset_note, markedUrgent: s.user_marked_urgent, notes: s.notes,
  };
}

function medRowToDto(m) {
  return { id: m.id, checkInId: m.check_in_id, name: m.name_as_reported, amount: m.amount_as_reported, takenAt: m.taken_at };
}

/** Loads check-ins with nested readings for a profile. All queries are scoped by profile_id. */
export async function listCheckIns(profileId, { from = null, to = null, limit = 50 } = {}) {
  const params = [profileId];
  let where = 'profile_id = $1';
  if (from) { params.push(from); where += ` AND measured_at >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND measured_at <= $${params.length}`; }
  params.push(Math.min(Math.max(limit, 1), 500));
  const { rows } = await query(`SELECT * FROM check_ins WHERE ${where} ORDER BY measured_at DESC LIMIT $${params.length}`, params);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [vitals, symptoms, meds] = await Promise.all([
    query('SELECT * FROM vital_readings WHERE profile_id = $1 AND check_in_id = ANY($2::uuid[]) ORDER BY metric', [profileId, ids]),
    query('SELECT * FROM symptom_reports WHERE profile_id = $1 AND check_in_id = ANY($2::uuid[]) ORDER BY created_at', [profileId, ids]),
    query('SELECT * FROM medication_reports WHERE profile_id = $1 AND check_in_id = ANY($2::uuid[]) ORDER BY created_at', [profileId, ids]),
  ]);
  const group = (list, map) => list.reduce((acc, r) => { (acc[r.check_in_id] ||= []).push(map(r)); return acc; }, {});
  const v = group(vitals.rows, vitalRowToDto);
  const s = group(symptoms.rows, symptomRowToDto);
  const m = group(meds.rows, medRowToDto);
  return rows.map((c) => ({ ...checkInRowToDto(c), vitals: v[c.id] || [], symptoms: s[c.id] || [], medications: m[c.id] || [] }));
}

export async function getCheckIn(profileId, checkInId) {
  const { rows } = await query('SELECT * FROM check_ins WHERE profile_id = $1 AND id = $2', [profileId, checkInId]);
  if (!rows[0]) return null;
  const [vitals, symptoms, meds] = await Promise.all([
    query('SELECT * FROM vital_readings WHERE profile_id = $1 AND check_in_id = $2 ORDER BY metric', [profileId, checkInId]),
    query('SELECT * FROM symptom_reports WHERE profile_id = $1 AND check_in_id = $2 ORDER BY created_at', [profileId, checkInId]),
    query('SELECT * FROM medication_reports WHERE profile_id = $1 AND check_in_id = $2 ORDER BY created_at', [profileId, checkInId]),
  ]);
  return {
    ...checkInRowToDto(rows[0]),
    vitals: vitals.rows.map(vitalRowToDto),
    symptoms: symptoms.rows.map(symptomRowToDto),
    medications: meds.rows.map(medRowToDto),
  };
}

/** Most recent reading per vital metric (null-free: metrics without readings are absent). */
export async function latestVitals(profileId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (v.metric) v.*, c.activity_context
       FROM vital_readings v JOIN check_ins c ON c.id = v.check_in_id
      WHERE v.profile_id = $1
      ORDER BY v.metric, v.measured_at DESC, v.created_at DESC`,
    [profileId],
  );
  return rows.map((r) => ({ ...vitalRowToDto(r), activityContext: r.activity_context }));
}

export async function vitalSeries(profileId, metric, { from = null, to = null } = {}) {
  const params = [profileId, metric];
  let where = 'v.profile_id = $1 AND v.metric = $2';
  if (from) { params.push(from); where += ` AND v.measured_at >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND v.measured_at <= $${params.length}`; }
  const { rows } = await query(
    `SELECT v.*, c.activity_context FROM vital_readings v JOIN check_ins c ON c.id = v.check_in_id
      WHERE ${where} ORDER BY v.measured_at ASC LIMIT 2000`,
    params,
  );
  return rows.map((r) => ({ ...vitalRowToDto(r), activityContext: r.activity_context }));
}

const WELLBEING_COLUMNS = new Set(['sleep_duration_hours', 'sleep_quality', 'fatigue_rating', 'mood_rating']);

export async function wellbeingSeries(profileId, column, { from = null, to = null } = {}) {
  if (!WELLBEING_COLUMNS.has(column)) throw new Error('invalid wellbeing column');
  const params = [profileId];
  let where = `profile_id = $1 AND ${column} IS NOT NULL`;
  if (from) { params.push(from); where += ` AND measured_at >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND measured_at <= $${params.length}`; }
  // Column name comes from a fixed allow-list above, never from user input.
  const { rows } = await query(
    `SELECT id, measured_at, activity_context, ${column} AS value FROM check_ins WHERE ${where} ORDER BY measured_at ASC LIMIT 2000`,
    params,
  );
  return rows.map((r) => ({ checkInId: r.id, measuredAt: r.measured_at, activityContext: r.activity_context, value: r.value }));
}

export async function latestWellbeing(profileId) {
  const { rows } = await query(
    `SELECT
       (SELECT row_to_json(x) FROM (SELECT measured_at, sleep_duration_hours AS value FROM check_ins WHERE profile_id = $1 AND sleep_duration_hours IS NOT NULL ORDER BY measured_at DESC LIMIT 1) x) AS sleep_duration_hours,
       (SELECT row_to_json(x) FROM (SELECT measured_at, sleep_quality AS value FROM check_ins WHERE profile_id = $1 AND sleep_quality IS NOT NULL ORDER BY measured_at DESC LIMIT 1) x) AS sleep_quality,
       (SELECT row_to_json(x) FROM (SELECT measured_at, fatigue_rating AS value FROM check_ins WHERE profile_id = $1 AND fatigue_rating IS NOT NULL ORDER BY measured_at DESC LIMIT 1) x) AS fatigue_rating,
       (SELECT row_to_json(x) FROM (SELECT measured_at, mood_rating AS value FROM check_ins WHERE profile_id = $1 AND mood_rating IS NOT NULL ORDER BY measured_at DESC LIMIT 1) x) AS mood_rating`,
    [profileId],
  );
  return rows[0];
}

export async function countCheckIns(profileId) {
  const { rows } = await query('SELECT count(*)::int AS n, max(measured_at) AS last FROM check_ins WHERE profile_id = $1', [profileId]);
  return rows[0];
}

export async function qualitySummary(profileId) {
  const { rows } = await query(
    `SELECT source_type, quality, count(*)::int AS n FROM vital_readings WHERE profile_id = $1 GROUP BY source_type, quality`,
    [profileId],
  );
  return rows;
}
