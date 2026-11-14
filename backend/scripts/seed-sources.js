#!/usr/bin/env node
// Upserts the source registry (src/content/sources.js) into data_sources.
import { seedSources } from '../src/services/importService.js';
import { closePool } from '../src/db/pool.js';

try {
  const n = await seedSources();
  console.log(`source registry: ${n} source(s) upserted`);
} catch (err) {
  console.error('seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
