import { query } from '../db/pool.js';

export function toBaselineDto(r) {
  return {
    id: r.id,
    metric: r.metric,
    method: r.method,
    methodVersion: r.method_version,
    value: r.value,
    unit: r.unit,
    sampleCount: r.sample_count,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    sourceNote: r.source_note,
    establishedAt: r.established_at,
    retiredAt: r.retired_at,
  };
}

export async function activeBaselines(clientOrNull, profileId) {
  const q = clientOrNull ? clientOrNull.query.bind(clientOrNull) : query;
  const { rows } = await q('SELECT * FROM baselines WHERE profile_id = $1 AND retired_at IS NULL ORDER BY metric', [profileId]);
  return rows.map(toBaselineDto);
}

export async function allBaselines(profileId) {
  const { rows } = await query('SELECT * FROM baselines WHERE profile_id = $1 ORDER BY established_at DESC', [profileId]);
  return rows.map(toBaselineDto);
}

export async function retireActive(client, profileId, metric) {
  await client.query('UPDATE baselines SET retired_at = now() WHERE profile_id = $1 AND metric = $2 AND retired_at IS NULL', [profileId, metric]);
}

export async function retireById(client, profileId, id) {
  const { rows } = await client.query(
    'UPDATE baselines SET retired_at = now() WHERE profile_id = $1 AND id = $2 AND retired_at IS NULL RETURNING *',
    [profileId, id],
  );
  return rows[0] ? toBaselineDto(rows[0]) : null;
}

export async function insertBaseline(client, profileId, userId, b) {
  const { rows } = await client.query(
    `INSERT INTO baselines (profile_id, metric, method, value, unit, sample_count, window_start, window_end, source_note, method_version, established_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [profileId, b.metric, b.method, b.value, b.unit, b.sampleCount ?? null, b.windowStart ?? null, b.windowEnd ?? null, b.sourceNote ?? null, b.methodVersion, userId],
  );
  return toBaselineDto(rows[0]);
}

/** Resting readings eligible for a median baseline: resting context, good or unstated quality. */
export async function eligibleRestingReadings(client, profileId, metric, unit, from, to) {
  const { rows } = await client.query(
    `SELECT v.value, v.measured_at FROM vital_readings v JOIN check_ins c ON c.id = v.check_in_id
      WHERE v.profile_id = $1 AND v.metric = $2 AND v.unit = $3
        AND c.activity_context = 'resting' AND v.quality IN ('good','not_stated')
        AND v.measured_at >= $4 AND v.measured_at <= $5
      ORDER BY v.measured_at`,
    [profileId, metric, unit, from, to],
  );
  return rows;
}
