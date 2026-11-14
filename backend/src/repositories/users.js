import { query } from '../db/pool.js';

export async function findUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0] || null;
}

export async function insertUser(client, { email, passwordHash, displayName, isDemo = false, demoExpiresAt = null }) {
  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, display_name, is_demo, demo_expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, display_name, is_demo, demo_expires_at, created_at`,
    [email, passwordHash, displayName, isDemo, demoExpiresAt],
  );
  return rows[0];
}

/** Deletes expired demo accounts; ON DELETE CASCADE removes their profiles and entries. */
export async function deleteExpiredDemoUsers() {
  const { rowCount } = await query('DELETE FROM users WHERE is_demo = true AND demo_expires_at < now()');
  return rowCount;
}
