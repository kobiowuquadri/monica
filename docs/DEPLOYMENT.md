# Deployment

Target architecture:

```
Browser ──HTTPS──▶ Vercel  https://monica-phi-one.vercel.app   (static frontend/)
   └────HTTPS──▶ Render  https://monica-v3u4.onrender.com/api  (Express, backend/) ──TLS──▶ Neon PostgreSQL
```

The browser loads the static frontend from Vercel and calls the API on Render directly (`frontend/config.js` → `LIVE_API_BASE_URL`). Because the two are different sites:

- **CORS.** The API allows only the origins in `ALLOWED_ORIGINS`, with credentials.
- **CSP.** The frontend's `connect-src` lists the Render origin (`frontend/vercel.json`).
- **Session.**
  - With `COOKIE_SAMESITE=none`, the API sets an `HttpOnly; Secure; SameSite=None; Partitioned` cookie.
  - The same opaque token is also returned in the sign-in response. The frontend keeps it in page memory only (never localStorage) and sends it as `Authorization: Bearer`, so sign-in still works in browsers that block cross-site cookies.
  - In those browsers a full page reload requires signing in again.

> **Status.** The API at `https://monica-v3u4.onrender.com` and the frontend at `https://monica-phi-one.vercel.app` have been deployed by the team. `/api/health` and `/api/ready` were verified against the deployed API (database reachable, 2 migrations, NASA data present). Redeploy both after pulling the latest code, then run the checks in step 7.

---

## 0. Prerequisites

- Node.js 20 or newer (tested with Node 24.12).
- A Git hosting account (GitHub/GitLab) that Render and Vercel can read.
- Accounts on Neon, Render and Vercel.
- Optional: a free api.nasa.gov key (https://api.nasa.gov/), for DONKI requests above `DEMO_KEY`'s limits.

Push the repository:

```bash
git add -A
git commit -m "MONICA prototype"
git remote add origin <your-repo-url>
git push -u origin main
```

`.gitignore` excludes `backend/.env`. Confirm with `git status` that no `.env` file is staged.

## 1. Create the Neon database

1. Neon console → **New project** (Postgres 16+; this project was verified on Postgres 18.7, region `us-east-2`).
2. **Connection Details** → copy the connection string with `sslmode=require`.
   - Use the **direct** (non-pooled) string for migrations and imports.
   - Either string works for the API.
3. Keep it secret. If a connection string was ever shared in plain text (chat, screenshots), **reset the role password** in Neon (Roles → Reset password) and use the new string.

## 2. Run migrations

```bash
cd backend
cp .env.example .env          # then edit DATABASE_URL and AUTH_SECRET
npm ci
npm run migrate               # applies migrations/*.sql once; safe to re-run
npm run seed:sources          # loads the source registry into data_sources
```

`npm run migrate` keeps a checksum per file in `schema_migrations` and refuses to run a migration that was edited after being applied.

## 3. Import the NASA data

These commands are run by an administrator from a trusted machine. There is **no** public import endpoint.

```bash
# Curiosity RAD dosimetry, surface sols 1806–1820 (2017-09-04 → 2017-09-19 UTC)
npm run import:rad -- --from-sol 1806 --to-sol 1820

# DONKI events for the same period (uses NASA_API_KEY or DEMO_KEY)
npm run import:donki -- --start 2017-09-01 --end 2017-09-22
```

- Both importers are idempotent. Re-running reports duplicates and inserts nothing new.
- Each run is recorded in `import_runs` with its parameters, counts, messages and status.
- RAD imports use HTTP Range requests: under 1 MB per sol instead of the full ~86 MB file.
- Limits: at most 60 sols / 60 days per run.
- Expected result for the interval above: 2,804 RAD samples (1,402 per detector) and 41 DONKI events (FLR currently returns HTTP 404 from api.nasa.gov; see DATA_SOURCES.md).

## 4. Deploy the API on Render

**Option A — Blueprint.** Render dashboard → **New → Blueprint** → select the repo. `render.yaml` defines `monica-api`:
- root `backend/`
- build `npm ci`, start `npm start`
- health check `/api/health`
- region Ohio (close to Neon us-east-2)

**Option B — manual.** New → Web Service, with the same settings.

Environment variables (Render → Environment):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (secret) |
| `AUTH_SECRET` | 48+ random bytes; the Blueprint generates one. Manual: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `ALLOWED_ORIGINS` | `https://monica-phi-one.vercel.app`. Comma-separate extra origins, e.g. add `http://localhost:5173` to run the local frontend against the live API |
| `COOKIE_SAMESITE` | `none`: the frontend and API are different sites. Makes the cookie `Secure; Partitioned` |
| `NODE_ENV` | `production` (enables Secure cookies; the server refuses to start without a 32+ char `AUTH_SECRET`) |
| `TRUST_PROXY` | `true` (browser → Render's load balancer → app). Use `2` only if requests are first proxied through a Vercel rewrite |
| `NASA_API_KEY` | optional |
| `DEMO_RETENTION_HOURS` | `24` |
| `NODE_VERSION` | `22` |

After the deploy, check:

```bash
curl https://monica-v3u4.onrender.com/api/health   # {"status":"ok",...,"database":"configured"}
curl https://monica-v3u4.onrender.com/api/ready    # {"status":"ready","database":"reachable","migrationsApplied":2}
```

If `DATABASE_URL` is missing, `/api/health` reports `"database":"not_configured"`, `/api/ready` returns 503, and every data endpoint returns `503 database_unavailable`. There is no silent in-memory fallback.

> Render's free plan sleeps when idle. The first request can take about 50 s, and the frontend shows "Waking the MONICA server…".

## 5. Deploy the frontend on Vercel

1. `frontend/config.js` sets `LIVE_API_BASE_URL = 'https://monica-v3u4.onrender.com/api'`, and `frontend/vercel.json` allows that origin in the CSP `connect-src`. If the API URL changes, update both.
2. Vercel → **Add New Project** → import the repo.
   - **Root Directory:** `frontend`
   - **Framework preset:** Other
   - **Build command:** none
   - **Output directory:** `.`
3. Deploy. The live project is `https://monica-phi-one.vercel.app`. `config.js` contains only public values.

To develop the frontend against a backend on your own machine, set `USE_LOCAL_API = true` in `config.js` (it then calls `http://<same-host>:8080/api`).

## 6. CORS, cookies and environment summary

- The API accepts browser requests only from origins in `ALLOWED_ORIGINS`.
- State-changing requests must also carry `X-Requested-With: monica` (sent by the frontend). Together with the origin check, this is the CSRF protection.
- The session is an HttpOnly cookie (`SameSite=None; Secure; Partitioned` when `COOKIE_SAMESITE=none`) plus the same token sent as `Authorization: Bearer` from page memory.
  - Either one authenticates.
  - Logout revokes the server-side session for both.
- Secrets live only in Render's environment and your local `backend/.env`. The frontend holds no secrets.

## 7. Test the deployed application

1. `GET /api/health` and `/api/ready` on Render (above).
2. Open `https://<project>.vercel.app`.
   - The landing page should appear, with a strip of real counts ("2,804 Curiosity RAD observations…") and, further down, the RAD chart.
   - The browser console should be free of errors; the network tab should show `/api/me` → 401 before sign-in.
   - **Create an account** should ask for your name once and land on "Welcome, <name>. Your health profile is ready."
3. Click **Explore the demo**.
   - Expect two "Fictional demo identity" profiles.
   - Every vital shows "No reading recorded".
4. **Radiation & space weather.**
   - The chart should show detector B and E series for 4–19 Sept 2017, labelled "Historical NASA data".
   - Expect 41 DONKI events, plus a notice that FLR is absent.
5. **Health check-in.** Record heart rate and SpO₂ and mark a symptom "needs prompt medical attention".
   - "Saved" should appear with a server timestamp.
   - Observations HC-002 (urgent review) and DQ-001, if quality is uncertain, should be listed.
6. **Actions & follow-up.** Acknowledge the observation, schedule a follow-up, then **Complete with check-in**.
7. **Reports.** Prepare a summary, then use **Print / save as PDF** and **Export JSON**.
8. Open a private window and start a second demo. The first demo's profiles must not be visible there.
9. Run the automated suites locally against your database:
   ```bash
   cd backend
   npm test          # unit tests + integration tests (integration uses a throwaway schema it creates and drops)
   ```

## Local development

```bash
cd backend
npm ci
npm run dev        # API on http://localhost:8080 (node --watch)
npm run frontend   # static frontend on http://localhost:5173 (dev server mirrors Vercel's CSP)
```

Open http://localhost:5173. Locally, `config.js` targets `http://<same-host>:8080/api`.

## Operations

- **Expired demo data.** Removed hourly by the API, or on demand with `npm run cleanup:demo`.
- **Logs.** Contain method, path, status and duration only — no bodies, query strings, cookies or health values.
- **New NASA intervals.** Re-run the importers with new ranges. Each run is recorded and visible in the UI provenance panel.
