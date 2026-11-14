import { config, configWarnings, hasDatabase } from './config.js';
import { createApp } from './app.js';
import { closePool } from './db/pool.js';
import { deleteExpiredDemoUsers } from './repositories/users.js';
import { purgeExpiredSessions } from './repositories/sessions.js';

for (const w of configWarnings()) console.warn(`[config] ${w}`);
if (config.isProduction && (!config.authSecret || config.authSecret.length < 32)) {
  console.error('[config] AUTH_SECRET must be set (32+ characters) in production. Refusing to start.');
  process.exit(1);
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`MONICA API listening on port ${config.port} (${config.nodeEnv}); database ${hasDatabase() ? 'configured' : 'NOT configured'}`);
});

async function housekeeping() {
  if (!hasDatabase()) return;
  try {
    const demos = await deleteExpiredDemoUsers();
    const sessions = await purgeExpiredSessions();
    if (demos || sessions) console.log(`[housekeeping] removed ${demos} expired demo account(s), ${sessions} expired session(s)`);
  } catch (err) {
    console.error('[housekeeping] failed:', err.code || err.message);
  }
}
housekeeping();
const timer = setInterval(housekeeping, 60 * 60 * 1000);
timer.unref();

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
