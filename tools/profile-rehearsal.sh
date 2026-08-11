#!/usr/bin/env bash
# tools/profile-rehearsal.sh — LOCAL rehearsal of tools/profile-export.js.
# Same conventions as tools/hub-rehearsal.sh / tools/multi-rehearsal.sh:
# pass/fail row per assertion, non-zero exit on any failure, trap cleanup.
#
# WHY THIS EXISTS
# profile-export.js is the one tool that runs when an instance is about to be
# DELETED — it turns a retired trip's votes and reviews into the profiles that
# seed the next trip. If it silently drops a traveler or mis-attributes a
# review, the loss is irreversible: the database it read is gone afterwards.
# So it gets rehearsed against a synthetic database shaped like a real one,
# before it is ever pointed at a real one.
#
# HOW TO RUN
#   tools/profile-rehearsal.sh          # from anywhere inside the repo
# Exit 0 = every assertion passed. Needs nothing running: no server, no ports,
# no network. Reads only this repo's own node_modules (for better-sqlite3,
# required by absolute path so no node_modules junction is needed in scratch).
#
# WHAT IT PROVES
#  - the fixture is built from server.js's OWN schema (CREATE TABLEs + the
#    inline ALTER migrations), so it is real-shaped, not a convenient subset;
#  - every traveler gets a profile block, including one with zero votes, which
#    degrades to "no votes recorded" instead of crashing;
#  - a review with attended=0 NEVER counts against an idea (the case that most
#    quietly corrupts a profile: "we skipped it" read as "we disliked it");
#  - a review saved against a day-plan row that was later MOVED is still
#    attributed to its title rather than printed as "(unmatched id: …)"
#    (profile-export.js ~line 177 documents this case — this proves it);
#  - a spontaneous review_addition surfaces under its author;
#  - a circumstantial downgrade lands in "worth retrying", not in the
#    category weights;
#  - votes from a name no longer in family[] warn instead of vanishing;
#  - a pre-retro database (no reviews tables) still exports, with no ACTUAL
#    section — the backward-compatibility contract in the tool's header;
#  - the database is byte-identical after the run. It is opened read-only and
#    must stay that way: on teardown day this tool runs against the only copy.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BSQ="$ROOT/node_modules/better-sqlite3"
EXPORT="$ROOT/tools/profile-export.js"
PASS=0; FAIL=0
declare -a ROWS
ck() {  # ck <0|nonzero> <label>
  if [ "$1" = 0 ]; then PASS=$((PASS+1)); ROWS+=("PASS  $2"); else FAIL=$((FAIL+1)); ROWS+=("FAIL  $2"); fi
}

[ -d "$BSQ" ] || { echo "FATAL: $BSQ missing — run npm install first." >&2; exit 1; }
[ -f "$EXPORT" ] || { echo "FATAL: $EXPORT missing." >&2; exit 1; }

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
cd "$TMP"

DB="$TMP/fixture.db"
OLD="$TMP/fixture-old.db"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"

# ── the fixture ──────────────────────────────────────────────────────────────
# Schema is server.js's, verbatim: the CREATE TABLE block at the top, the
# locations/reviews/review_additions blocks further down, plus the inline
# ALTER migrations (res_id/moved_to/updated_at). A fixture missing those
# columns would rehearse a database shape that no longer exists in the field.
cat > "$TMP/seed.js" <<'SEED'
'use strict';
const Database = require(process.argv[2]);
const withRetro = process.argv[4] !== 'no-retro';
const db = new Database(process.argv[3]);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY, pin_hash TEXT, token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS interests (
    activity_id TEXT PRIMARY KEY, names TEXT DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS flight_status (
    flight_id TEXT PRIMARY KEY, status TEXT, checked_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day_id TEXT, author TEXT,
    label TEXT, url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, when_text TEXT,
    confirmation TEXT, who TEXT, notes TEXT, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS packing (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT, category TEXT,
    done INTEGER DEFAULT 0, who TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS day_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day_id TEXT, activity_id TEXT,
    title TEXT, time_text TEXT, who TEXT DEFAULT '[]', created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS processed_ops (
    op_id TEXT PRIMARY KEY, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS user_tokens (
    token TEXT PRIMARY KEY, name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS trip_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT, version INTEGER,
    updated_by TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS locations (
    name TEXT PRIMARY KEY, lat REAL, lng REAL, acc REAL, updated_at TEXT
  );
`);
db.exec('ALTER TABLE day_schedule ADD COLUMN res_id INTEGER');
db.exec('ALTER TABLE day_schedule ADD COLUMN moved_to INTEGER');
if (withRetro) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, activity_id TEXT,
      attended INTEGER, rating INTEGER, reason_code TEXT, reason_note TEXT,
      comment TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(name, activity_id)
    );
    CREATE TABLE IF NOT EXISTS review_additions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, title TEXT,
      category TEXT, day TEXT, rating INTEGER, reason_code TEXT,
      reason_note TEXT, comment TEXT, created_at TEXT, updated_at TEXT
    );
  `);
}

// ── the trip ───────────────────────────────────────────────────────────────
// Four fictional travelers. Riley votes on nothing — the zero-engagement case.
const trip = {
  title: 'Rehearsal Trip',
  family: [
    { name: 'Alex',   interests: ['food', 'markets'] },
    { name: 'Sam',    interests: ['hiking', 'opera'] },
    { name: 'Jordan', interests: ['museums'] },
    { name: 'Riley',  interests: ['beaches'] }
  ],
  categories: {
    food:   { label: 'Food & Wine' },
    out:    { label: 'Outdoors' },
    museum: { label: 'Museums' }
  },
  days: [
    { id: 'day1', label: 'Day 1', location: 'Old Town', activities: [
      { id: 'a-market', name: 'Saturday Market', cat: 'food',   tags: ['market'] },
      { id: 'a-hike',   name: 'Ridge Trail',     cat: 'out',    tags: ['hiking'] },
      { id: 'a-flop',   name: 'Late Night Food Court', cat: 'food', tags: ['food'] }
    ] },
    { id: 'day2', label: 'Day 2', location: 'Harbor', activities: [
      { id: 'a-museum', name: 'Maritime Museum', cat: 'museum', tags: ['museums'] }
    ] }
  ]
};
db.prepare('INSERT INTO trip_config (json, version, updated_by) VALUES (?, 1, ?)')
  .run(JSON.stringify(trip), 'profile-rehearsal');

// ── pre-trip votes ─────────────────────────────────────────────────────────
// "Name|stars" strings, exactly as the app stores them. 'Casey' is deliberately
// NOT in family[] — a renamed/removed traveler whose votes must warn, not vanish.
const int = db.prepare('INSERT INTO interests (activity_id, names) VALUES (?, ?)');
int.run('a-market', JSON.stringify(['Alex|3', 'Sam|2', 'Jordan|1', 'Casey|2']));
int.run('a-hike',   JSON.stringify(['Alex|2', 'Sam|3']));
int.run('a-museum', JSON.stringify(['Jordan|3']));
int.run('a-flop',   JSON.stringify(['Alex|3', 'Sam|1']));

db.prepare('INSERT INTO suggestions (day_id, author, label, url) VALUES (?,?,?,?)')
  .run('day2', 'Jordan', 'Harbor walking tour', 'https://example.invalid/tour');

// ── the day plan, including a MOVED row ────────────────────────────────────
// Row 1 is a custom (no activity_id) plan row that was moved to day 2: the
// server inserts the new row, then stamps moved_to on the old one. Reviews
// saved before the move still carry the OLD key, 'sched:1'.
const sched = db.prepare(
  'INSERT INTO day_schedule (day_id, activity_id, title, time_text, who, created_by) VALUES (?,?,?,?,?,?)');
sched.run('day1', null, 'Harbor Sunset Cruise', '18:00', '["Alex"]', 'Alex');   // id 1 (moved away)
sched.run('day2', null, 'Harbor Sunset Cruise', '18:00', '["Alex"]', 'Alex');   // id 2 (the new row)
db.prepare('UPDATE day_schedule SET moved_to = 2 WHERE id = 1').run();

// ── post-trip retro ────────────────────────────────────────────────────────
if (withRetro) {
  const rev = db.prepare(`INSERT INTO reviews
    (name, activity_id, attended, rating, reason_code, reason_note, comment, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const T = '2026-08-09T12:00:00.000Z';
  rev.run('Alex',   'a-market', 1,  3, null, null, null, T, T);
  // voted 3, came back a 'meh' for WEATHER: belongs in "worth retrying", and
  // must not drag the Food & Wine weight down.
  rev.run('Alex',   'a-flop',   1,  1, 'weather', null, null, T, T);
  // the moved row, keyed by the id it had BEFORE the move
  rev.run('Alex',   'sched:1',  1,  3, null, null, null, T, T);
  rev.run('Sam',    'a-hike',   1,  3, null, null, null, T, T);
  // attended=0: we never went. This must NEVER count against the idea, even
  // though the rating is -1 and the reason blames the activity itself.
  rev.run('Sam',    'a-flop',   0, -1, 'activity', null, null, T, T);
  rev.run('Jordan', 'a-museum', 1,  2, null, null, null, T, T);

  db.prepare(`INSERT INTO review_additions
    (name, title, category, day, rating, reason_code, reason_note, comment, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('Jordan', 'Riverside Jazz Bar', 'food', 'day2', 3, null, null, null, T, T);
}
db.close();
SEED

# ── assertion helpers ────────────────────────────────────────────────────────
# blk NAME — the section of the report between the NAME banner and the next rule.
cat > "$TMP/blk.js" <<'BLK'
'use strict';
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const i = lines.indexOf(process.argv[3]);
if (i < 0) process.exit(1);
const out = [];
for (let j = i + 2; j < lines.length; j++) {   // +2 skips the rule under the banner
  if (/^=+$/.test(lines[j])) break;
  out.push(lines[j]);
}
process.stdout.write(out.join('\n') + '\n');
BLK
blk() { node "$TMP/blk.js" "$OUT" "$1"; }

echo "==> building the synthetic fixture (server.js schema, verbatim)"
node "$TMP/seed.js" "$BSQ" "$DB" >/dev/null
ck $? "fixture built with the real schema + inline ALTER migrations"
node "$TMP/seed.js" "$BSQ" "$OLD" no-retro >/dev/null
ck $? "pre-retro fixture built (no reviews / review_additions tables)"

H0="$(sha256sum "$DB" | cut -d' ' -f1)"
[ -n "$H0" ]; ck $? "pre-run database hash captured"

echo "==> running profile-export.js against the fixture"
node "$EXPORT" --db "$DB" > "$OUT" 2> "$ERR"
ck $? "profile-export.js exited 0"

H1="$(sha256sum "$DB" | cut -d' ' -f1)"
[ "$H0" = "$H1" ]; ck $? "database byte-identical after the run (read-only contract)"

# ── every traveler appears ───────────────────────────────────────────────────
for n in ALEX SAM JORDAN RILEY; do
  grep -qx "$n" "$OUT"; ck $? "traveler block present: $n"
done

# ── the zero-vote traveler degrades, does not crash ──────────────────────────
grep -q 'Riley — no votes recorded; plan around anchor events\.' "$OUT"
ck $? "zero-vote traveler: prompt line degrades to 'no votes recorded'"
blk RILEY | grep -q 'VOTED — 0 votes; 0 must-do (3-star), 0 strong (2-star)'
ck $? "zero-vote traveler: vote counts render as 0, not blank or NaN"

# ── attended=0 must never count against an idea ──────────────────────────────
# Sam reviewed exactly two things; one was attended=0. If the filter were wrong,
# this line would read '2 rated' and Late Night Food Court would show as disliked.
blk SAM | grep -q 'ACTUAL (post-trip) — 1 rated; 1 loved, 0 good, 0 meh, 0 disliked'
ck $? "attended=0 review excluded from the rated count"
blk SAM | grep -q 'Late Night Food Court'
[ $? -ne 0 ]; ck $? "attended=0 activity named nowhere in the reviewer's block"
blk SAM | grep -A1 'Category weights (actual):' | grep -q 'Food & Wine'
[ $? -ne 0 ]; ck $? "attended=0 review does not move the category weights"

# ── the moved day-plan row ───────────────────────────────────────────────────
grep -q 'unmatched id: sched:1' "$OUT"
[ $? -ne 0 ]; ck $? "moved row: no '(unmatched id: sched:1)' anywhere"
blk ALEX | grep -A2 '^Loved:' | grep -q 'Harbor Sunset Cruise'
ck $? "moved row: review still attributed to its title under Loved"
grep -q 'Harbor Sunset Cruise — loved by Alex' "$OUT"
ck $? "moved row: also attributed in the family-level 'Actually loved'"

# ── spontaneous addition ─────────────────────────────────────────────────────
blk JORDAN | grep -q 'Riverside Jazz Bar (loved)'
ck $? "review_addition surfaces under Self-added for its author"
blk ALEX | grep -q 'Riverside Jazz Bar'
[ $? -ne 0 ]; ck $? "review_addition is not attributed to anyone else"

# ── circumstantial downgrade ─────────────────────────────────────────────────
blk ALEX | grep -q 'Late Night Food Court — weather'
ck $? "circumstantial downgrade lands in 'worth retrying'"
blk ALEX | grep -q '^- Overrated (voted 3, the activity itself missed): (none)$'
ck $? "circumstantial downgrade is NOT counted as overrated"

# ── other travelers' data stays theirs ───────────────────────────────────────
blk ALEX | grep -q 'Saturday Market'
ck $? "3-star vote listed under Must-do for its voter"
blk JORDAN | grep -q 'Harbor walking tour'
ck $? "authored suggestion listed under its author"

# ── a voter no longer in family[] ────────────────────────────────────────────
grep -q "Votes from names not in family\[\]: Casey" "$ERR"
ck $? "votes from a removed traveler warn on stderr instead of vanishing"
grep -q '^CASEY$' "$OUT"
[ $? -ne 0 ]; ck $? "…and get no profile block of their own"

# ── pre-retro database ───────────────────────────────────────────────────────
node "$EXPORT" --db "$OLD" > "$TMP/out-old.txt" 2>/dev/null
ck $? "pre-retro database (no reviews tables) still exports, exit 0"
grep -q 'ACTUAL (post-trip)' "$TMP/out-old.txt"
[ $? -ne 0 ]; ck $? "…with no ACTUAL section, as the header promises"
grep -qx 'RILEY' "$TMP/out-old.txt"
ck $? "…and still one block per traveler"

echo
echo "== profile-rehearsal summary =="
printf '%s\n' "${ROWS[@]}"
echo "-------------------------------"
echo "RESULT: $PASS PASS, $FAIL FAIL"
exit $FAIL
