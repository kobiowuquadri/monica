#!/usr/bin/env node
// Administrative CLI: imports NASA DONKI space-weather events through api.nasa.gov.
//
//   npm run import:donki -- --start 2017-09-01 --end 2017-09-22 [--types FLR,SEP,CME,GST,IPS]
//
// Uses NASA_API_KEY when set, otherwise DEMO_KEY (low hourly limit). Re-running is safe.
import { importDonki } from '../src/services/importService.js';
import { DONKI_TYPES } from '../src/nasa/donki.js';
import { closePool } from '../src/db/pool.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const startStr = arg('start', '2017-09-01');
const endStr = arg('end', '2017-09-22');
const types = arg('types', DONKI_TYPES.join(',')).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
const start = new Date(`${startStr}T00:00:00Z`);
const end = new Date(`${endStr}T00:00:00Z`);

if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
  console.error('Usage: npm run import:donki -- --start YYYY-MM-DD --end YYYY-MM-DD [--types FLR,SEP,...]');
  process.exit(2);
}
if ((end - start) / 86_400_000 > 60) {
  console.error('Refusing to import more than 60 days at once.');
  process.exit(2);
}
const unknown = types.filter((t) => !DONKI_TYPES.includes(t));
if (unknown.length) {
  console.error(`Unsupported DONKI type(s): ${unknown.join(', ')}. Supported: ${DONKI_TYPES.join(', ')}`);
  process.exit(2);
}

try {
  console.log(`Importing DONKI ${types.join(', ')} for ${startStr} → ${endStr} via api.nasa.gov…`);
  const result = await importDonki({ start, end, types, log: (m) => console.log(`  ${m}`) });
  console.log(`\nimport run ${result.runId}: ${result.status}`);
  console.log(`  events seen ${result.seen}, inserted ${result.inserted}, duplicates skipped ${result.duplicates}`);
  for (const m of result.messages) console.log(`  - ${m}`);
  if (result.status === 'failed') process.exitCode = 1;
} catch (err) {
  console.error(`Import failed: ${err.code || ''} ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
