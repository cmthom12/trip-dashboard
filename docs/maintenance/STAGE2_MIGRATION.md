# Stage 2 — Express 4 → 5 Migration

**What this stage does:** moves the server from Express 4.22 to **Express 5.2**, removes the
repetitive per-route `try/catch`, and adds one centralized error handler. No behavior change —
the full API works exactly as before.

| | Before | After |
|---|---|---|
| express | ^4.22.2 | **^5.2.1** (maintained major; ReDoS-hardened routing; stricter status-code validation; lighter deps) |
| error handling | `try/catch` in each of 23 routes | **1 centralized error handler** — Express 5 forwards any thrown error to it as clean JSON |
| route code | wrapped + indented | flat, no boilerplate |

## Why this was low-risk here
The app was already v5-compatible: routes use only simple `:id` params (no regex/wildcard
paths that v5 changed), `app.delete` (not the removed `app.del`), valid HTTP status codes
(v5 now rejects invalid ones), and it never mutates `req.query`. So the migration is a
dependency bump + an error-handling cleanup, not a rewrite.

## Verification already done
- A **27-point full-route smoke test** (every endpoint: login/auth, users, interests,
  flights, notes, suggestions, reservations, packing + toggle, schedule + PATCH + DELETE,
  the two-way booking↔plan mirror, idempotent replay, OPTIONS preflight) passes
  **identically on 4.22 (baseline) and on 5.2.1**.
- The new error handler was confirmed to catch a thrown error (a malformed-JSON body) and
  return a clean `400 {"error":…}` with the server still alive — the safety net that
  replaces the per-route `try/catch`.

## Applying it on staging
This is just new `server.js` + `package.json`, so the normal deploy handles it:
```bash
# from your laptop
bash deploy/deploy.sh           # pushes server.js + package.json, runs npm install, pm2 reload
```
`npm install` picks up Express 5 (pure JS — no native build). Then verify:
```bash
ssh -i ~/.ssh/YOUR_KEY YOUR_SERVER "cd /var/www/trip-dashboard && npm ls express && curl -s localhost:3000/api/health"
# express@5.2.x  +  {"status":"ok", ...}
```
Do a couple of real actions in the UI (log in, add a booking, place it on the day plan) to
confirm end-to-end.

## Rollback (low-risk — `data.db` is untouched)
Restore the previous `server.js` and set `express` back to `^4.22.2` in `package.json`, then:
```bash
cd /var/www/trip-dashboard && rm -rf node_modules package-lock.json && npm install
pm2 reload ecosystem.config.js
```

---
**Order note:** do Stage 1 (Node 24) first if you haven't — Express 5 needs Node 18+, which
Node 24 satisfies. **Next:** Stage 3 (HTTPS rollout) — the prerequisite for the location
feature. See `Update_Path_and_Recommendations.md`.
