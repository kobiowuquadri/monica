import { query } from '../db/pool.js';

export function toObservationDto(r) {
  return {
    id: r.id,
    profileId: r.profile_id,
    checkInId: r.check_in_id,
    category: r.category,
    level: r.level,
    ruleId: r.rule_id,
    ruleVersion: r.rule_version,
    isDemonstrationRule: r.is_demonstration_rule,
    title: r.title,
    explanation: r.explanation,
    triggeringInputs: r.triggering_inputs,
    missingInformation: r.missing_information,
    suggestedNextStep: r.suggested_next_step,
    reference: r.reference,
    status: r.status,
    acknowledgedAt: r.acknowledged_at,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

export async function insertObservations(client, profileId, checkInId, list) {
  const inserted = [];
  for (const o of list) {
    const { rows } = await client.query(
      `INSERT INTO observations_or_alerts (profile_id, check_in_id, category, level, rule_id, rule_version, is_demonstration_rule,
          title, explanation, triggering_inputs, missing_information, suggested_next_step, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [profileId, checkInId, o.category, o.level, o.ruleId, o.ruleVersion, o.isDemonstrationRule, o.title, o.explanation,
        JSON.stringify(o.triggeringInputs), JSON.stringify(o.missingInformation || []), o.suggestedNextStep,
        o.reference ? JSON.stringify(o.reference) : null],
    );
    inserted.push(rows[0]);
  }
  return inserted.map(toObservationDto);
}

export async function listObservations(profileId, { status, category, checkInId, from, to, limit = 100 } = {}) {
  const params = [profileId];
  let where = 'profile_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (category) { params.push(category); where += ` AND category = $${params.length}`; }
  if (checkInId) { params.push(checkInId); where += ` AND check_in_id = $${params.length}`; }
  if (from) { params.push(from); where += ` AND created_at >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND created_at <= $${params.length}`; }
  params.push(Math.min(Math.max(limit, 1), 500));
  const { rows } = await query(
    `SELECT * FROM observations_or_alerts WHERE ${where}
      ORDER BY CASE level WHEN 'urgent_review' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END, created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toObservationDto);
}

export async function getObservation(profileId, id) {
  const { rows } = await query('SELECT * FROM observations_or_alerts WHERE profile_id = $1 AND id = $2', [profileId, id]);
  return rows[0] ? toObservationDto(rows[0]) : null;
}

export async function acknowledgeObservation(client, profileId, id, userId) {
  const { rows } = await client.query(
    `UPDATE observations_or_alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $3
      WHERE profile_id = $1 AND id = $2 AND status = 'open' RETURNING *`,
    [profileId, id, userId],
  );
  return rows[0] ? toObservationDto(rows[0]) : null;
}

export async function resolveObservation(client, profileId, id) {
  const { rows } = await client.query(
    `UPDATE observations_or_alerts SET status = 'resolved', resolved_at = now(),
        acknowledged_at = COALESCE(acknowledged_at, now())
      WHERE profile_id = $1 AND id = $2 AND status <> 'resolved' RETURNING *`,
    [profileId, id],
  );
  return rows[0] ? toObservationDto(rows[0]) : null;
}

export async function observationCounts(profileId) {
  const { rows } = await query(
    `SELECT category, level, count(*)::int AS n FROM observations_or_alerts
      WHERE profile_id = $1 AND status = 'open' GROUP BY category, level`,
    [profileId],
  );
  return rows;
}
