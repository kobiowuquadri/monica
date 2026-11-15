# Rules and limitations

MONICA is a **hackathon research prototype**. It is not a validated diagnostic, monitoring or treatment system, and it is not affiliated with or endorsed by NASA.

## Rules engine

Code: `backend/src/services/rulesEngine.js`. Version: **`2026.11-demo.1`**.

The engine is deterministic, versioned and free of side effects, and it runs once per saved check-in. Every observation it stores includes:
- the rule ID and version;
- the exact triggering inputs;
- a plain-language explanation;
- any missing information;
- a suggested next step;
- a reference, where one applies;
- whether the rule is a demonstration rule.

Four kinds of output stay **separate** and are never combined:

| Category | Rules | Possible levels |
|---|---|---|
| Data quality | DQ-001, DQ-002, DQ-003 | info |
| Personal trend | PT-001 | info |
| Health concern | HC-001, HC-002, HC-003 | attention, urgent_review |
| Environmental radiation | *(no rules — display only)* | — |

### Rule catalogue

| ID | Trigger | Level | Notes |
|---|---|---|---|
| DQ-001 | A vital sign is marked `uncertain` or `poor` quality | info | Reading is stored, but excluded from baseline maths and comparisons. |
| DQ-002 | Vitals recorded in a non-resting context while a resting baseline exists for that metric | info | Reading is kept and charted separately; no comparison. |
| DQ-003 | Check-in has symptoms or wellbeing entries but no vital signs | info | Lists the unassessed measurements, so a gap is never mistaken for normal. |
| PT-001 | A resting reading of good or unstated quality, and an active baseline in the same unit | info | **Descriptive difference only** ("70 vs baseline 62.5 (+7.5)"). No threshold. |
| HC-001 | A symptom is rated `severe` by the user | attention | Based only on the self-rating. |
| HC-002 | The user marks a symptom as needing prompt medical attention | **urgent_review** | Evaluated independently of vitals, so normal readings can never cancel it. |
| HC-003 | The same symptom appears in an earlier check-in within 72 h | attention | The 72 h window is a MONICA prototype convention, not a clinical rule. |
| HB-001 | Health Brain index (RHI) is 25 or higher and no hard trigger fired | info (YELLOW) / attention (ORANGE) / **urgent_review** (RED) | Carries the full component breakdown and inputs. |
| HB-002 | A Health Brain hard trigger fired | **urgent_review** | Overrides the score and sets RED. Lists each trigger and the values behind it. |

All rules are **demonstration rules** (`is_demonstration_rule = true`). They use only recorded data and apply **no verified clinical thresholds** — none has been configured. The Health Brain cut-offs below are prototype values, labelled as such wherever they appear.

### Health Brain — the Radiation Health Index (RHI)

`backend/src/services/healthBrain.js` (model `rhi-prototype.1`) calculates a 0–100 index for every check-in. It is deterministic and calculated on read, so it always reflects the current model version.

| Component | Weight | Sub-score (0–100) |
|---|---|---|
| Exposure | 35% | Dose-rate reading ÷ the median of the profile's earlier dose-rate readings (at least 3 needed). Percent above that reference. |
| Symptoms | 30% | Worst severity (mild 25, moderate 55, severe 85) + 10 per additional symptom. "No symptoms reported" = 0. |
| Biomarkers | 20% | Higher of: lymphocyte drop below the median of earlier counts (5% → 0, 40% → 100) and body temperature (37.5 °C → 0, 39.0 °C → 100). |
| Wellbeing | 15% | Mean of recorded self-ratings: fatigue, reversed sleep quality and mood, sleep duration (≥ 7 h → 0, ≤ 4 h → 100). |

| Band | RHI | Prompt |
|---|---|---|
| GREEN | below 25 | Normal. Keep routine. |
| YELLOW | 25–49 | Watch. Repeat checks. |
| ORANGE | 50–74 | Act now. Alert ground. |
| RED | 75+ **or any hard trigger** | Shelter. Call the surgeon. |

Hard triggers (any one sets RED regardless of score): dose rate ≥ 2× the personal reference ("shelter threshold"); vomiting with onset within 2 h of a reading ≥ 1.5× the reference ("spike"); temperature ≥ 38.0 °C together with lymphocytes ≥ 25% below reference; chest discomfort or confusion at any severity.

Limits that are stated in the UI, the report and the API:

- **Every number above is a prototype value chosen by the team.** None is clinically validated and none is a NASA limit. They are to be calibrated against NASA-STD-3001 and clinical review.
- RHI organises recorded entries. It is **not** a diagnosis, a dose estimate, an inference of radiation injury or a fitness-for-duty verdict.
- A component with no data is "not assessed" and adds 0 points; coverage is always shown, because a partial index can understate.
- The band prompts are prompts. MONICA contacts no one.

### What MONICA deliberately does not do

- No "fit / safe for duty" verdict or "all systems normal" message. A GREEN band says only that nothing recorded raised the index.
- No composite score other than the labelled prototype RHI described above.
- No diagnosis of radiation injury. RHI hard triggers flag recorded combinations for review; they do not state a cause.
- No use of imported NASA rover data as a real person's exposure. Only the fictional demo scenario replays it, and says so on every value.
- No dose estimate from vomiting timing or any other symptom.
- No claim that symptom improvement shows recovery from radiation injury.
- No prescriptions, dosage calculators or medication recommendations. The medication log only records what the user reports taking.
- No treatment content. **No clinician-approved treatment protocol is configured**; observations suggest preparing a review summary and following mission medical procedures instead.
- No claim that anyone was contacted. There is no communication integration, so the UI says "Prepare review summary" and states that MONICA has not contacted anyone.
- No conversion of absorbed dose (Gy) to effective dose (Sv), and no summing of detector channels.
- No use of rover data as personal or career dose, and no comparison with NASA's career limit.
- No conversion of flare class into dose, and no shelter alert from Earth-observed space-weather events.
- No fabricated or random vitals, radiation curves, lab results or "live" sensor connections in real accounts. The two demo profiles are fictional and start with a **scripted scenario**, labelled as such: for Demo Crew Member A the dose rates are archived NASA MSL RAD detector E measurements (4–11 September 2017, including the 10–11 September solar particle event) shifted in time, each stored with its original observation time and PDS product; all vital signs, symptoms and lymphocyte counts are invented to demonstrate the logic. The real event was far too small to cause symptoms. See `backend/src/services/demoSeed.js`.

## Baselines

A baseline exists only when a user **explicitly** establishes one (Profile & settings). Without one, MONICA says "comparison unavailable".

| Method | Version | Definition |
|---|---|---|
| Recorded value | `recorded-value-v1` | A value the user enters from an identified record; a source note is required. |
| Median of resting readings | `median-resting-v1` | Median of **at least 5** readings in a `resting` context with `good` or unstated quality, over a user-chosen window. Fewer readings → HTTP 422, no baseline created. |

The median method is a prototype convention, **not** a clinically validated baseline method.

## Data-entry validation versus interpretation

Server-side validation (`backend/src/validation`) checks structure only:
- types and allowed units;
- ISO 8601 timestamps with an explicit zone, not in the future;
- systolic and diastolic entered together, with systolic above diastolic;
- a required measurement site for temperature;
- unknown fields;
- request size (64 KB);
- **typo-catching input ranges**.

These ranges are not clinical ranges and are never used to label a reading.

## Measurement guidance

The check-in shows short data-entry hints, labelled "Data-entry guidance by MONICA — not a clinical measurement protocol. Follow your mission's medical procedures and your device manufacturer's instructions."

It also tells users to enter only values a device actually displays, and not to derive one measurement from another.

## Display conventions

- Health charts plot observed points only. Lines join readings less than **48 h** apart within the same context; resting, post-exercise and other contexts are separate series. Manual entries are circles, device-reported entries triangles, and uncertain/poor quality hollow markers. An accessible table view is available.
- RAD charts break lines at missing or QC-flagged samples and at gaps over **2 h**. Observation dates are shown prominently. Historical replay is labelled "Historical NASA data replay".

## Known limitations

1. **CDAWeb `MSL_RAD_OBS-L2` / `DOSIMETRY_TOTAL_f` was not verified.** GSFC hosts were unreachable from the build environment. MONICA uses the original PDS RDR instead (see DATA_SOURCES.md).
2. **DONKI flare (FLR) events are missing** from the imported interval: api.nasa.gov returned HTTP 404 for FLR on every attempt. The UI says flares are absent, not "none".
3. **QC field caveat.** The RAD SIS says QC was a placeholder when written; "no issues identified" is not a guarantee.
4. **Public demo.** Demo accounts are isolated per browser session and deleted after 24 h (`DEMO_RETENTION_HOURS`), with an hourly cleanup. Anyone who opens the demo can enter data; it is visible only to that session.
5. **Rate limiting behind Vercel.** Requests proxied through a Vercel rewrite share edge IPs, so per-IP limits are coarse.
6. **Prototype security.** Passwords use scrypt, sessions are HttpOnly cookies, and there is CSRF protection and owner checks on every personal endpoint. There is no email verification, password reset, MFA or account deletion UI.
7. **Not a medical record system.** There is no clinician workflow, no integration with any medical or ground system, and no regulatory validation.
