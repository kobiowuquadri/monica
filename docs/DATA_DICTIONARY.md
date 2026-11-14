# Data dictionary

Schema: `backend/migrations/001_initial_schema.sql` and `002_symptom_assessment_status.sql`.

General conventions:
- UUID primary keys (`gen_random_uuid()`).
- Every timestamp is `timestamptz`, stored and compared in UTC. The profile time zone affects display and entry only.
- Units are stored next to every value; there is no generic "value" column without a unit.

## Accounts

### `users`
| Column | Type | Notes |
|---|---|---|
| `email` | text | Unique, case-insensitive (`lower(email)` index). Demo accounts use `demo-…@demo.monica.invalid` and are never shown. |
| `password_hash` | text | `scrypt$N$r$p$salt$hash` (N=16384, r=8, p=1, 64-byte key). Demo accounts hold an unusable `disabled$…` value. |
| `is_demo`, `demo_expires_at` | bool, timestamptz | Demo accounts are deleted (cascade) after `DEMO_RETENTION_HOURS`. |

### `sessions`
| Column | Notes |
|---|---|
| `token_hash` | HMAC-SHA256(`AUTH_SECRET`, token). The raw token exists only in the browser's HttpOnly cookie. |
| `expires_at` | 12 hours after creation. |

## Profiles

### `profiles`
Owned by one user (`user_id`). Every `/api/profiles/:id/*` request checks `id AND user_id`.

| Column | Notes |
|---|---|
| `display_name`, `role_title`, `mission_name`, `mission_phase`, `notes` | Free text. |
| `timezone` | IANA name, validated with `Intl.DateTimeFormat`. |
| `is_fictional` | `true` for demo identities (UI badge "Fictional demo identity"). |

## User-entered health observations

### `check_ins`
| Column | Type / values | Notes |
|---|---|---|
| `idempotency_key` | text, unique per profile | From the `Idempotency-Key` header. |
| `request_fingerprint` | SHA-256 of normalised payload | Detects key reuse with different data (→ 409). |
| `measured_at` | timestamptz | When measurements were taken. Not in the future, at most 365 days old. |
| `activity_context` | `resting`, `post_exercise`, `after_waking`, `during_activity`, `other`, `unknown` | Only `resting` readings are compared with a baseline. |
| `symptom_status` | `reported`, `none_reported`, `not_assessed` | An empty symptom list is never read as "no symptoms". |
| `sleep_duration_hours` | numeric(4,2), 0–24 | Self-reported. |
| `sleep_quality` | 1–5 | MONICA self-rating (1 Very poor … 5 Very good); not a validated instrument. |
| `fatigue_rating` | 0–10 | Self-rating (0 None, 5 Moderate, 10 Worst imaginable). |
| `mood_rating` | 1–5 | Self-rating (1 Very low … 5 Very good). |
| `rules_version` | text | Rules engine version applied (e.g. `2026.11-demo.1`). |

### `vital_readings`
| `metric` | Accepted `unit` | Input check range* | `method` |
|---|---|---|---|
| `heart_rate` | `beats/min` | 20–250 | — |
| `spo2` | `%` | 50–100 | — |
| `temperature` | `degC` / `degF` | 30–45 °C / 86–113 °F | required: `oral`, `tympanic`, `temporal`, `axillary`, `skin_wearable`, `other` |
| `bp_systolic`, `bp_diastolic` | `mmHg` | 50–300 / 20–200 | — (both required together; systolic > diastolic) |
| `respiratory_rate` | `breaths/min` | 4–80 | — |

\* Input check ranges catch typing errors only. They are **not clinical reference ranges** and are never used to label a reading normal or abnormal.

Other columns:
- `source_type`: `manual` | `device_reported`
- `device_label`: free text
- `quality`: `good` | `uncertain` | `poor` | `not_stated`

### `symptom_reports`
| Column | Notes |
|---|---|
| `symptom_code` | Fixed vocabulary (`backend/src/content/metrics.js`); `other` requires notes. |
| `severity` | `mild` / `moderate` / `severe` (self-rated). |
| `user_marked_urgent` | The user marked it as needing prompt medical attention (drives rule HC-002). |
| `onset_at`, `onset_note` | Optional. |

### `medication_reports`
What the user reports taking (`name_as_reported`, `amount_as_reported`, `taken_at`). MONICA never recommends medication or doses.

## Calculated values

### `baselines`
| Column | Notes |
|---|---|
| `method` | `recorded_value` (explicit value + required `source_note`) or `median_of_resting_readings`. |
| `method_version` | `recorded-value-v1` or `median-resting-v1`: the median of ≥ 5 `resting` readings of `good`/`not_stated` quality in a user-chosen window. A prototype convention, not clinically validated. |
| `sample_count`, `window_start`, `window_end` | Required for the median method. |
| `retired_at` | One active baseline per metric (partial unique index); replacing retires the old one. |

## Rules, follow-up and audit

### `observations_or_alerts`
| Column | Notes |
|---|---|
| `category` | `data_quality`, `personal_trend`, `health_concern`; environmental data never creates rows here. |
| `level` | `info`, `attention`, `urgent_review`. |
| `rule_id`, `rule_version`, `is_demonstration_rule` | E.g. `HC-002`, `2026.11-demo.1/1`, `true`. |
| `triggering_inputs`, `missing_information` | jsonb copies of the exact inputs and the missing items. |
| `explanation`, `suggested_next_step`, `reference` | Human-readable; `reference` is null when no external reference applies. |
| `status` | `open` → `acknowledged` → `resolved`. |

### `follow_up_actions`
`kind`: `action_taken` (status `recorded`) or `follow_up` (status `planned`, requires `scheduled_for`).

Closing states:
- `completed`, optionally with `completion_check_in_id` (must belong to the same profile) and `completion_note`;
- `cancelled`.

### `audit_events`
Identifiers and counts only (e.g. `{vitals: 2, symptoms: 1, observations: 3, rulesVersion}`). **Never values, symptom text or notes.**

## NASA data and provenance

### `data_sources`
`source_key`, `title`, `organisation`, `url`, `dataset_identifier`, `category` (`environmental_observation` | `scientific_reference` | `documentation`), `retrieved_at`, `observation_coverage`, `monica_usage`, `notes`.

### `import_runs`
`importer`, `importer_version`, `parameters` (jsonb), `status` (`running` | `succeeded` | `partial` | `failed`), `records_seen`, `records_inserted`, `records_skipped_duplicate`, `records_marked_gap`, `messages` (jsonb), `error_message`.

### `radiation_observations`
| Column | Example | Notes |
|---|---|---|
| `dataset_id` | `MSL-M-RAD-3-RDR-V1.0` | |
| `product_id` | `RAD_RDR_2017_253_04_24_1812_V00` | PDS product. |
| `sol`, `observation_number` | 1812, 0 | |
| `observation_start_utc` | 2017-09-10 04:24:11+00 | From `START_OBS_UTC`. |
| `observation_start_lmst` | `Sol 1812 01:02:41 LMST` | From `START_OBS_MARS`. |
| `detector` | `B` or `E` | One row per detector — channels are never summed. |
| `quantity` | `absorbed_dose_rate` | |
| `archive_field` | `OBS000_TOT_DOSE_B_ELEMENT` | Label object name. |
| `value` / `value_text` | 10.79981 / `"10.79981"` | `value` NULL = gap. |
| `unit` | `microGray / Hour` | Exactly as in the label. |
| `qc_raw`, `qc_flags`, `quality_status` | `00000000`, `[]`, `no_issues_identified` | See DATA_SOURCES.md. |
| `obs_duration_raw` | 961 | Unit not documented; not interpreted. |
| `data_file_url`, `label_file_url`, `byte_offset` | archive URLs; 0-based offset | Full provenance. |
| `import_run_id` | → `import_runs` | |

Unique key: `(product_id, observation_number, detector, quantity)`.

### `space_weather_events`
| Column | Notes |
|---|---|
| `event_type` | `FLR`, `SEP`, `CME`, `GST` or `IPS`. |
| `external_id` | DONKI ID. |
| `event_time` | Peak or begin, start, or event time, depending on type. |
| `observed_by` | Instrument display names as supplied. |
| `summary` | Selected documented fields: class, source location, max Kp, CME speed, IPS `location`. |
| `link` | DONKI page. |
| `raw` | Full upstream record. |

Unique key: `(event_type, external_id)`.
