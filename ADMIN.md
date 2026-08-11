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

**Windows: copying the trip JSON to the clipboard.** Use PowerShell's
`Set-Clipboard`, which preserves UTF-8:

```
powershell.exe -NoProfile -Command "Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 'my-trip.json')"
```

**Never use `clip.exe`.** It mangles UTF-8, so em dashes and emoji arrive as
mojibake (`â€”`, `ðŸ›`) — and once that JSON is imported, the garbled text is
live for the whole family.

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

## After the trip — the review (retro)

The dashboard grows a **✅ Review** tab automatically the day after the trip's
`endDate` (in the trip's timezone) — nothing to enable, same logins. Each
traveler walks their own scheduled days and, for every item, first answers
**"Did you do this?"**. Only a **Yes** unlocks a rating (loved / good / meh /
disliked); a **No** simply closes the item and is never counted against the
idea — skipping a rainy boat trip says nothing about boats. Low ratings and
downgrades ask for a one-tap reason (weather, service, off day, …) so a bad
*experience* doesn't get misread as a bad *idea*. Travelers can also add
things they did that were never on the plan — those are the strongest signal
of all. Answers save one by one; anyone can stop halfway and pick it up later.

**Checking completion** (with the admin key set, same header as the other
admin routes):

```bash
curl -s https://your-site/api/review/status -H "X-Admin-Key: your-key"
```

One row per traveler: how many scheduled items they had, how many they've
answered, self-added count, and when they last touched the review. Reviews
land in two dedicated tables (`reviews`, `review_additions`) and never modify
the pre-trip votes — both records are kept, and the gap between them is
exactly what the profile export reads.

## After the trip — traveler profiles

Run `tools/profile-export.js` **after the family has finished the review** —
the export gains per-traveler ACTUAL sections (what they really loved,
what genuinely wasn't their thing vs. what was just bad weather, what's worth
retrying, what they self-added) and labels every family-level retro section
with the responder count. It still works fine with no review data at all;
you just get the pre-trip picture only.

When a trip is over and you're about to retire the instance, its votes are the
only lasting record of what each traveler actually liked.
`tools/profile-export.js` turns them into one paste-ready block per traveler:
their star-weighted category totals, must-do and strong picks, suggestions they
wrote, and the family-level picture (unanimous choices, top consensus
activities, interests they declared but never voted for). Paste a block into the
prompt from `BUILD_WITH_AI.md` and the next trip starts from evidence instead of
guesswork.

```bash
node tools/profile-export.js --db data.db --trip my-trip.json [--out <file>]
```

`--trip` also accepts a `public/index.html` and pulls the trip-data block out of
it. Without `--out` the profiles go to stdout.

Before you point it at a database you are about to delete, run
`tools/profile-rehearsal.sh`. It builds a synthetic database with the real
schema, exports it, and asserts on the result — every traveler present, a
zero-vote traveler degrading rather than crashing, a not-attended item never
counted against an idea, a review on a moved day-plan row still attributed, and
the database byte-identical afterwards. Exit 0 means the export is trustworthy
on this machine, on this Node, today.

Two rules:

- **Work from a copy of the database.** The tool opens it read-only, but the
  habit is what protects you — copy `data.db` somewhere scratch and point `--db`
  at the copy.
- **Never commit the output.** These blocks are full of real names and
  preferences; this repo is a public template. Write them outside the repo
  (the tool warns if `--out` lands inside the working tree).
