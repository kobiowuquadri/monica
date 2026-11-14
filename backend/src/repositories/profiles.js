import { query } from '../db/pool.js';

const COLUMNS = 'id, user_id, display_name, role_title, mission_name, mission_phase, timezone, is_fictional, notes, created_at, updated_at';

export function toProfileDto(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    roleTitle: row.role_title,
    missionName: row.mission_name,
    missionPhase: row.mission_phase,
    timezone: row.timezone,
    isFictional: row.is_fictional,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProfiles(userId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM profiles WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return rows;
}

/** Ownership-checked lookup: returns null when the profile does not belong to userId. */
export async function findOwnedProfile(profileId, userId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM profiles WHERE id = $1 AND user_id = $2`, [profileId, userId]);
  return rows[0] || null;
}

export async function insertProfile(client, userId, p) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO profiles (user_id, display_name, role_title, mission_name, mission_phase, timezone, is_fictional, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
    [userId, p.displayName, p.roleTitle ?? null, p.missionName ?? null, p.missionPhase ?? null, p.timezone || 'UTC', Boolean(p.isFictional), p.notes ?? null],
  );
  return rows[0];
}

export async function updateProfile(profileId, userId, p) {
  const { rows } = await query(
    `UPDATE profiles SET
        display_name = COALESCE($3, display_name),
        role_title = CASE WHEN $4::boolean THEN $5 ELSE role_title END,
        mission_name = CASE WHEN $6::boolean THEN $7 ELSE mission_name END,
        mission_phase = CASE WHEN $8::boolean THEN $9 ELSE mission_phase END,
        timezone = COALESCE($10, timezone),
        notes = CASE WHEN $11::boolean THEN $12 ELSE notes END,
        updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING ${COLUMNS}`,
    [
      profileId, userId, p.displayName ?? null,
      'roleTitle' in p, p.roleTitle ?? null,
      'missionName' in p, p.missionName ?? null,
      'missionPhase' in p, p.missionPhase ?? null,
      p.timezone ?? null,
      'notes' in p, p.notes ?? null,
    ],
  );
  return rows[0] || null;
}
