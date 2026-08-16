# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted family-trip dashboard, shipped as a **clean template seeded with synthetic
sample data** (travelers Alex/Sam/Jordan/Riley/Casey, a 4-day "Sample Family Trip").
Stack: a vendored React PWA (single HTML file) + Node/Express 5 + SQLite (`better-sqlite3`).
End users make it "their trip" by editing data, not code.

## Scope & operating rules

- **Feature-build ONLY — NEVER family info.** This repo exists to build the dashboard's
  features. No real traveler names, dates, itineraries, PINs, addresses, or live trip
  URLs may ever appear in a commit, branch, issue, or report here — the synthetic
  Alex/Sam/Jordan/Riley/Casey data is the ONLY trip content permitted. Real trips live
  in the local `family-trip-*` folders (not git repos, never pushed).
- This repo is the clean **synthetic template**, not anyone's live trip. Real use means
  editing the `trip-data` block (see `BUILD_WITH_AI.md`), not changing this repo.
- **Local-first:** work against `localhost`. Don't run anything in `deploy/`, SSH anywhere,
  or touch a remote host unless explicitly asked to in that session.
- Any production deployment is a **separate target** from this repo.
- Prefer small, reviewable changes — show the diff before writing.
- Never commit `data.db` / any `*.db` / `.env` / secrets / logs (see `.gitignore`).

## Commands

```bash
npm install        # requires Node 22 or 24 LTS (24 recommended, pinned in .nvmrc); Node 20 is EOL
npm start          # node server.js → http://localhost:3000
# Ctrl+C in that terminal stops the server
PORT=8080 npm start
curl -s localhost:3000/api/health   # {"status":"ok",...} when up
```

There is **no build step, no linter, and no test suite.** `public/index.html` is already a
compiled single-file artifact — you edit it directly. To reset all state, stop the server and
delete `data.db` (recreated empty on next start).

## Architecture

Two files hold essentially everything:

- **`server.js`** — the entire API and DB layer in one file. On boot it `CREATE TABLE IF NOT
  EXISTS`es every table and runs idempotent `ALTER TABLE`/backfill migrations inline (wrapped in
  `try/catch` so re-runs are no-ops — this is the migration mechanism; add new columns the same
  way). `data.db` lives in the project folder and is **never overwritten by deploys.**
- **`public/index.html`** (~7000 lines) — the whole front end. React is loaded from vendored
  production builds (`public/react*.js`) and the UI is written as raw `React.createElement`
  calls — **there is no JSX and no Babel in the browser.** Trip content lives in a
  `<script type="application/json" id="trip-data">` block near the top; `DEFAULT_TZ` (plus
  optional `DAY_TZ`/`ACT_TZ`) is defined just below it.

### Request pipeline (middleware order matters, all in `server.js`)
1. **CORS** — permissive (`*`), allows `X-Op-Id` and `X-Auth-Token` headers.
2. **Idempotency** — any non-GET carrying `X-Op-Id` is applied at most once (logged in
   `processed_ops`, pruned after 14 days). This is what makes the client's offline replay safe.
3. **Auth** — every non-GET except `/api/login` and `/api/health` must carry a valid
   `X-Auth-Token`; the server resolves the user from `user_tokens` and sets `req.authUser`.
   **Writers are trusted by their token, never by a self-asserted `author` field in the body.**
4. Route handlers, then a centralized JSON error handler at the end.

### Offline-first client
The client wraps writes in `qfetch` (`public/index.html`): it auto-attaches `X-Op-Id` and the
stored `X-Auth-Token` (`localStorage` key `tg_token`), and queues failed writes in a
`localStorage` outbox to replay later. Server-side idempotency (#2 above) is the other half of
this contract — keep them in sync if you touch either.

### Authorization model
- `ALLOWED` = who can log in. `PLANNERS` = who can edit the **Day Plan** (`/api/schedule`).
  Both are hardcoded arrays near the top of `server.js`.
- **Bookings ↔ Day Plan are a two-way mirror.** A day-plan row links to a reservation via
  `day_schedule.res_id`; creating/deleting one cascades to its pair inside a `db.transaction`.
  A booking that's on the day plan can only be deleted by a planner. Preserve this linkage when
  editing reservation or schedule routes.
- Login PINs are SHA-256 hashed; brute-force lockout is **in-memory** (`LOGIN_FAILS`), so it
  resets on restart by design.

## The #1 gotcha: traveler names must match in FOUR places

When renaming/changing travelers, the name must be spelled **identically** in:
1. each `"name"` in the `family` array (the `trip-data` block in `public/index.html`),
2. `ALLOWED` in `server.js`,
3. `PLANNERS` in `server.js`,
4. the client-side `const PLANNERS = [...]` in `public/index.html` (just below the
   trip-data block) — this only gates the Day-Plan **edit UI**; the server list (#3) is
   what actually authorizes the write.

A mismatch in 1–3 means that person silently can't log in; a mismatch in 4 means they log
in but never see the Day-Plan edit buttons. `tools/validate-trip-data.js` checks all four.
See `BUILD_WITH_AI.md` for the full trip-data schema (the canonical reference for the
`trip-data` JSON shape).

## Deploying

Production runs under PM2 (`ecosystem.config.js`, port 3000) behind nginx. The deploy kit lives
in `deploy/` (`provision.sh` → `deploy.sh` → `setup-https.sh`); see `deploy/DEPLOY.md`. Runtime
upgrade runbooks (Node 24, Express 5) are under `docs/maintenance/`.

## Autonomous runs & report hygiene
- **Run parameters (extended Aug 2026)**: the mission runs until its queue is
  empty — no task-count cap. Scope tripwire: STOP AND REPORT (never rewrite)
  if any single branch would exceed ~800 changed lines, or if a change would
  touch middleware order, `.env`, `data.db`, or `ecosystem.config.js`.
- **Hard rules (unchanged)**: branches only — never commit to `main`, no
  merges; granular commits; push each branch when its work completes; no
  server work ever during an autonomous run.

- Session reports and any artifact that quotes live URLs, server IPs, or real family
  names are written **outside the repo**, to `~/code/_archive/trip-dashboard/`
  (e.g. `OVERNIGHT_REPORT_<n>.md`). That archive directory is the only permitted write
  location outside the repo during an autonomous run; the repo working tree stays
  **audit-clean** at all times — never park such content here "temporarily".
- Before publishing the public template, run `tools/audit-publish.sh` (exit 0 = clean;
  nonzero = it prints the offending tracked lines). The script's term list is stored
  encoded so the script passes its own audit — see the comment inside it before editing.
- Publish only from a **tag that postdates any leak fix**: git history before the fix
  still contains the leaked content, so a publish that includes older history (or a tag
  cut before the fix) re-leaks it.
