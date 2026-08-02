# Plan: feature/admin-console

Modeled on the School Apps admin: usage at a glance, credential reset, re-open
registration, backups visibility. Everything is **additive** — no existing middleware
order or route auth changes; writers on existing routes stay token-trusted.

## Server (`server.js`)

**Gate.** `ADMIN_KEY` env var. Unset → every `/api/admin/*` request 404s (admin
invisible by default; safe for template users). Set → require `X-Admin-Key` header,
compared with `crypto.timingSafeEqual` over SHA-256 digests (constant-time, and
length-independent). Bad keys feed an in-memory lockout in the `LOGIN_FAILS` style:
5 misses → 30-min lock (keyed globally, since there's no username). Admin auth is a
small router-level middleware mounted only on `/api/admin` — the existing CORS →
idempotency → token-auth chain is untouched, and because the token-auth middleware
rejects non-GET requests without a user token, the admin middleware must run
**before** it. Placement: a dedicated `app.use('/api/admin', ...)` registered just
*before* the global token-auth middleware, so admin requests authenticate by admin
key alone (idempotency still applies — it's registered earlier).

**Routes.**
- `GET /api/admin/overview` — per traveler (from `ALLOWED`): name, `registered`
  (row in `users`), `planner` (in `PLANNERS`), `lastActivity` (max of their
  `user_tokens.created_at`, `notes.created_at`, `suggestions.created_at`,
  `day_schedule.created_at`, `reservations.created_at`, `packing.created_at` where
  attributable), counts (interest votes via `interests.names` JSON scan, notes,
  suggestions, packing items). Globals: db file size, per-table row counts, trip
  title/dates (parsed once from `public/index.html`'s trip-data block), and
  `data.db.backup-*` files with mtimes.
- `POST /api/admin/reset-pin {name}` — delete the user's `users` row + all their
  `user_tokens`; registration re-opens on next login. Votes/notes/etc. untouched.
- `POST /api/admin/remove-user {name}` — reset-pin + clears `LOGIN_FAILS[name]`;
  response states content is retained.
- `POST /api/admin/backup` — `db.backup()` (better-sqlite3's online, sqlite-safe
  copy) to `data.db.backup-admin-<ISO-ish timestamp>`; returns filename.

Admin POSTs carry `X-Op-Id` from the client and flow through the existing
idempotency middleware unchanged.

## Client (`public/admin.html`)

Separate small page, NOT wired into the PWA nav. Plain fetch, inline styles matching
the app (DM Sans, navy `#0D2B4E`, gold `#C9A227`, card look). Key entry gate stores
the key in `sessionStorage` (never `localStorage`); every request sends `X-Admin-Key`
+ a random `X-Op-Id` on POSTs. Traveler cards: name, planner badge, registered dot,
last activity, counts, Reset PIN / Remove buttons each requiring type-the-name
confirmation. Globals panel: trip title/dates, db size, row counts, backups list.
"Backup Now" button. 401 → drop key, back to gate; 404 → "admin is disabled" notice.

## Docs

`ADMIN.md` — enable by setting `ADMIN_KEY` (ecosystem.config.js env or shell),
never commit a real key, access at `/admin.html`, what each action does.

## Stages (one commit each)

1. This plan.
2. Server: gate + lockout + overview.
3. Server: reset-pin / remove-user / backup.
4. Client `public/admin.html`.
5. `ADMIN.md`.

Harness after each server stage (curl on a side port): admin 404s without env;
wrong key 401s then locks out; right key works; reset-pin kills the old PIN, allows
re-registration, and votes survive; backup file appears and is a valid sqlite db.
If a stage fails twice: stop, write up, move on.
