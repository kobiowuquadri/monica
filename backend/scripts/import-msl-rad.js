#!/usr/bin/env node
// Administrative CLI: imports historical Curiosity RAD dosimetry from the NASA PDS PPI archive.
//
//   npm run import:rad -- --from-sol 1806 --to-sol 1820
//
// Only HTTP Range requests for the dosimetry bytes and observation headers are made, so each
// sol transfers well under 1 MB instead of the ~86 MB full RDR file. Re-running is safe.
import { importRad } from '../src/services/importService.js';
import { closePool } from '../src/db/pool.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const fromSol = Number.parseInt(arg('from-sol', '1806'), 10);
const toSol = Number.parseInt(arg('to-sol', '1820'), 10);
const MAX_SOLS = 60;

if (!Number.isInteger(fromSol) || !Number.isInteger(toSol) || fromSol < 0 || toSol < fromSol) {
  console.error('Usage: npm run import:rad -- --from-sol <n> --to-sol <m>   (surface sols, from <= to)');
  process.exit(2);
}
if (toSol - fromSol + 1 > MAX_SOLS) {
  console.error(`Refusing to import more than ${MAX_SOLS} sols in one run; MONICA is designed for a small verified interval.`);
  process.exit(2);
}

try {
  console.log(`Importing MSL RAD RDR dosimetry for sols ${fromSol}–${toSol} from NASA PDS PPI…`);
  const result = await importRad({ fromSol, toSol, log: (m) => console.log(`  ${m}`) });
  console.log(`\nimport run ${result.runId}: ${result.status}`);
  console.log(`  samples seen ${result.seen}, inserted ${result.inserted}, duplicates skipped ${result.duplicates}, gaps ${result.gaps}`);
  for (const m of result.messages.filter((x) => /FAILED|disagree|skipped|No surface/.test(x))) console.log(`  ! ${m}`);
  if (result.status === 'failed') process.exitCode = 1;
} catch (err) {
  console.error(`Import failed: ${err.code || ''} ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
