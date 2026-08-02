# Admin console

A small, hidden admin page for whoever runs the server: usage at a glance, PIN
resets when someone forgets theirs, re-opening registration, and database backups.

**It is off by default.** Until you set an admin key, every admin URL pretends not
to exist (404), so template users who never read this page ship nothing extra.

## Enabling it

Pick a long random key (a password manager's generated password is perfect —
20+ characters). **Never commit it to git.**

**Production (PM2):** add it to the `env` block in `ecosystem.config.js` on the
server (this file stays on the server; don't commit the key), then restart:

```js
env: { PORT: 3000, ADMIN_KEY: "paste-your-long-random-key-here" }
```

```bash
pm2 restart ecosystem.config.js --update-env
```

**Local / one-off:**

```bash
ADMIN_KEY=paste-your-key npm start          # macOS/Linux/Git Bash
set ADMIN_KEY=paste-your-key && npm start   # Windows Command Prompt
```

## Using it

Open **`/admin.html`** on your dashboard (e.g. `https://your-site/admin.html`) and
enter the key. The key lives only in that browser tab (sessionStorage) and is sent
as an `X-Admin-Key` header on every request. Five wrong keys lock admin out for
30 minutes (server-side, resets on restart).

What you can do:

- **Overview** — per traveler: registered or not, planner badge, last activity,
  vote/note/suggestion/packing counts; plus trip dates, database size, table row
  counts, and the backup files sitting next to `data.db`.
- **Reset PIN** — for the family member who forgot theirs. Clears their PIN and
  signs out their devices; the name simply registers a fresh PIN at next sign-in.
  Votes, notes, and lists are untouched.
- **Remove** — Reset PIN plus clearing any login lockout, for "my cousin locked
  themselves out five times" day. Content is retained.
- **Backup now** — writes a SQLite-safe snapshot named
  `data.db.backup-admin-<timestamp>` next to `data.db` and lists it in the panel.
- **Trip Setup** — paste a complete trip-data JSON (the one your AI produced via
  `BUILD_WITH_AI.md`), **Validate** (same checks as the CLI validator, in plain
  English), then **Import**. The new trip goes live for everyone immediately —
  no restart, no file editing. PINs, votes, notes and lists are kept for travelers
  whose names stay the same; names missing from the new trip can no longer sign
  in (their data is retained); new names simply register at first login. Every
  import is kept as a version in the database, and **Export current** downloads
  the active trip JSON any time. Optional trip-JSON keys the import understands:
  `"planners": ["Name", …]` (who may edit the Day Plan — everyone if absent) and
  `"tz": "Europe/Rome"` (the trip's display timezone).

Both destructive buttons require typing the traveler's name to confirm; Import
shows a confirmation spelling out exactly what changes.

## Notes

- The admin API lives under `/api/admin/*` and never touches the family-facing
  routes or their token auth.
- Admins deliberately get **no** location powers: no forcing someone's sharing
  on, no reading positions without being a signed-in family member, no history
  to inspect (none is stored). Location sharing belongs to each traveler alone.
- The page isn't linked from the app; family members won't stumble into it, but
  the only real protection is the key — treat it like a password.
- `scripts/SERVER_OPS.md` (if present) covers nightly automated backups; the
  button here is for "right before I change something" snapshots.
