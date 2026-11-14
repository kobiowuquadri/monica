# Data sources

MONICA keeps five kinds of information strictly apart:

| Category | Where it lives | Examples |
|---|---|---|
| 1. NASA environmental observations | `radiation_observations`, `space_weather_events` | Curiosity RAD dose rates, DONKI events |
| 2. NASA scientific reference material | `data_sources` (+ `backend/src/content/learning.js`) | HRP Space Radiation Element, SRAG, NASA-STD-3001 |
| 3. User-entered health observations | `check_ins`, `vital_readings`, `symptom_reports`, `medication_reports` | A heart-rate value typed by a user |
| 4. Calculated values | `baselines` (median method), rule outputs in `observations_or_alerts` | Median of 7 resting readings |
| 5. Interface-only demo identities | `profiles.is_fictional = true` | "Demo Crew Member A" |

No astronaut vital signs, lab results, radiation curves or sensor feeds are fabricated. Demo profiles start empty.

The registry below is also stored in the `data_sources` table (`npm run seed:sources`). The UI's **Sources & learning** page renders it.

---

## 1. MSL RAD RDR — primary radiation dataset (imported)

| Field | Value |
|---|---|
| Title | MSL Mars Radiation Assessment Detector RDR |
| Organisation | NASA Planetary Data System — Planetary Plasma Interactions (PPI) Node, UCLA (producer: SwRI RAD team) |
| Dataset ID | `MSL-M-RAD-3-RDR-V1.0` |
| URL | https://pds-ppi.igpp.ucla.edu/bundle/MSL-M-RAD-3-RDR-V1.0 |
| Files | `https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/…` |
| Retrieved / verified | 2026-11-14 |
| Archive coverage | 2011-11-20 → 2026-03-22 (`RAD_RDR_DS.CAT`, release 42 of 2026-08-03) |
| **Imported interval** | Surface sols **1806–1820**: observation start times **2017-09-04 00:07:46 UTC → 2017-09-19 09:38:34 UTC** |
| Imported records | 2,804 detector samples (1,402 per detector, B and E); 0 gaps; QC-flagged samples are kept and labelled |
| How MONICA uses it | Historical environmental context only. Absorbed dose rate per observation for detectors B and E, in the archived unit (µGy/h). Never treated as personal dose, never converted to Sv, and channels are never summed. |

### Verified definitions (from the archive's own documentation)

- **RAD_RDR_SIS §4.2.1.6 Dosimetry.** `[DOSIMETRY_TOTAL_DOSE_B: NN]` and `[DOSIMETRY_TOTAL_DOSE_E: NN]` give the total dose for detectors B and E in microGray/hour. Each label object `OBSnnn_TOT_DOSE_B_ELEMENT` / `…_E_ELEMENT` states `UNIT = "microGray / Hour"`, `DATA_TYPE = ASCII_REAL` and `BYTES = 8`.
- **RAD_RDR_SIS §4.2.1.2 Observation section.** It defines `START_OBS_UTC` (`YYYY-DDD HH:MM:SS`, UTC), `START_OBS_MARS` (LMST), `EDR_FILENAME` and `QC`, an 8-bit field:
  - `00000000` — no quality-control issues identified
  - bit 0 (`00000001`) — unknown quality-control issues may exist
  - bit 2 (`00000100`) — RAD is in DAN mode
  - bit 3 (`00001000`) — RAD was in Solar Event mode
  - higher bits are reserved
- **SIS caveat.** The SIS states that rover position and QC were *placeholders* when it was written. MONICA therefore:
  - does **not** display rover position (it reads `0.000` in the files);
  - shows QC with this caveat, so "no issues identified" is not presented as a guarantee.
- **`OBS_DURATION`** is present in the files but is not described in the SIS. MONICA stores it raw (`obs_duration_raw`) and does not assume a unit.
- **AAREADME.TXT.** Detached-label byte pointers are **1-based**. The importer subtracts 1 before issuing HTTP Range requests. A unit test checks this against the real bytes: pointer `18697` → characters `10.79981`.
- **RAD_INST.CAT.** Detectors A, B and C form a silicon solid-state stack; D is a CsI(Tl) scintillator; E is a plastic scintillator; F is a plastic anticoincidence shield.

### Quality handling

| QC / value | MONICA `quality_status` | Default chart |
|---|---|---|
| `00000000` | `no_issues_identified` | plotted |
| bit 0 or an undocumented bit set | `issues_may_exist` | **excluded** (line breaks); shown on demand as hollow grey markers |
| bit 2 or bit 3 only | `instrument_mode_flagged` | plotted, labelled |
| value missing | `missing` | gap |
| non-numeric or negative value | `invalid_value` | gap |

Lines also break where consecutive observations are more than 2 hours apart. This is a display convention, stated in the chart caption.

### Import method (`npm run import:rad`)

1. Read `INDEX/INDEX.TAB`, keeping the latest product version for each surface sol in the range.
2. For each sol, download the detached `.LBL` (about 1.6 MB) and parse the `TOT_DOSE` pointers, units and descriptions.
3. Request only the needed bytes of the roughly 86 MB `.TXT` file with HTTP multipart Range requests: each observation header and dosimetry block. That is well under 1 MB per sol. A server that ignores Range is refused rather than downloaded in full.
4. Parse values from the SIS section markers and cross-check them against the exact label pointer. A mismatch is stored as a gap and logged in the import run.
5. Insert with `ON CONFLICT DO NOTHING` on `(product_id, observation_number, detector, quantity)`. Re-runs count duplicates instead of inserting them.
6. Record the run in `import_runs` (parameters, counts, messages, status).

---

## 2. CDAWeb `MSL_RAD_OBS-L2` — referenced, **not imported (blocked)**

| Field | Value |
|---|---|
| URL | https://cdaweb.gsfc.nasa.gov/misc/NotesM.html#MSL_RAD_OBS-L2 |
| Status | **Blocked.** `cdaweb.gsfc.nasa.gov` and `spdf.gsfc.nasa.gov` timed out or reset connections from the build environment on 2026-11-14 (IPv4 and IPv6, with and without sandbox). A remote fetch also failed (`ECONNRESET`). A web search found no public text defining `DOSIMETRY_TOTAL_f`. |
| Consequence | MONICA does **not** claim to reproduce the quality-filtered `DOSIMETRY_TOTAL_f` variable. It uses the original PDS archive above, from which the CDAWeb dataset is derived. |
| To enable | From a network that can reach GSFC, read the dataset notes or master CDF. Verify `DOSIMETRY_TOTAL_f`'s dimensions, which array element corresponds to which detector, units, fill value and filter definition. Then add an importer and keep it separate from the PDS rows. |

---

## 3. NASA DONKI — space-weather context (imported, partially)

| Field | Value |
|---|---|
| Title | Space Weather Database Of Notifications, Knowledge, Information |
| Organisation | NASA Community Coordinated Modeling Center (CCMC), GSFC |
| Tool URL | https://ccmc.gsfc.nasa.gov/tools/DONKI/ |
| API used | `https://api.nasa.gov/DONKI/{CME,FLR,SEP,GST,IPS}?startDate=yyyy-MM-dd&endDate=yyyy-MM-dd&api_key=…`, as documented at https://api.nasa.gov/ (retrieved 2026-11-14) |
| Imported interval | 2017-09-01 → 2017-09-22 (aligned with the RAD interval) |
| Imported records | 41 events: SEP 10, CME 24, GST 3, IPS 4 |
| **Known gap** | `FLR` (solar flares) returned **HTTP 404 from api.nasa.gov on every attempt** (2026-11-14). The direct CCMC host was unreachable from the build environment. The import run is recorded as `partial`, and the UI says flare events are *absent*, not *none*. |
| Live mode | `GET /api/space-weather?mode=recent` requests the last 30 days (FLR, SEP, CME) and caches the result server-side for 1 hour. On failure it returns an honest `unavailable` state, or a clearly labelled stale cache. |
| How MONICA uses it | Event type, time, observing instruments or location as supplied, linked events, and a DONKI link. Earth-observed events are never treated as Mars exposure. MONICA never converts flare class into dose and never raises shelter alerts. |

`DEMO_KEY` allows about 10 requests per hour. Set `NASA_API_KEY` (free at https://api.nasa.gov/) in production.

---

## 4. NASA scientific reference material (learning content)

| Key | Title | Organisation | URL | Retrieved | Used for |
|---|---|---|---|---|---|
| `nasa-hrp-sre` | About the Space Radiation Element | NASA Human Research Program | https://www.nasa.gov/reference/about-the-space-radiation-element/ | 2026-11-14 | Radiation sources and the risk categories NASA studies |
| `nasa-srag-how` | How do we protect the astronauts from space radiation? | NASA JSC Space Radiation Analysis Group | https://srag.jsc.nasa.gov/spaceradiation/how/how.cfm | 2026-11-14 | Exposure depends on location, environment and shielding; radiation specialists support flight surgeons |
| `nasa-std-3001-hp` | NASA-STD-3001 Vol. 1 — 4.0 Human Performance | NASA Office of the Chief Health and Medical Officer | https://www.nasa.gov/reference/4-0-human-performance/ | 2026-11-14 | Monitoring through all mission phases (§4.3), ALARA (§4.8.1), career effective-dose definition (§4.8.2, *not computed by MONICA*) |
| `msl-rad-rdr-sis` | MSL RAD RDR Software Interface Specification | NASA PDS PPI | https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DOCUMENT/RAD_RDR_SIS.HTM | 2026-11-14 | Definitions of dose, dose equivalent and quality factor, plus the dataset fields |
| `msl-rad-inst-cat` | RAD instrument catalog | NASA PDS PPI | …/CATALOG/RAD_INST.CAT | 2026-11-14 | Detector descriptions |
| `msl-rad-readme` | Volume description and disclaimer | NASA PDS PPI | …/AAREADME.TXT | 2026-11-14 | Label pointer conventions and archive disclaimer |
| `api-nasa-donki-docs` | api.nasa.gov DONKI documentation | NASA | https://api.nasa.gov/ | 2026-11-14 | Endpoints, parameters and the DONKI description |

Every learning-card statement cites one of these sources with a section locator. Statements about MONICA's own behaviour are labelled "In MONICA" and are not presented as NASA statements. MONICA uses no NASA logos and claims no endorsement.
