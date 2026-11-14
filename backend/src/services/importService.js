// NASA import pipelines. Run only from the CLI scripts (never from a public HTTP endpoint).
import { withTransaction } from '../db/pool.js';
import { SOURCES } from '../content/sources.js';
import {
  upsertSource, getSourceByKey, startImportRun, finishImportRun, insertRadiationObservation, upsertSpaceWeatherEvent, setSourceRetrieval,
} from '../repositories/nasa.js';
import { findProductsForSols, readSolDosimetry, RAD_DATASET_ID } from '../nasa/radRdr.js';
import { fetchDonki, DONKI_TYPES } from '../nasa/donki.js';

export const RAD_IMPORTER_VERSION = 'pds-rad-rdr-range-v1';
export const DONKI_IMPORTER_VERSION = 'donki-api-nasa-v1';

export async function seedSources() {
  for (const s of SOURCES) await upsertSource(null, s);
  return SOURCES.length;
}

async function ensureSource(key) {
  let src = await getSourceByKey(key);
  if (!src) {
    await seedSources();
    src = await getSourceByKey(key);
  }
  return src;
}

/**
 * Imports RAD dosimetry for surface sols [fromSol, toSol]. Re-running is safe: rows are keyed by
 * (product, observation, detector, quantity) and duplicates are counted, not re-inserted.
 */
export async function importRad({ fromSol, toSol, fetchImpl, log = () => {}, products: givenProducts }) {
  const source = await ensureSource('msl-rad-rdr');
  const runId = await startImportRun(source.id, 'msl-rad-rdr', RAD_IMPORTER_VERSION, { fromSol, toSol, datasetId: RAD_DATASET_ID });
  const stats = { seen: 0, inserted: 0, duplicates: 0, gaps: 0, messages: [] };
  let failedSols = 0;
  try {
    const products = givenProducts || await findProductsForSols(fromSol, toSol, { fetchImpl });
    if (products.length === 0) stats.messages.push(`No surface-sol products found in INDEX.TAB for sols ${fromSol}–${toSol}.`);
    for (const product of products) {
      try {
        log(`sol ${product.sol}: reading ${product.productId}`);
        const { observations, messages } = await readSolDosimetry(product, { fetchImpl });
        stats.messages.push(...messages);
        await withTransaction(async (client) => {
          for (const o of observations) {
            stats.seen += 1;
            if (o.value === null) stats.gaps += 1;
            const inserted = await insertRadiationObservation(client, { ...o, sourceId: source.id, importRunId: runId });
            if (inserted) stats.inserted += 1; else stats.duplicates += 1;
          }
        });
        const flagged = observations.filter((o) => o.qualityStatus !== 'no_issues_identified').length;
        stats.messages.push(`sol ${product.sol} (${product.productId}): ${observations.length} detector samples, ${flagged} flagged or gap.`);
        log(`sol ${product.sol}: ${observations.length} samples`);
      } catch (err) {
        failedSols += 1;
        stats.messages.push(`sol ${product.sol}: FAILED — ${err.code || ''} ${err.message}`);
        log(`sol ${product.sol}: failed (${err.message})`);
      }
    }
    const status = failedSols === 0 ? 'succeeded' : (stats.seen > 0 ? 'partial' : 'failed');
    await finishImportRun(runId, { status, ...stats });
    if (stats.seen > 0) {
      await setSourceRetrieval('msl-rad-rdr', { retrievedAt: new Date() });
    }
    return { runId, status, ...stats };
  } catch (err) {
    await finishImportRun(runId, { status: 'failed', ...stats, error: `${err.code || ''} ${err.message}`.trim() });
    throw err;
  }
}

/** Imports DONKI events for [start, end] (dates). Each type is fetched separately; failures are recorded per type. */
export async function importDonki({ start, end, types = DONKI_TYPES, fetchImpl, log = () => {} }) {
  const source = await ensureSource('donki');
  const runId = await startImportRun(source.id, 'donki', DONKI_IMPORTER_VERSION, { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), types });
  const stats = { seen: 0, inserted: 0, duplicates: 0, gaps: 0, messages: [] };
  let failures = 0;
  for (const type of types) {
    try {
      const { records, malformed, url } = await fetchDonki(type, start, end, { fetchImpl });
      stats.messages.push(`${type}: ${records.length} event(s) from ${url}${malformed ? `; ${malformed} malformed record(s) skipped` : ''}.`);
      for (const r of records) {
        stats.seen += 1;
        const inserted = await upsertSpaceWeatherEvent(null, { ...r, sourceId: source.id, importRunId: runId });
        if (inserted) stats.inserted += 1; else stats.duplicates += 1;
      }
      log(`${type}: ${records.length}`);
    } catch (err) {
      failures += 1;
      stats.messages.push(`${type}: FAILED — ${err.code || ''} ${err.message}`);
      log(`${type}: failed (${err.message})`);
    }
  }
  const status = failures === 0 ? 'succeeded' : (failures < types.length ? 'partial' : 'failed');
  await finishImportRun(runId, { status, ...stats, error: status === 'failed' ? 'All DONKI requests failed.' : null });
  if (status !== 'failed') {
    await setSourceRetrieval('donki', { retrievedAt: new Date() });
  }
  return { runId, status, ...stats };
}
