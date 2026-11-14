import { query } from '../db/pool.js';

/**
 * Records an audit event. `metadata` must contain identifiers and counts only — never vital
 * values, symptom descriptions, notes or other health content.
 */
export async function recordAudit(client, { userId, profileId = null, entityType, entityId = null, action, metadata = {} }) {
  const q = client ? client.query.bind(client) : query;
  await q(
    `INSERT INTO audit_events (user_id, profile_id, entity_type, entity_id, action, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, profileId, entityType, entityId, action, metadata],
  );
}

export async function listProfileHistory(profileId, { limit = 100, entityType, entityId } = {}) {
  const params = [profileId];
  let where = 'profile_id = $1';
  if (entityType) { params.push(entityType); where += ` AND entity_type = $${params.length}`; }
  if (entityId) { params.push(entityId); where += ` AND entity_id = $${params.length}`; }
  params.push(Math.min(Math.max(limit, 1), 500));
  const { rows } = await query(
    `SELECT id, entity_type, entity_id, action, metadata, created_at
       FROM audit_events WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ id: r.id, entityType: r.entity_type, entityId: r.entity_id, action: r.action, metadata: r.metadata, createdAt: r.created_at }));
}
