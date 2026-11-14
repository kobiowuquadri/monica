// Repositories for the source registry, import provenance, RAD observations and DONKI events.
import { query } from '../db/pool.js';

// ---------------- Source registry ----------------
export function toSourceDto(r) {
  return {
    key: r.source_key,
    title: r.title,
    organisation: r.organisation,
    url: r.url,
    datasetIdentifier: r.dataset_identifier,
    category: r.category,
    retrievedAt: r.retrieved_at,
    observationCoverage: r.observation_coverage,
    monicaUsage: r.monica_usage,
    notes: r.notes,
    updatedAt: r.updated_at,
  };
}

export async function upsertSource(client, s) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO data_sources (source_key, title, organisation, url, dataset_identifier, category, retrieved_at, observation_coverage, monica_usage, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (source_key) DO UPDATE SET
       title = EXCLUDED.title, organisation = EXCLUDED.organisation, url = EXCLUDED.url,
       dataset_identifier = EXCLUDED.dataset_identifier, category = EXCLUDED.category,
       retrieved_at = COALESCE(EXCLUDED.retrieved_at, data_sources.retrieved_at),
       observation_coverage = COALESCE(EXCLUDED.observation_coverage, data_sources.observation_coverage),
       monica_usage = EXCLUDED.monica_usage, notes = EXCLUDED.notes, updated_at = now()
     RETURNING *`,
    [s.key, s.title, s.organisation, s.url, s.datasetIdentifier ?? null, s.category, s.retrievedAt ?? null, s.observationCoverage ?? null, s.monicaUsage, s.notes ?? null],
  );
  return rows[0];
}

export async function setSourceRetrieval(sourceKey, { retrievedAt, observationCoverage }) {
  await query(
    `UPDATE data_sources SET retrieved_at = $2, observation_coverage = COALESCE($3, observation_coverage), updated_at = now() WHERE source_key = $1`,
    [sourceKey, retrievedAt, observationCoverage ?? null],
  );
}

export async function listSources() {
  const { rows } = await query('SELECT * FROM data_sources ORDER BY category, title');
  return rows.map(toSourceDto);
}

export async function getSourceByKey(key) {
  const { rows } = await query('SELECT * FROM data_sources WHERE source_key = $1', [key]);
  return rows[0] || null;
}

// ---------------- Import runs ----------------
export async function startImportRun(sourceId, importer, importerVersion, parameters) {
  const { rows } = await query(
    `INSERT INTO import_runs (source_id, importer, importer_version, parameters, status) VALUES ($1,$2,$3,$4,'running') RETURNING id`,
    [sourceId, importer, importerVersion, JSON.stringify(parameters)],
  );
  return rows[0].id;
}

export async function finishImportRun(id, { status, seen, inserted, duplicates, gaps, messages, error }) {
  await query(
    `UPDATE import_runs SET status = $2, finished_at = now(), records_seen = $3, records_inserted = $4,
        records_skipped_duplicate = $5, records_marked_gap = $6, messages = $7, error_message = $8 WHERE id = $1`,
    [id, status, seen, inserted, duplicates, gaps, JSON.stringify(messages || []), error ?? null],
  );
}

export async function latestImportRuns(sourceKey, limit = 5) {
  const { rows } = await query(
    `SELECT r.* FROM import_runs r JOIN data_sources s ON s.id = r.source_id
      WHERE s.source_key = $1 ORDER BY r.started_at DESC LIMIT $2`,
    [sourceKey, limit],
  );
  return rows.map((r) => ({
    id: r.id, importer: r.importer, importerVersion: r.importer_version, parameters: r.parameters, status: r.status,
    startedAt: r.started_at, finishedAt: r.finished_at, recordsSeen: r.records_seen, recordsInserted: r.records_inserted,
    recordsSkippedDuplicate: r.records_skipped_duplicate, recordsMarkedGap: r.records_marked_gap,
    messages: r.messages, errorMessage: r.error_message,
  }));
}

// ---------------- RAD observations ----------------
export async function insertRadiationObservation(client, o) {
  const { rowCount } = await client.query(
    `INSERT INTO radiation_observations (source_id, import_run_id, dataset_id, product_id, product_creation_time, sol, observation_number,
        observation_start_utc, observation_start_lmst, edr_filename, obs_duration_raw, detector, detector_description, quantity,
        archive_field, archive_description, value, value_text, unit, qc_raw, qc_flags, quality_status, data_file_url, label_file_url, byte_offset)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (product_id, observation_number, detector, quantity) DO NOTHING`,
    [o.sourceId, o.importRunId, o.datasetId, o.productId, o.productCreationTime, o.sol, o.observationNumber,
      o.observationStartUtc, o.observationStartLmst, o.edrFilename, o.obsDurationRaw, o.detector, o.detectorDescription, o.quantity,
      o.archiveField, o.archiveDescription, o.value, o.valueText, o.unit, o.qcRaw, JSON.stringify(o.qcFlags), o.qualityStatus,
      o.dataFileUrl, o.labelFileUrl, o.byteOffset],
  );
  return rowCount === 1;
}

export async function radiationSeries({ from, to, detectors = ['B', 'E'] }) {
  const params = [detectors];
  let where = 'detector = ANY($1::text[])';
  if (from) { params.push(from); where += ` AND observation_start_utc >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND observation_start_utc <= $${params.length}`; }
  const { rows } = await query(
    `SELECT dataset_id, product_id, product_creation_time, sol, observation_number, observation_start_utc, observation_start_lmst,
            edr_filename, obs_duration_raw, detector, detector_description, quantity, archive_field, archive_description,
            value, value_text, unit, qc_raw, qc_flags, quality_status, data_file_url, label_file_url, created_at
       FROM radiation_observations WHERE ${where}
      ORDER BY observation_start_utc, detector LIMIT 20000`,
    params,
  );
  return rows;
}

export async function radiationCoverage() {
  const { rows } = await query(
    `SELECT dataset_id, detector, unit, quantity, detector_description,
            min(observation_start_utc) AS first_obs, max(observation_start_utc) AS last_obs,
            min(sol) AS first_sol, max(sol) AS last_sol,
            count(*)::int AS total, count(value)::int AS with_value,
            count(*) FILTER (WHERE quality_status = 'no_issues_identified')::int AS no_issues,
            max(created_at) AS last_imported
       FROM radiation_observations GROUP BY dataset_id, detector, unit, quantity, detector_description ORDER BY detector`,
  );
  return rows;
}

// ---------------- DONKI events ----------------
export async function upsertSpaceWeatherEvent(client, e) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO space_weather_events (source_id, import_run_id, event_type, external_id, event_time, observed_by, summary, link, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (event_type, external_id) DO NOTHING RETURNING id`,
    [e.sourceId, e.importRunId, e.eventType, e.externalId, e.eventTime, JSON.stringify(e.observedBy), JSON.stringify(e.summary), e.link, JSON.stringify(e.raw)],
  );
  return rows.length === 1;
}

export async function listSpaceWeatherEvents({ from, to, types }) {
  const params = [];
  const where = [];
  if (from) { params.push(from); where.push(`event_time >= $${params.length}`); }
  if (to) { params.push(to); where.push(`event_time <= $${params.length}`); }
  if (types?.length) { params.push(types); where.push(`event_type = ANY($${params.length}::text[])`); }
  const { rows } = await query(
    `SELECT event_type, external_id, event_time, observed_by, summary, link, fetched_at
       FROM space_weather_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY event_time LIMIT 1000`,
    params,
  );
  return rows.map((r) => ({
    type: r.event_type, id: r.external_id, time: r.event_time, observedBy: r.observed_by, summary: r.summary, link: r.link, fetchedAt: r.fetched_at,
  }));
}

export async function spaceWeatherCoverage() {
  const { rows } = await query(
    `SELECT min(event_time) AS first_event, max(event_time) AS last_event, count(*)::int AS total, max(fetched_at) AS last_fetched
       FROM space_weather_events`,
  );
  return rows[0];
}
