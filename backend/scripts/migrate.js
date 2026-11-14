#!/usr/bin/env node
// Applies SQL migrations in /migrations in filename order. Each migration runs in a
// transaction and is recorded in schema_migrations, so re-running is safe.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getPool, closePool } from '../src/db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');

export async function runMigrations({ log = console.log } = {}) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set; cannot run migrations.');
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map((await pool.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]));
  let count = 0;
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
      log(`applied ${file}`);
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  log(count === 0 ? 'database schema already up to date' : `${count} migration(s) applied`);
  return { applied: count, total: files.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err.message);
      await closePool();
      process.exit(1);
    });
}
