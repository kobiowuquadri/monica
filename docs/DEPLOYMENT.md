# Deployment

Target architecture:

```
Browser ──HTTPS──▶ Vercel (static frontend/) ──rewrite /api/* ──▶ Render (Express, backend/) ──TLS──▶ Neon PostgreSQL
```

The browser only talks to the Vercel origin. `frontend/vercel.json` rewrites `/api/*` to the Render service, so the session cookie is first-party (`HttpOnly; Secure; SameSite=Lax`) and the CSP can stay `connect-src 'self'`.

> **Status.** The code, schema and imports were verified locally against the Neon database. Deployment to Render and Vercel has **not** been performed: it needs your Render and Vercel accounts. Follow the steps below and run the checks in step 7.

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
| `ALLOWED_ORIGINS` | `https://<your-project>.vercel.app` (comma-separate extra origins) |
| `NODE_ENV` | `production` (enables Secure cookies; the server refuses to start without a 32+ char `AUTH_SECRET`) |
| `TRUST_PROXY` | `2` when browsers reach the API through the Vercel rewrite (client → Vercel → Render), so rate limits use the real client IP; `true` (1 hop) if browsers call Render directly |
| `NASA_API_KEY` | optional |
| `DEMO_RETENTION_HOURS` | `24` |
| `NODE_VERSION` | `22` |

After the deploy, check:

```bash
curl https://monica-api.onrender.com/api/health   # {"status":"ok",...,"database":"configured"}
curl https://monica-api.onrender.com/api/ready    # {"status":"ready","database":"reachable","migrationsApplied":2}
```

If `DATABASE_URL` is missing, `/api/health` reports `"database":"not_configured"`, `/api/ready` returns 503, and every data endpoint returns `503 database_unavailable`. There is no silent in-memory fallback.

> Render's free plan sleeps when idle. The first request can take about 50 s, and the frontend shows "Waking the MONICA server…".

## 5. Deploy the frontend on Vercel

1. `frontend/vercel.json` rewrites `/api/*` to the Render service. It currently points at the deployed API, `https://monica-v3u4.onrender.com`; change it if your service URL differs:
   ```json
   { "source": "/api/:path*", "destination": "https://monica-v3u4.onrender.com/api/:path*" }
   ```
2. Vercel → **Add New Project** → import the repo.
   - **Root Directory:** `frontend`
   - **Framework preset:** Other
   - **Build command:** none
   - **Output directory:** `.`
3. Deploy. `frontend/config.js` uses `/api` automatically when not on localhost; it contains only public values.

## 6. CORS, cookies and environment summary

- With the rewrite, browser requests are same-origin. Still set `ALLOWED_ORIGINS` to the Vercel origin, because the CSRF check accepts state-changing requests only from the same host or an allowed origin.
- State-changing requests must also carry `X-Requested-With: monica`, which the frontend sends.
- If you deliberately call the Render URL directly from another site instead of using the rewrite:
  - set `COOKIE_SAMESITE=none` on Render;
  - add the Render URL to `connect-src` in `vercel.json`;
  - note that browsers blocking third-party cookies will break sign-in. The rewrite is the recommended setup.
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
