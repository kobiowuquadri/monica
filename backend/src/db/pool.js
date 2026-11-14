import pg from 'pg';
import { config } from '../config.js';
import { HttpError } from '../middleware/errors.js';

// Return numeric/bigint columns as JS numbers where safe; keep timestamps as Date (UTC).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8

let pool = null;

function normaliseConnectionString(url) {
  // pg currently treats sslmode=require as verify-full; state that explicitly so behaviour
  // does not silently weaken in a future pg release.
  return url.replace(/sslmode=require\b/, 'sslmode=verify-full');
}

/** Optional schema isolation (used by the integration tests so they never touch real data). */
function schemaOption() {
  const schema = process.env.DATABASE_SCHEMA;
  if (!schema) return undefined;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DATABASE_SCHEMA must be a simple lowercase identifier.');
  return `-c search_path=${schema}`;
}

export function getPool() {
  if (!config.databaseUrl) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: normaliseConnectionString(config.databaseUrl),
      options: schemaOption(),
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      // Never log connection strings; only the error class/code.
      console.error('[db] idle client error:', err.code || err.name);
    });
  }
  return pool;
}

export function requirePool() {
  const p = getPool();
  if (!p) {
    throw new HttpError(503, 'database_unavailable', 'Database functionality is unavailable: DATABASE_URL is not configured on the server.');
  }
  return p;
}

export async function query(text, params = []) {
  return requirePool().query(text, params);
}

/** Run fn(client) inside a transaction. */
export async function withTransaction(fn) {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
