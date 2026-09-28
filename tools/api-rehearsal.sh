#!/usr/bin/env bash
# tools/api-rehearsal.sh — LOCAL rehearsal of the write-integrity contract.
# Same conventions as tools/sso-rehearsal.sh: a pass/fail row per assertion,
# non-zero exit on any failure, trap cleanup, Git-Bash-safe.
#
# WHY THIS EXISTS
# A round of review found that several write paths trusted the client with data
# only the server can be right about: /api/interests stored whatever full array
# the body carried (so two people voting at once erased each other), notes and
# suggestions took a self-asserted author and let anyone delete anyone's row,
# a trip import could silently strand votes, and a day-plan move left retro
# reviews pointing at the tombstone. Those are all invisible in a single-user
# click-through — they need two users, a stale body, or a second step. Hence a
# harness.
#
# HOW TO RUN
#   tools/api-rehearsal.sh          # from anywhere inside the repo
# Exit 0 = every assertion passed. Everything is localhost; no network, no
# server, no deploy. Scratch lives in a temp dir and is removed on exit — the
# instances are stamped into that scratch dir and NEVER run from the repo root,
# because a trip server writes data.db next to its own server.js and would drop
# one into the working tree.
#
# It stamps the WORKING TREE (tracked files), not HEAD, so an uncommitted edit
# to server.js is what actually gets exercised — same reasoning as
# sso-rehearsal.sh.
#
# WHAT IT PROVES
#   interests : two users' stars survive interleaved writes; a stale full-array
#               body cannot erase someone else's star; omitting yourself removes
#               only your own entry.
#   notes     : a forged body author is ignored in favour of the token; over
#               the wire, a non-owner non-planner is refused (403, row kept)
#               while the owner and a planner both succeed — same trio for
#               suggestions. The fixture imports the sample trip plus one
#               NON-planner traveler (Morgan) to make that case expressible.
#   import    : a trip missing a voted id is refused and names the id; force
#               accepts it.
#   day plan  : a move carries the retro review to the new sched:<id> key, and
#               /api/review/items lists that item exactly once.
#   PIN pepper: with PIN_PEPPER set, a user whose stored hash is the legacy bare
#               sha256 still logs in, and the stored hash is rewritten.
#   roster    : locked, an unclaimed name is refused with the wrong-PIN answer
#               while a claimed name still logs in; /api/users withholds the
#               claimed/unclaimed distinction while locked and keeps it while
#               unlocked; an admin PIN reset re-opens first-claim for THAT NAME
#               ONLY under lock; unlocking restores claiming.
#
# NODE_MODULES: the scratch instances borrow this repo's node_modules by
# junction (Windows) / symlink (elsewhere), exactly as sso-rehearsal.sh does,
# and for the same reason (better-sqlite3's prebuilt binary). The links are
# unlinked explicitly before the scratch dir is deleted.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BSQ="$ROOT/node_modules/better-sqlite3"
PORT_A=3921   # the instance under test
ADMIN_KEY="api-rehearsal-admin-key-do-not-use-in-production"
PEPPER="api-rehearsal-pepper-do-not-use-in-production"
PASS=0; FAIL=0
declare -a ROWS
ck() {  # ck <0|nonzero> <label>
  if [ "$1" = 0 ]; then PASS=$((PASS+1)); ROWS+=("PASS  $2"); else FAIL=$((FAIL+1)); ROWS+=("FAIL  $2"); fi
}
J() { curl -s -H 'Content-Type: application/json' "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ -d "$BSQ" ] || { echo "FATAL: $BSQ missing — run npm install first." >&2; exit 1; }
if netstat -ano 2>/dev/null | grep ":$PORT_A " | grep -q LISTENING; then
  echo "FATAL: port $PORT_A is already in use — aborting before any setup." >&2; exit 1
fi

TMP="$(mktemp -d)"
A="$TMP/trip-a"
PID_A=""
cleanup() {
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null
  sleep 1
  # Unlink the borrowed node_modules BEFORE the recursive delete, so nothing
  # can ever walk through the link into the repo's own node_modules.
  if [ -e "$A/node_modules" ]; then
    case "$(uname -s)" in
      MINGW*|MSYS*) cmd //c rmdir "$(cygpath -w "$A/node_modules")" >/dev/null 2>&1 ;;
      *) rm -f "$A/node_modules" ;;
    esac
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

link_modules() { # link_modules <dir>
  case "$(uname -s)" in
    MINGW*|MSYS*) powershell -NoProfile -Command \
      "New-Item -ItemType Junction -Path '$(cygpath -w "$1/node_modules")' -Target '$(cygpath -w "$ROOT/node_modules")' | Out-Null" ;;
    *) ln -s "$ROOT/node_modules" "$1/node_modules" ;;
  esac
}

echo "==> stamping one trip instance into scratch"
stamp() { # stamp <dest>
  (cd "$ROOT" && git ls-files -z | tar --null -T - -cf -) | tar -x -C "$1"
}
mkdir -p "$A"
stamp "$A"
[ -f "$A/server.js" ] && [ -f "$A/public/index.html" ] && [ -f "$A/package.json" ]
ck $? "instance stamped from the WORKING TREE into scratch"
link_modules "$A"
ck $? "node_modules borrowed from the repo (prebuilt better_sqlite3.node)"

echo "==> booting instance :$PORT_A"
cd "$A"; PORT=$PORT_A ADMIN_KEY="$ADMIN_KEY" node server.js > server.log 2>&1 &
PID_A=$!
cd "$TMP"
up() { for _ in $(seq 1 40); do curl -s "localhost:$1/api/health" | grep -q '"status":"ok"' && return 0; sleep 0.5; done; return 1; }
up $PORT_A; ck $? "instance healthy on :$PORT_A"

API="localhost:$PORT_A"

# ── fixture: the sample trip plus ONE non-planner ───────────────────────────
# Every sample traveler is a planner, so the template alone cannot express
# "neither owner nor planner". Re-import the same trip with Morgan added to
# the family and planners pinned to the original five: Morgan signs in, votes
# and writes like anyone else but holds no planner powers.
echo "==> fixture: import the sample trip plus Morgan (non-planner)"
curl -s "$API/api/trip/export" -H "X-Admin-Key: $ADMIN_KEY" > "$TMP/trip0.json"
node -e '
  const fs = require("fs");
  const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  t.planners = t.family.map(f => f.name);
  t.family.push({ name: "Morgan", color: ["#F3F4F6", "#374151"], interests: [] });
  fs.writeFileSync(process.argv[2], JSON.stringify(t));
' "$TMP/trip0.json" "$TMP/trip-morgan.json"
ck $? "built the fixture trip: Morgan added, planners = the original five"
curl -s -X POST "$API/api/trip" -H 'Content-Type: application/json' \
  -H "X-Admin-Key: $ADMIN_KEY" --data-binary @"$TMP/trip-morgan.json" | grep -q '"ok":true'
ck $? "fixture trip imported (Morgan is on the roster, not a planner)"

# ── sign in four travelers ──────────────────────────────────────────────────
# Alex and Sam are the two voters; Casey is a planner used for the planner-
# delete cases; Morgan is the non-owner non-planner.
login() { # login <name> <pin> — prints the token
  J -X POST "$API/api/login" -d "{\"name\":\"$1\",\"pin\":\"$2\"}" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}
TOK_ALEX="$(login Alex 1111)";  [ -n "$TOK_ALEX" ]; ck $? "Alex claimed a PIN and holds a token"
TOK_SAM="$(login Sam 2222)";    [ -n "$TOK_SAM" ];  ck $? "Sam claimed a PIN and holds a token"
TOK_CASEY="$(login Casey 3333)";[ -n "$TOK_CASEY" ];ck $? "Casey (planner) claimed a PIN and holds a token"
TOK_MORGAN="$(login Morgan 5555)";[ -n "$TOK_MORGAN" ];ck $? "Morgan (non-planner) claimed a PIN and holds a token"

auth() { # auth <token> <curl args...>
  local t="$1"; shift
  J -H "X-Auth-Token: $t" "$@"
}

# ── H2: /api/interests merges server-side, per caller ───────────────────────
# Family-data reads need a signed-in reader since v0.24.0. Every read-back
# below goes through a traveler's token, so a "not present" check can only
# pass on a real 200 list — never on a 401 that happens to lack the text.
# Each read-back must be a real 200: any other status is logged to $RD_BAD and
# fails the "every read-back returned 200" row at the end (a 401 body never
# contains the text a check looks for, so it could otherwise pass silently).
RD_BAD="$TMP/rd-not-200"; : > "$RD_BAD"
rd() {
  local o c
  o="$(curl -s -w '\n%{http_code}' -H "X-Auth-Token: $TOK_ALEX" "$@")"; c="${o##*$'\n'}"
  [ "$c" = 200 ] || echo "$* → $c" >> "$RD_BAD"
  printf '%s' "${o%$'\n'*}"
}

# ── v0.24.0: reads are for signed-in travelers ──────────────────────────────
echo "==> R1: family-data reads refuse anonymous callers"
for ep in interests flights notes suggestions reservations packing schedule "review/items?name=Alex" trip/export; do
  C="$(code "$API/api/$ep")"
  [ "$C" = 401 ]; ck $? "anonymous GET /api/$ep → 401 ($C)"
done
for ep in interests notes reservations schedule; do
  C="$(code -H 'X-Auth-Token: not-a-real-token' "$API/api/$ep")"
  [ "$C" = 401 ]; ck $? "made-up token GET /api/$ep → 401 ($C)"
done
for ep in interests flights notes suggestions reservations packing schedule "review/items?name=Alex"; do
  C="$(code -H "X-Auth-Token: $TOK_MORGAN" "$API/api/$ep")"
  [ "$C" = 200 ]; ck $? "signed-in traveler GET /api/$ep → 200 ($C)"
done
C="$(code -H "X-Admin-Key: $ADMIN_KEY" "$API/api/reservations")"
[ "$C" = 200 ]; ck $? "operator (admin key) GET /api/reservations → 200 ($C)"

echo "==> R2: /api/trip gives anonymous callers a summary only"
ANON="$(curl -s "$API/api/trip")"
printf '%s' "$ANON" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const j = JSON.parse(s);
    const leaks = ["days", "flights", "reservationsSeed", "essentials", "embassies", "enrichments", "mustDos", "dayCoords", "categories"].filter(k => k in j);
    const famKeys = [...new Set((j.family || []).flatMap(f => Object.keys(f)))].sort().join(",");
    const ok = j.summary === true && leaks.length === 0 && (j.family || []).length > 0 &&
      famKeys === "color,name" && !("photosUrl" in (j.trip || {})) && typeof (j.trip || {}).title === "string";
    if (!ok) console.error("summary leaks or is malformed:", leaks, famKeys);
    process.exit(ok ? 0 : 1);
  });'
ck $? "anonymous GET /api/trip → summary: title/dates/names+colours only, no plan, no interests or dietary"
curl -s -H "X-Auth-Token: $TOK_MORGAN" "$API/api/trip" | grep -q '"days":\['
ck $? "signed-in GET /api/trip → the full trip (days present)"
curl -s -H "X-Admin-Key: $ADMIN_KEY" "$API/api/trip" | grep -q '"days":\['
ck $? "admin-key GET /api/trip → the full trip (days present)"
curl -s -H "X-Admin-Key: wrong-key" "$API/api/trip" | grep -q '"summary":true'
ck $? "wrong admin key GET /api/trip → summary, not the full trip"
C="$(code "$API/api/users")"; [ "$C" = 200 ]; ck $? "GET /api/users stays open for the sign-in screen ($C)"

echo "==> R3: signing out revokes only that device's token (v0.24.0)"
TOK_S1="$(login Sam 2222)"; TOK_S2="$(login Sam 2222)"
[ -n "$TOK_S1" ] && [ -n "$TOK_S2" ] && [ "$TOK_S1" != "$TOK_S2" ]; ck $? "Sam signed in on two devices (two different tokens)"
C="$(code -X POST -H "X-Auth-Token: $TOK_S1" "$API/api/logout")"
[ "$C" = 200 ]; ck $? "POST /api/logout with device 1's token → 200 ($C)"
C="$(code -H "X-Auth-Token: $TOK_S1" "$API/api/notes")"
[ "$C" = 401 ]; ck $? "device 1's token no longer reads after sign-out ($C)"
C="$(code -X POST -H "X-Auth-Token: $TOK_S1" -H 'Content-Type: application/json' -d '{"message":"after logout"}' "$API/api/notes")"
[ "$C" = 401 ]; ck $? "…nor writes ($C)"
C="$(code -H "X-Auth-Token: $TOK_S2" "$API/api/notes")"
[ "$C" = 200 ]; ck $? "device 2's token still works ($C)"
C="$(code -X POST "$API/api/logout")"
[ "$C" = 401 ]; ck $? "POST /api/logout with no token → 401 ($C)"
TOK_SAM="$(login Sam 2222)"

echo "==> R4: flight checks are stamped as an ISO time (v0.24.0)"
auth "$TOK_ALEX" -X POST "$API/api/flights" -d '{"flightId":"f-probe","status":"On time"}' >/dev/null
rd "$API/api/flights" | grep -q '"f-probe":{"status":"On time","checked":"20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T'
ck $? "flight status stamped with an ISO timestamp (shown in the trip's time zone by the app)"

echo "==> R5: token-dependent reads are never cached (v0.24.0)"
cc() { curl -s -D - -o /dev/null "$@" | tr -d '\r' | grep -i '^cache-control:'; }
cc -H "X-Auth-Token: $TOK_ALEX" "$API/api/trip" | grep -qi 'private, no-store'; ck $? "signed-in GET /api/trip sends Cache-Control: private, no-store"
cc "$API/api/trip" | grep -qi 'private, no-store';                             ck $? "anonymous GET /api/trip (the summary) too"
cc -H "X-Auth-Token: $TOK_ALEX" "$API/api/notes" | grep -qi 'private, no-store'; ck $? "a gated read (GET /api/notes) too"

echo "==> R6: packing toggle sets the state the client asks for (v0.24.0)"
PK="$(auth "$TOK_ALEX" -X POST "$API/api/packing" -d '{"item":"toggle probe"}' | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
pk_done() { rd "$API/api/packing" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(p=>String(p.id)===process.argv[1]);console.log(r?r.done:"missing")})' "$PK"; }
auth "$TOK_ALEX" -X POST "$API/api/packing/$PK/toggle" -d '{"done":1}' >/dev/null
auth "$TOK_ALEX" -X POST "$API/api/packing/$PK/toggle" -d '{"done":1}' >/dev/null
[ -n "$PK" ] && [ "$(pk_done)" = 1 ]; ck $? "{done:1} sent twice (a replay) leaves the item packed, not flipped back"
auth "$TOK_ALEX" -X POST "$API/api/packing/$PK/toggle" -d '{"done":0}' >/dev/null
[ "$(pk_done)" = 0 ]; ck $? "{done:0} unpacks it"
auth "$TOK_ALEX" -X POST "$API/api/packing/$PK/toggle" >/dev/null
[ "$(pk_done)" = 1 ]; ck $? "no body (an older client) still flips"

echo "==> H2: interleaved votes on one activity"
ACT="d1_dinner"
# Each client posts the full array it believes in — exactly what the shipped
# client does. Alex votes first; Sam's request was built before Alex's landed,
# so it lists only Sam. Last-writer-wins would drop Alex here.
auth "$TOK_ALEX" -X POST "$API/api/interests" -d "{\"activityId\":\"$ACT\",\"names\":[\"Alex|3\"]}" >/dev/null
auth "$TOK_SAM"  -X POST "$API/api/interests" -d "{\"activityId\":\"$ACT\",\"names\":[\"Sam|2\"]}" >/dev/null
GOT="$(rd "$API/api/interests")"
printf '%s' "$GOT" | grep -q 'Alex|3' && printf '%s' "$GOT" | grep -q 'Sam|2'
ck $? "two users vote in interleaved requests → both stars present afterward"

echo "==> H2: a stale full-array body cannot erase another user's star"
# Alex re-posts an array that lists only Alex — a tab that never saw Sam's vote.
auth "$TOK_ALEX" -X POST "$API/api/interests" -d "{\"activityId\":\"$ACT\",\"names\":[\"Alex|1\"]}" >/dev/null
GOT="$(rd "$API/api/interests")"
printf '%s' "$GOT" | grep -q 'Sam|2'
ck $? "stale body from Alex listing only Alex leaves Sam's existing star intact"
printf '%s' "$GOT" | grep -q 'Alex|1'
ck $? "…and Alex's own star is updated to the value they sent"

echo "==> H2: omitting yourself withdraws only your own vote"
auth "$TOK_ALEX" -X POST "$API/api/interests" -d "{\"activityId\":\"$ACT\",\"names\":[]}" >/dev/null
GOT="$(rd "$API/api/interests")"
printf '%s' "$GOT" | grep -q 'Alex|'
[ $? -ne 0 ]; ck $? "caller absent from the body → their entry is removed"
printf '%s' "$GOT" | grep -q 'Sam|2'
ck $? "…and only theirs: Sam's entry survives the withdrawal"

echo "==> H2: a body naming someone else cannot vote for them"
# Alex forges a body containing only Sam at 3 stars. Sam's stored entry must not
# move, and Alex must not gain one.
auth "$TOK_ALEX" -X POST "$API/api/interests" -d "{\"activityId\":\"$ACT\",\"names\":[\"Sam|3\"]}" >/dev/null
GOT="$(rd "$API/api/interests")"
printf '%s' "$GOT" | grep -q 'Sam|2'
ck $? "a forged entry for another user is ignored (Sam still 2 stars, not 3)"

echo "==> H2: a first vote on an activity with no row yet"
auth "$TOK_SAM" -X POST "$API/api/interests" -d '{"activityId":"d2_museum","names":["Sam|3"]}' >/dev/null
rd "$API/api/interests" | grep -q 'd2_museum'
ck $? "row does not exist yet → created with the caller's entry only"

# ── H2.1: the stars half is clamped server-side to the UI's 1..3 ────────────
echo "==> H2.1: stars are clamped server-side"
stars_stored() { # stars_stored <activity> <entry-json> — prints the stored entry for Sam
  auth "$TOK_SAM" -X POST "$API/api/interests" -d "{\"activityId\":\"$1\",\"names\":[$2]}" >/dev/null
  rd "$API/api/interests" | grep -o '"d2_museum":\[[^]]*\]' | grep -o '"Sam[^"]*"'
}
[ "$(stars_stored d2_museum '"Sam|9"')" = '"Sam|3"' ];   ck $? "stars above the UI range (9) are stored as 3"
[ "$(stars_stored d2_museum '"Sam|0"')" = '"Sam|1"' ];   ck $? "stars below the UI range (0) are stored as 1"
[ "$(stars_stored d2_museum '"Sam|-4"')" = '"Sam|1"' ];  ck $? "negative stars are stored as 1"
[ "$(stars_stored d2_museum '"Sam|abc"')" = '"Sam|2"' ]; ck $? "non-numeric stars become the UI default (2)"
[ "$(stars_stored d2_museum '"Sam"')" = '"Sam|2"' ];     ck $? "a bare name (no stars) is stored as the UI default (2)"
[ "$(stars_stored d2_museum '"Sam|3"')" = '"Sam|3"' ];   ck $? "an in-range value (3) is stored unchanged"

# ── H3: notes take the author from the token; delete is owner-or-planner ────
echo "==> H3: notes authorship and delete ownership"
NID="$(auth "$TOK_ALEX" -X POST "$API/api/notes" -d '{"author":"Sam","message":"forged-author probe"}' \
  | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
[ -n "$NID" ]; ck $? "note created"
rd "$API/api/notes" | grep -q '"author":"Alex","message":"forged-author probe"'
ck $? "note POST with a forged body author lands as the token user, not the body"

# The ownership trio, all over HTTP against the real middleware and route:
# a non-owner non-planner is refused and the row survives; the owner may
# delete; a planner may delete anyone's.
DCODE="$(code -X DELETE -H "X-Auth-Token: $TOK_MORGAN" "$API/api/notes/$NID")"
[ "$DCODE" = 403 ]; ck $? "non-owner non-planner (Morgan) delete of Alex's note → 403 ($DCODE)"
rd "$API/api/notes" | grep -q 'forged-author probe'
ck $? "…and the note survives the refused delete"
DCODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "X-Auth-Token: $TOK_CASEY" "$API/api/notes/$NID")"
[ "$DCODE" = 200 ]; ck $? "planner delete of someone else's note succeeds ($DCODE)"
rd "$API/api/notes" | grep -q 'forged-author probe'
[ $? -ne 0 ]; ck $? "…and the note is gone"

NID2="$(auth "$TOK_ALEX" -X POST "$API/api/notes" -d '{"message":"owner-delete probe"}' \
  | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
DCODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "X-Auth-Token: $TOK_ALEX" "$API/api/notes/$NID2")"
[ "$DCODE" = 200 ]; ck $? "owner delete of their own note succeeds ($DCODE)"

# Idempotent re-delete: the offline outbox replays deletes, so a vanished row
# must stay {ok:true} rather than becoming an error.
DCODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "X-Auth-Token: $TOK_ALEX" "$API/api/notes/$NID2")"
[ "$DCODE" = 200 ]; ck $? "re-deleting an already-deleted note stays 200 (outbox replay safety)"

echo "==> H3: suggestions authorship and delete ownership"
SG1="$(auth "$TOK_SAM" -X POST "$API/api/suggestions" \
  -d '{"dayId":"day1","author":"Alex","label":"probe","url":"https://example.com"}' \
  | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
[ -n "$SG1" ]; ck $? "suggestion created (id $SG1)"
rd "$API/api/suggestions" | grep -q '"author":"Sam"'
ck $? "suggestion POST with a forged body author lands as the token user"

# Same trio as notes, over the wire.
DCODE="$(code -X DELETE -H "X-Auth-Token: $TOK_MORGAN" "$API/api/suggestions/$SG1")"
[ "$DCODE" = 403 ]; ck $? "non-owner non-planner (Morgan) delete of Sam's suggestion → 403 ($DCODE)"
rd "$API/api/suggestions" | grep -q "\"id\":$SG1,"
ck $? "…and the suggestion survives the refused delete"
DCODE="$(code -X DELETE -H "X-Auth-Token: $TOK_SAM" "$API/api/suggestions/$SG1")"
[ "$DCODE" = 200 ]; ck $? "owner delete of their own suggestion succeeds ($DCODE)"
rd "$API/api/suggestions" | grep -q "\"id\":$SG1,"
[ $? -ne 0 ]; ck $? "…and it is gone"
SG2="$(auth "$TOK_SAM" -X POST "$API/api/suggestions" \
  -d '{"dayId":"day1","label":"planner-delete probe","url":"https://example.com/2"}' \
  | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
DCODE="$(code -X DELETE -H "X-Auth-Token: $TOK_CASEY" "$API/api/suggestions/$SG2")"
[ "$DCODE" = 200 ]; ck $? "planner delete of someone else's suggestion succeeds ($DCODE)"
rd "$API/api/suggestions" | grep -q 'planner-delete probe'
[ $? -ne 0 ]; ck $? "…and it is gone"

# ── M2: an import that would strand votes is refused ────────────────────────
echo "==> M2: import refuses to orphan voted activity ids"
# Export the live trip, then drop the day that holds the voted activity.
curl -s "$API/api/trip/export" -H "X-Admin-Key: $ADMIN_KEY" > "$TMP/trip.json"
[ -s "$TMP/trip.json" ]; ck $? "current trip exported"
node -e '
  const fs = require("fs");
  const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  // Rename the voted activity id so it disappears from the new trip while the
  // trip itself stays valid (same day count, same activity count).
  for (const d of t.days) for (const a of (d.activities || [])) {
    if (a.id === "d1_dinner") a.id = "d1_dinner_renamed";
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(t));
' "$TMP/trip.json" "$TMP/trip-missing.json"
ck $? "built a trip with the voted id renamed away"

# Put a vote back on d1_dinner (the withdrawal case above cleared Alex's).
auth "$TOK_ALEX" -X POST "$API/api/interests" -d "{\"activityId\":\"$ACT\",\"names\":[\"Alex|3\"]}" >/dev/null
RESP="$(curl -s -X POST "$API/api/trip" -H 'Content-Type: application/json' \
  -H "X-Admin-Key: $ADMIN_KEY" --data-binary @"$TMP/trip-missing.json")"
printf '%s' "$RESP" | grep -q 'd1_dinner'
ck $? "import of a trip missing a voted id is refused, naming the id"
printf '%s' "$RESP" | grep -q '"ok":false'
ck $? "…and reports ok:false"

RESP="$(curl -s -X POST "$API/api/trip?force=1" -H 'Content-Type: application/json' \
  -H "X-Admin-Key: $ADMIN_KEY" --data-binary @"$TMP/trip-missing.json")"
printf '%s' "$RESP" | grep -q '"ok":true'
ck $? "force=1 → the same import is accepted"

# Put the original trip back so the day-plan case below works against known ids.
curl -s -X POST "$API/api/trip?force=1" -H 'Content-Type: application/json' \
  -H "X-Admin-Key: $ADMIN_KEY" --data-binary @"$TMP/trip.json" | grep -q '"ok":true'
ck $? "original trip restored"

# ── M3: a day-plan move carries retro reviews with it ──────────────────────
echo "==> M3: day-plan move carries reviews"
# A plan row with no trip-data activity id is keyed sched:<row id>, which is the
# key a move changes. Casey is a planner, so Casey creates it.
SID="$(auth "$TOK_CASEY" -X POST "$API/api/schedule" \
  -d '{"dayId":"day1","title":"Review-follow probe","time":"09:00","who":["Casey"]}' \
  | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
[ -n "$SID" ]; ck $? "plan row created (id $SID)"

auth "$TOK_CASEY" -X POST "$API/api/review/item" \
  -d "{\"activityId\":\"sched:$SID\",\"attended\":1,\"rating\":3}" | grep -q '"ok":true'
ck $? "retro review saved against sched:$SID"

NEWID="$(auth "$TOK_CASEY" -X POST "$API/api/dayplan/move" \
  -d "{\"schedule_id\":$SID,\"target_day\":\"day2\"}" \
  | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
[ -n "$NEWID" ] && [ "$NEWID" != "$SID" ]; ck $? "item moved to day2 as a new row (id $NEWID)"

ITEMS="$(rd "$API/api/review/items?name=Casey")"
# Checked against the `reviews` map specifically, not anywhere in the payload:
# `items` always contains the new sched:<id>, so a substring match here would
# pass even with the review still stranded on the tombstone.
printf '%s' "$ITEMS" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const j = JSON.parse(s);
    const k = "sched:" + process.argv[1];
    if (!j.reviews || !j.reviews[k]) { console.error("no review under " + k); process.exit(1); }
    if (j.reviews[k].rating !== 3) { console.error("review moved but lost its rating"); process.exit(1); }
  });
' "$NEWID"
ck $? "the review itself followed to the new sched:$NEWID key, rating intact"
printf '%s' "$ITEMS" | grep -q "sched:$SID"
[ $? -ne 0 ]; ck $? "…and nothing is still keyed to the old sched:$SID"
[ "$(printf '%s' "$ITEMS" | grep -o "Review-follow probe" | wc -l)" = 1 ]
ck $? "/api/review/items lists the moved item exactly once"

# ── H1: roster claim lock ──────────────────────────────────────────────────
echo "==> H1: roster claim lock"
curl -s "$API/api/admin/roster-lock" -H "X-Admin-Key: $ADMIN_KEY" | grep -q '"locked":false'
ck $? "roster lock defaults to OFF (today's behavior)"
# H1.b, unlocked: /api/users is the historical claimed list (the claiming-
# window chrome is genuinely useful there), plus locked:false.
U="$(curl -s "$API/api/users")"
printf '%s' "$U" | grep -q '"locked":false'; ck $? "unlocked /api/users reports locked:false"
printf '%s' "$U" | grep -q '"Alex"' && ! printf '%s' "$U" | grep -q '"Riley"'
ck $? "unlocked /api/users lists claimed names (Alex) and not unclaimed ones (Riley)"

curl -s -X POST "$API/api/admin/roster-lock" -H 'Content-Type: application/json' \
  -H "X-Admin-Key: $ADMIN_KEY" -d '{"locked":true}' | grep -q '"locked":true'
ck $? "roster lock turned on via the admin route"
# H1.b, locked: the claimed / unclaimed distinction is withheld.
U="$(curl -s "$API/api/users")"
printf '%s' "$U" | grep -q '"locked":true'; ck $? "locked /api/users reports locked:true"
printf '%s' "$U" | grep -q '"Riley"' && printf '%s' "$U" | grep -q '"Jordan"'
ck $? "locked /api/users lists every name, unclaimed ones included — no claimed-name oracle"

# Jordan and Riley have never signed in, so both are unclaimed.
RESP="$(J -X POST "$API/api/login" -d '{"name":"Jordan","pin":"9999"}')"
printf '%s' "$RESP" | grep -q '"error":"Incorrect PIN"'
ck $? "locked: an unclaimed name is refused with the wrong-PIN error"
printf '%s' "$RESP" | grep -q '"token"'
[ $? -ne 0 ]; ck $? "…and no token is issued"
[ "$(code -X POST -H 'Content-Type: application/json' -d '{"name":"Jordan","pin":"9999"}' "$API/api/login")" = 401 ]
ck $? "…with the same 401 status a wrong PIN gets (no name-claimed oracle)"

J -X POST "$API/api/login" -d '{"name":"Alex","pin":"1111"}' | grep -q '"token"'
ck $? "locked: an already-claimed name still logs in"

# H1.a: an admin PIN reset re-opens first-claim for THAT NAME ONLY under lock.
echo "==> H1.a: reset-under-lock"
J -X POST "$API/api/admin/reset-pin" -H "X-Admin-Key: $ADMIN_KEY" -d '{"name":"Jordan"}' | grep -q '"ok":true'
ck $? "admin reset-pin for Jordan (never claimed) while locked"
J -X POST "$API/api/login" -d '{"name":"Jordan","pin":"9999"}' | grep -q '"firstTime":true'
ck $? "locked: Jordan can now claim a PIN (firstTime:true)"
J -X POST "$API/api/login" -d '{"name":"Jordan","pin":"9999"}' | grep -q '"firstTime":false'
ck $? "…and signs in again with it"
J -X POST "$API/api/login" -d '{"name":"Riley","pin":"4444"}' | grep -q '"error":"Incorrect PIN"'
ck $? "…while a different unclaimed name (Riley) stays locked out"
J -X POST "$API/api/admin/reset-pin" -H "X-Admin-Key: $ADMIN_KEY" -d '{"name":"Alex"}' | grep -q '"ok":true'
ck $? "admin reset-pin for Alex (claimed) while locked"
J -X POST "$API/api/login" -d '{"name":"Alex","pin":"1212"}' | grep -q '"firstTime":true'
ck $? "locked: Alex sets a new PIN (firstTime:true)"
J -X POST "$API/api/login" -d '{"name":"Alex","pin":"1111"}' | grep -q '"error":"Incorrect PIN"'
ck $? "…the old PIN is dead and the re-claim was consumed (a wrong PIN is refused, not treated as a claim)"

curl -s -X POST "$API/api/admin/roster-lock" -H 'Content-Type: application/json' \
  -H "X-Admin-Key: $ADMIN_KEY" -d '{"locked":false}' | grep -q '"locked":false'
ck $? "roster lock turned back off"
J -X POST "$API/api/login" -d '{"name":"Riley","pin":"4444"}' | grep -q '"firstTime":true'
ck $? "unlocked: first-claim works again"

# ── M1: peppered PIN hashes migrate on login ───────────────────────────────
echo "==> M1: PIN pepper migrate-on-login"
kill "$PID_A" 2>/dev/null; sleep 1; PID_A=""
# Jordan's row does not exist (the lock refused the claim), so seed one holding
# the LEGACY bare-sha256 hash — the state every existing deployment is in.
node -e '
  const crypto = require("crypto");
  const Database = require(process.argv[1]);
  const db = new Database(process.argv[2]);
  const legacy = crypto.createHash("sha256").update("7777").digest("hex");
  db.prepare("INSERT OR REPLACE INTO users (name, pin_hash, token) VALUES (?, ?, ?)")
    .run("Jordan", legacy, "seed-token-jordan");
  db.close();
' "$BSQ" "$A/data.db"
ck $? "seeded Jordan with a legacy bare-sha256 PIN hash"

cd "$A"; PORT=$PORT_A ADMIN_KEY="$ADMIN_KEY" PIN_PEPPER="$PEPPER" node server.js > server2.log 2>&1 &
PID_A=$!
cd "$TMP"
up $PORT_A; ck $? "instance restarted with PIN_PEPPER set"

J -X POST "$API/api/login" -d '{"name":"Jordan","pin":"7777"}' | grep -q '"token"'
ck $? "pepper on: a legacy-hash user still logs in with their old PIN"

node -e '
  const crypto = require("crypto");
  const Database = require(process.argv[1]);
  const db = new Database(process.argv[2], { readonly: true });
  const row = db.prepare("SELECT pin_hash FROM users WHERE name = ?").get("Jordan");
  db.close();
  const legacy   = crypto.createHash("sha256").update("7777").digest("hex");
  const peppered = crypto.createHmac("sha256", process.argv[3]).update("7777").digest("hex");
  if (row.pin_hash === legacy)   { console.error("still stored as the legacy hash"); process.exit(1); }
  if (row.pin_hash !== peppered) { console.error("not rewritten to the peppered form"); process.exit(1); }
' "$BSQ" "$A/data.db" "$PEPPER"
ck $? "…and the stored hash was rewritten to the peppered form in that request"

J -X POST "$API/api/login" -d '{"name":"Jordan","pin":"7777"}' | grep -q '"token"'
ck $? "the migrated user logs in again against the peppered hash"
J -X POST "$API/api/login" -d '{"name":"Jordan","pin":"0000"}' | grep -q '"error":"Incorrect PIN"'
ck $? "a wrong PIN is still refused after migration"

echo "==> R9: packing — each person checks their own; shared items keep one check (v0.25.0)"
pk_new() { auth "$TOK_CASEY" -X POST "$API/api/packing" -d "$1" | sed -n 's/.*"id":\([0-9]*\).*/\1/p'; }
pk_row() { # pk_row <token> <id> → "done|doneBy joined with +|perPerson" as that reader sees it
  curl -s -H "X-Auth-Token: $1" "$API/api/packing" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(p=>String(p.id)===process.argv[1]);console.log(r?[r.done,(r.doneBy||[]).join("+"),r.perPerson].join("|"):"missing")})' "$2"
}
pk_tog() { auth "$1" -X POST "$API/api/packing/$2/toggle" ${3:+-d "$3"} >/dev/null; }
PP="$(pk_new '{"item":"Passports","who":""}')"
pk_tog "$TOK_SAM" "$PP" '{"done":1}'
[ -n "$PP" ] && [ "$(pk_row "$TOK_SAM" "$PP")" = "1|Sam|true" ]; ck $? "Sam ticks Passports (a per-person item): his box is checked, packed by Sam"
[ "$(pk_row "$TOK_CASEY" "$PP")" = "0|Sam|true" ]; ck $? "…Casey's own box stays unchecked, and she can see Sam packed it"
pk_tog "$TOK_CASEY" "$PP" '{"done":1}'; pk_tog "$TOK_SAM" "$PP" '{"done":1}'
[ "$(pk_row "$TOK_CASEY" "$PP")" = "1|Casey+Sam|true" ]; ck $? "…two people ticking the same item no longer undo each other"
pk_tog "$TOK_SAM" "$PP" '{"done":0}'
[ "$(pk_row "$TOK_CASEY" "$PP")" = "1|Casey|true" ] && [ "$(pk_row "$TOK_SAM" "$PP")" = "0|Casey|true" ]; ck $? "…Sam unticking takes away only his own check"
pk_tog "$TOK_MORGAN" "$PP"
[ "$(pk_row "$TOK_MORGAN" "$PP")" = "1|Casey+Morgan|true" ]; ck $? "…an older client's no-body toggle flips only the caller's own check"
node -e 'const D=require(process.argv[1]);const db=new D(process.argv[2]);db.prepare("INSERT OR IGNORE INTO packing_checks (item_id, name) VALUES (?, ?)").run(+process.argv[3],"Kasey");db.close()' "$BSQ" "$A/data.db" "$PP"
[ "$(pk_row "$TOK_CASEY" "$PP")" = "1|Casey+Morgan|true" ]; ck $? "…a check left by a name no longer on the roster (renamed / removed) is not listed in Packed: (v0.25.1)"
SH="$(pk_new '{"item":"Sunscreen","who":"Everyone"}')"
pk_tog "$TOK_SAM" "$SH" '{"done":1}'
[ "$(pk_row "$TOK_CASEY" "$SH")" = "1||false" ]; ck $? "a shared item (Everyone) keeps ONE check: Sam ticks it, Casey sees it packed"
ME="$(pk_new '{"item":"Sam hat","who":"Sam"}')"
pk_tog "$TOK_CASEY" "$ME" '{"done":1}'
[ "$(pk_row "$TOK_SAM" "$ME")" = "1||false" ]; ck $? "an item for one traveler keeps one check too (Casey packs Sam's hat, Sam sees it)"
DB="$(pk_new '{"item":"Day snacks","who":"Day Bag"}')"
pk_tog "$TOK_SAM" "$DB" '{"done":1}'
[ "$(pk_row "$TOK_CASEY" "$DB")" = "0|Sam|true" ]; ck $? "a Day Bag item is per person too (each carries one)"
OW="$(pk_new '{"item":"Old roster item","who":"Kasey"}')"
pk_tog "$TOK_SAM" "$OW" '{"done":1}'
[ "$(pk_row "$TOK_CASEY" "$OW")" = "1||false" ]; ck $? "an item owned by a name not (or no longer) on the roster stays ONE shared check — the rule reads the owner, not the roster"
curl -s -H "X-Admin-Key: $ADMIN_KEY" "$API/api/admin/overview" | grep -q '"packing_checks":[0-9]'
ck $? "the admin overview counts packing_checks rows"
auth "$TOK_CASEY" -X DELETE "$API/api/packing/$PP" >/dev/null
LEFT="$(node -e 'const D=require(process.argv[1]);const db=new D(process.argv[2],{readonly:true});console.log(db.prepare("SELECT COUNT(*) c FROM packing_checks WHERE item_id=?").get(+process.argv[3]).c)' "$BSQ" "$A/data.db" "$PP")"
[ "$(pk_row "$TOK_CASEY" "$PP")" = missing ] && [ "$LEFT" = 0 ]; ck $? "deleting an item removes it and everyone's checks ($LEFT left)"

echo "==> R10: old shared checks carry over once, as packed for everyone (v0.25.0)"
kill "$PID_A" 2>/dev/null; sleep 1; PID_A=""
node -e '
  const D = require(process.argv[1]); const db = new D(process.argv[2]);
  const ins = db.prepare("INSERT INTO packing (item, category, who, done) VALUES (?, ?, ?, 1)");
  console.log([ins.run("Legacy socks", "", "").lastInsertRowid, ins.run("Legacy tent", "", "Everyone").lastInsertRowid].join(" "));
  db.prepare("DELETE FROM app_settings WHERE key = ?").run("packing_checks_v1");
  db.close();' "$BSQ" "$A/data.db" > "$TMP/legacy-ids"
read -r LS LT < "$TMP/legacy-ids"
cd "$A"; PORT=$PORT_A ADMIN_KEY="$ADMIN_KEY" PIN_PEPPER="$PEPPER" node server.js > server3.log 2>&1 &
PID_A=$!
cd "$TMP"
up $PORT_A; ck $? "instance restarted with two old-style checked items"
FAMN="$(curl -s -H "X-Auth-Token: $TOK_CASEY" "$API/api/trip" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log((JSON.parse(s).family||[]).length)})')"
R="$(pk_row "$TOK_CASEY" "$LS")"
[ "${R%%|*}" = 1 ] && [ "$(printf '%s' "$R" | cut -d'|' -f2 | tr '+' '\n' | grep -c .)" = "$FAMN" ]
ck $? "an old checked per-person item is packed for every traveler ($R; $FAMN travelers)"
[ "$(pk_row "$TOK_CASEY" "$LT")" = "1||false" ]; ck $? "…an old checked shared item simply stays checked"
kill "$PID_A" 2>/dev/null; sleep 1; PID_A=""
cd "$A"; PORT=$PORT_A ADMIN_KEY="$ADMIN_KEY" PIN_PEPPER="$PEPPER" node server.js > server4.log 2>&1 &
PID_A=$!
cd "$TMP"
up $PORT_A
pk_tog "$TOK_CASEY" "$LS" '{"done":0}'
kill "$PID_A" 2>/dev/null; sleep 1; PID_A=""
cd "$A"; PORT=$PORT_A ADMIN_KEY="$ADMIN_KEY" PIN_PEPPER="$PEPPER" node server.js > server5.log 2>&1 &
PID_A=$!
cd "$TMP"
up $PORT_A
[ "$(pk_row "$TOK_CASEY" "$LS" | cut -d'|' -f1)" = 0 ]; ck $? "…the carry-over runs once: Casey's untick survives later restarts"

echo "==> R7: an admin PIN reset also lifts a sign-in lockout (v0.24.0)"
for _ in 1 2 3 4 5; do J -X POST "$API/api/login" -d '{"name":"Riley","pin":"0001"}' >/dev/null; done
[ "$(code -X POST -H 'Content-Type: application/json' -d '{"name":"Riley","pin":"4444"}' "$API/api/login")" = 429 ]
ck $? "five wrong PINs lock Riley out (429, even with the right PIN)"
J -X POST "$API/api/admin/reset-pin" -H "X-Admin-Key: $ADMIN_KEY" -d '{"name":"Riley"}' | grep -q '"lockoutCleared":true'
ck $? "admin reset-pin for Riley reports the lockout cleared"
J -X POST "$API/api/login" -d '{"name":"Riley","pin":"4321"}' | grep -q '"token"'
ck $? "…and Riley can sign in (set a fresh PIN) straight away"

echo "==> R8: gated reads during the admin-key lockout answer 429, not 401 (v0.24.0)"
for _ in 1 2 3 4 5; do code -H "X-Admin-Key: wrong-key" "$API/api/notes" >/dev/null; done
C="$(code -H "X-Admin-Key: $ADMIN_KEY" "$API/api/notes")"
[ "$C" = 429 ]; ck $? "after five wrong keys even the right key gets 429 on a read ($C)"
C="$(code -H "X-Auth-Token: $TOK_CASEY" "$API/api/notes")"
[ "$C" = 200 ]; ck $? "…while a signed-in traveler still reads normally ($C)"

[ ! -s "$RD_BAD" ]; ck $? "every signed-in read-back in this run returned 200$( [ -s "$RD_BAD" ] && printf ' — not: %s' "$(tr '\n' ';' < "$RD_BAD")")"

echo
echo "== api-rehearsal summary =="
printf '%s\n' "${ROWS[@]}"
echo "---------------------------"
echo "RESULT: $PASS PASS, $FAIL FAIL"
exit $FAIL
