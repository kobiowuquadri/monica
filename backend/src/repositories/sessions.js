import { randomBytes, createHmac } from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';

export function hashToken(token) {
  // Keyed hash: a leaked sessions table cannot be replayed without AUTH_SECRET.
  return createHmac('sha256', config.authSecret || 'monica-dev-only').update(token).digest('hex');
}

export async function createSession(userId, client = null) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  const q = client ? client.query.bind(client) : query;
  await q('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [userId, hashToken(token), expiresAt]);
  return { token, expiresAt };
}

export async function findSessionByToken(token) {
  const { rows } = await query(
    `SELECT s.id, s.user_id, u.email, u.display_name, u.is_demo, u.demo_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
        AND (u.is_demo = false OR u.demo_expires_at > now())`,
    [hashToken(token)],
  );
  return rows[0] || null;
}

export async function touchSession(sessionId) {
  await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval \'1 minute\'', [sessionId]);
}

export async function deleteSessionByToken(token) {
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function purgeExpiredSessions() {
  const { rowCount } = await query('DELETE FROM sessions WHERE expires_at < now()');
  return rowCount;
}
