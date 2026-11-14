-- MONICA initial schema.
-- Conventions: UUID primary keys (gen_random_uuid, built into PostgreSQL 13+),
-- timestamptz columns stored and compared in UTC, explicit foreign keys and indexes.
-- Health data (user-entered), NASA environmental data and reference sources live in
-- separate tables and are never mixed.

-- ---------------------------------------------------------------------------
-- Accounts and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  display_name    text NOT NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  demo_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_demo_expiry CHECK (is_demo = false OR demo_expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_demo_expiry_idx ON users (demo_expires_at) WHERE is_demo;

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,          -- SHA-256 of the opaque cookie token; raw token never stored
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Profiles (a user may manage several; ownership enforced on every request)
-- ---------------------------------------------------------------------------
CREATE TABLE profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name   text NOT NULL,
  role_title     text,
  mission_name   text,
  mission_phase  text,
  timezone       text NOT NULL DEFAULT 'UTC',
  is_fictional   boolean NOT NULL DEFAULT false,   -- interface-only demo identity
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_user_idx ON profiles (user_id);

-- ---------------------------------------------------------------------------
-- User-entered health observations
-- ---------------------------------------------------------------------------
CREATE TABLE check_ins (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id            uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key       text NOT NULL,
  request_fingerprint   text NOT NULL,              -- SHA-256 of the normalised payload
  measured_at           timestamptz NOT NULL,       -- when the measurements were taken (UTC)
  activity_context      text NOT NULL CHECK (activity_context IN ('resting','post_exercise','after_waking','during_activity','other','unknown')),
  context_note          text,
  sleep_duration_hours  numeric(4,2) CHECK (sleep_duration_hours IS NULL OR (sleep_duration_hours >= 0 AND sleep_duration_hours <= 24)),
  sleep_quality         smallint CHECK (sleep_quality IS NULL OR sleep_quality BETWEEN 1 AND 5),
  fatigue_rating        smallint CHECK (fatigue_rating IS NULL OR fatigue_rating BETWEEN 0 AND 10),
  mood_rating           smallint CHECK (mood_rating IS NULL OR mood_rating BETWEEN 1 AND 5),
  notes                 text,
  rules_version         text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_ins_idempotency_unique UNIQUE (profile_id, idempotency_key)
);
CREATE INDEX check_ins_profile_measured_idx ON check_ins (profile_id, measured_at DESC);

CREATE TABLE vital_readings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_in_id    uuid NOT NULL REFERENCES check_ins(id) ON DELETE CASCADE,
  profile_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  metric         text NOT NULL CHECK (metric IN ('heart_rate','spo2','temperature','bp_systolic','bp_diastolic','respiratory_rate')),
  value          numeric(7,2) NOT NULL,
  unit           text NOT NULL,
  method         text,                         -- e.g. temperature site; free of interpretation
  source_type    text NOT NULL CHECK (source_type IN ('manual','device_reported')),
  device_label   text,
  quality        text NOT NULL CHECK (quality IN ('good','uncertain','poor','not_stated')),
  measured_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vital_readings_profile_metric_idx ON vital_readings (profile_id, metric, measured_at);
CREATE INDEX vital_readings_check_in_idx ON vital_readings (check_in_id);

CREATE TABLE symptom_reports (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_in_id            uuid NOT NULL REFERENCES check_ins(id) ON DELETE CASCADE,
  profile_id             uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  symptom_code           text NOT NULL,
  label                  text NOT NULL,
  severity               text NOT NULL CHECK (severity IN ('mild','moderate','severe')),
  onset_at               timestamptz,
  onset_note             text,
  user_marked_urgent     boolean NOT NULL DEFAULT false,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX symptom_reports_profile_idx ON symptom_reports (profile_id, created_at DESC);
CREATE INDEX symptom_reports_check_in_idx ON symptom_reports (check_in_id);

-- Self-reported medication log: records what the user reports taking. MONICA never recommends.
CREATE TABLE medication_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_in_id     uuid NOT NULL REFERENCES check_ins(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name_as_reported   text NOT NULL,
  amount_as_reported text,
  taken_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medication_reports_check_in_idx ON medication_reports (check_in_id);

-- Explicitly established personal baselines (never inferred silently).
CREATE TABLE baselines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  metric           text NOT NULL CHECK (metric IN ('heart_rate','spo2','temperature','bp_systolic','bp_diastolic','respiratory_rate')),
  method           text NOT NULL CHECK (method IN ('recorded_value','median_of_resting_readings')),
  value            numeric(7,2) NOT NULL,
  unit             text NOT NULL,
  sample_count     integer,
  window_start     timestamptz,
  window_end       timestamptz,
  source_note      text,
  method_version   text NOT NULL,
  established_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  established_at   timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz,
  CONSTRAINT baselines_median_requires_samples CHECK (method <> 'median_of_resting_readings' OR (sample_count IS NOT NULL AND window_start IS NOT NULL AND window_end IS NOT NULL))
);
CREATE UNIQUE INDEX baselines_one_active_per_metric ON baselines (profile_id, metric) WHERE retired_at IS NULL;

-- ---------------------------------------------------------------------------
-- NASA source registry and import provenance
-- ---------------------------------------------------------------------------
CREATE TABLE data_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key            text NOT NULL UNIQUE,
  title                 text NOT NULL,
  organisation          text NOT NULL,
  url                   text NOT NULL,
  dataset_identifier    text,
  category              text NOT NULL CHECK (category IN ('environmental_observation','scientific_reference','documentation')),
  retrieved_at          timestamptz,
  observation_coverage  text,
  monica_usage          text NOT NULL,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_runs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                  uuid NOT NULL REFERENCES data_sources(id),
  importer                   text NOT NULL,
  importer_version           text NOT NULL,
  parameters                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                     text NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  finished_at                timestamptz,
  records_seen               integer NOT NULL DEFAULT 0,
  records_inserted           integer NOT NULL DEFAULT 0,
  records_skipped_duplicate  integer NOT NULL DEFAULT 0,
  records_marked_gap         integer NOT NULL DEFAULT 0,
  messages                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message              text
);
CREATE INDEX import_runs_source_idx ON import_runs (source_id, started_at DESC);

-- NASA environmental measurements. One row per observation per detector per quantity;
-- channels are never summed. Absorbed dose rate is kept in its archived unit.
CREATE TABLE radiation_observations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                uuid NOT NULL REFERENCES data_sources(id),
  import_run_id            uuid NOT NULL REFERENCES import_runs(id),
  dataset_id               text NOT NULL,
  product_id               text NOT NULL,
  product_creation_time    timestamptz,
  sol                      integer NOT NULL,
  observation_number       integer NOT NULL,
  observation_start_utc    timestamptz NOT NULL,
  observation_start_lmst   text,
  edr_filename             text,
  obs_duration_raw         integer,          -- OBS_DURATION as archived; unit not stated in the RDR SIS
  detector                 text NOT NULL CHECK (detector IN ('B','E')),
  detector_description     text NOT NULL,
  quantity                 text NOT NULL,     -- e.g. 'absorbed_dose_rate'
  archive_field            text NOT NULL,     -- e.g. 'OBS003_TOT_DOSE_B_ELEMENT'
  archive_description      text,
  value                    double precision,  -- NULL = gap (missing / unparseable / rejected)
  value_text               text,              -- exact characters from the archive
  unit                     text NOT NULL,     -- as stated in the PDS label
  qc_raw                   text,
  qc_flags                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  quality_status           text NOT NULL CHECK (quality_status IN ('no_issues_identified','issues_may_exist','instrument_mode_flagged','missing','invalid_value')),
  data_file_url            text NOT NULL,
  label_file_url           text NOT NULL,
  byte_offset              bigint,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radiation_obs_unique UNIQUE (product_id, observation_number, detector, quantity)
);
CREATE INDEX radiation_obs_time_idx ON radiation_observations (observation_start_utc);
CREATE INDEX radiation_obs_detector_time_idx ON radiation_observations (detector, observation_start_utc);

CREATE TABLE space_weather_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id          uuid NOT NULL REFERENCES data_sources(id),
  import_run_id      uuid REFERENCES import_runs(id),
  event_type         text NOT NULL,             -- DONKI type code: FLR, SEP, CME, GST, IPS ...
  external_id        text NOT NULL,             -- DONKI activityID / flrID / sepID / gstID
  event_time         timestamptz NOT NULL,
  observed_by        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- instrument display names as supplied
  summary            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- selected documented fields
  link               text,
  raw                jsonb NOT NULL,            -- full upstream record for provenance
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT space_weather_unique UNIQUE (event_type, external_id)
);
CREATE INDEX space_weather_time_idx ON space_weather_events (event_time);

-- ---------------------------------------------------------------------------
-- Rule-engine observations, follow-up and audit history
-- ---------------------------------------------------------------------------
CREATE TABLE observations_or_alerts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id            uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  check_in_id           uuid REFERENCES check_ins(id) ON DELETE CASCADE,
  category              text NOT NULL CHECK (category IN ('data_quality','personal_trend','health_concern')),
  level                 text NOT NULL CHECK (level IN ('info','attention','urgent_review')),
  rule_id               text NOT NULL,
  rule_version          text NOT NULL,
  is_demonstration_rule boolean NOT NULL,
  title                 text NOT NULL,
  explanation           text NOT NULL,
  triggering_inputs     jsonb NOT NULL,
  missing_information   jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_next_step   text NOT NULL,
  reference             jsonb,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_at       timestamptz,
  acknowledged_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observations_profile_status_idx ON observations_or_alerts (profile_id, status, created_at DESC);
CREATE INDEX observations_check_in_idx ON observations_or_alerts (check_in_id);

CREATE TABLE follow_up_actions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  observation_id           uuid REFERENCES observations_or_alerts(id) ON DELETE SET NULL,
  kind                     text NOT NULL CHECK (kind IN ('action_taken','follow_up')),
  description              text NOT NULL,
  scheduled_for            timestamptz,
  status                   text NOT NULL CHECK (status IN ('recorded','planned','completed','cancelled')),
  completed_at             timestamptz,
  completion_check_in_id   uuid REFERENCES check_ins(id) ON DELETE SET NULL,
  completion_note          text,
  created_by               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_up_requires_schedule CHECK (kind <> 'follow_up' OR scheduled_for IS NOT NULL)
);
CREATE INDEX follow_up_profile_status_idx ON follow_up_actions (profile_id, status, scheduled_for);
CREATE INDEX follow_up_observation_idx ON follow_up_actions (observation_id);

-- Audit metadata only: no vital values, symptom text or notes are written here.
CREATE TABLE audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  profile_id    uuid REFERENCES profiles(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  entity_id     uuid,
  action        text NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_profile_idx ON audit_events (profile_id, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_events (entity_type, entity_id, created_at);
