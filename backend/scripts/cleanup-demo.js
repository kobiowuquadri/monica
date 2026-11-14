#!/usr/bin/env node
// Deletes expired public demo accounts (cascading to their profiles and entries) and expired sessions.
// The API also runs this hourly; this script lets an operator run it on demand or from a cron job.
import { deleteExpiredDemoUsers } from '../src/repositories/users.js';
import { purgeExpiredSessions } from '../src/repositories/sessions.js';
import { closePool } from '../src/db/pool.js';

try {
  const demos = await deleteExpiredDemoUsers();
  const sessions = await purgeExpiredSessions();
  console.log(`removed ${demos} expired demo account(s) and ${sessions} expired session(s)`);
} catch (err) {
  console.error('cleanup failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
