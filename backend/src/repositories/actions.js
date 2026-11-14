import { query } from '../db/pool.js';

export function toActionDto(r) {
  return {
    id: r.id,
    profileId: r.profile_id,
    observationId: r.observation_id,
    kind: r.kind,
    description: r.description,
    scheduledFor: r.scheduled_for,
    status: r.status,
    completedAt: r.completed_at,
    completionCheckInId: r.completion_check_in_id,
    completionNote: r.completion_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function insertAction(client, profileId, userId, a) {
  const status = a.kind === 'follow_up' ? 'planned' : 'recorded';
  const { rows } = await client.query(
    `INSERT INTO follow_up_actions (profile_id, observation_id, kind, description, scheduled_for, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [profileId, a.observationId, a.kind, a.description, a.scheduledFor, status, userId],
  );
  return toActionDto(rows[0]);
}

export async function getAction(client, profileId, actionId) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q('SELECT * FROM follow_up_actions WHERE profile_id = $1 AND id = $2', [profileId, actionId]);
  return rows[0] ? toActionDto(rows[0]) : null;
}

export async function updateAction(client, profileId, actionId, patch) {
  const { rows } = await client.query(
    `UPDATE follow_up_actions SET
        status = COALESCE($3, status),
        scheduled_for = COALESCE($4, scheduled_for),
        completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
        completion_check_in_id = COALESCE($5, completion_check_in_id),
        completion_note = COALESCE($6, completion_note),
        updated_at = now()
      WHERE profile_id = $1 AND id = $2 RETURNING *`,
    [profileId, actionId, patch.status ?? null, patch.scheduledFor ?? null, patch.completionCheckInId ?? null, patch.completionNote ?? null],
  );
  return rows[0] ? toActionDto(rows[0]) : null;
}

export async function listActions(profileId, { status, observationId, from, to, limit = 200 } = {}) {
  const params = [profileId];
  let where = 'profile_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (observationId) { params.push(observationId); where += ` AND observation_id = $${params.length}`; }
  if (from) { params.push(from); where += ` AND created_at >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND created_at <= $${params.length}`; }
  params.push(Math.min(Math.max(limit, 1), 500));
  const { rows } = await query(
    `SELECT * FROM follow_up_actions WHERE ${where}
      ORDER BY CASE status WHEN 'planned' THEN 0 ELSE 1 END, COALESCE(scheduled_for, created_at) ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toActionDto);
}
