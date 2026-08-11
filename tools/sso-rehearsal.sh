#!/usr/bin/env bash
# tools/sso-rehearsal.sh — LOCAL rehearsal of family SSO (portal → trip instance).
# Same conventions as tools/hub-rehearsal.sh: a pass/fail row per assertion,
# non-zero exit on any failure, trap cleanup, Git-Bash-safe.
#
# WHY THIS EXISTS
# Family SSO was verified once, by hand, while it was being built. The whole
# family now signs in through it. This is the repeatable version: it boots a
# real portal and two real trip instances on loopback and proves the contract
# end to end, including the four ways it is supposed to say NO.
#
# HOW TO RUN
#   tools/sso-rehearsal.sh          # from anywhere inside the repo
# Exit 0 = every assertion passed. Everything is localhost; no network, no
# server, no deploy. Scratch lives in a temp dir and is removed on exit — the
# trip servers are stamped into that scratch dir and NEVER run from the repo
# root, because a trip server writes data.db next to its own server.js and
# would drop one into the working tree.
#
# It stamps the WORKING TREE (tracked files), not HEAD, so an uncommitted edit
# to server.js is what actually gets exercised. See the note at the stamp step.
#
# WHAT IT PROVES
#   yes-path : portal first-claim login sets fam_sso with the expected
#              attributes; the instance turns that cookie into a session token;
#              the token authenticates against /api/me; and the SSO path creates
#              NO users row (user_tokens is the sole authority for a token —
#              the PIN stays at the portal and the instance never sees one).
#   no-path  : a tampered cookie, an expired cookie, a cookie naming someone
#              this trip does not list, and no cookie at all are each 401.
#   off-path : an instance with FAMILY_SSO_SECRET unset answers /api/sso with
#              404 (SSO is invisible, not merely disabled) while /api/login
#              still works — the "instance that never joined the portal" case.
#
# NODE_MODULES: the scratch instances borrow this repo's node_modules by
# junction (Windows) / symlink (elsewhere), exactly as hub-rehearsal.sh and
# multi-rehearsal.sh do. A real `npm install` in scratch is avoided on purpose:
# better-sqlite3's install script is commonly blocked by npm's allowScripts
# policy, and the already-built better_sqlite3.node in this repo is the same
# binary a scratch install would produce. The links are unlinked explicitly
# before the scratch dir is deleted, so the repo's node_modules is never
# reached through them.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BSQ="$ROOT/node_modules/better-sqlite3"
PORT_A=3901   # trip instance, FAMILY_SSO_SECRET set
PORT_B=3902   # trip instance, FAMILY_SSO_SECRET unset
PORT_P=3910   # the family portal
SECRET="sso-rehearsal-secret-do-not-use-in-production"
# Morgan is in the PORTAL's family but not in the trip's family[] — the
# "valid portal session, wrong trip" case. The rest are the sample travelers.
PORTAL_NAMES="Alex,Sam,Jordan,Riley,Casey,Morgan"
PASS=0; FAIL=0
declare -a ROWS
ck() {  # ck <0|nonzero> <label>
  if [ "$1" = 0 ]; then PASS=$((PASS+1)); ROWS+=("PASS  $2"); else FAIL=$((FAIL+1)); ROWS+=("FAIL  $2"); fi
}
J() { curl -s -H 'Content-Type: application/json' "$@"; }

[ -d "$BSQ" ] || { echo "FATAL: $BSQ missing — run npm install first." >&2; exit 1; }
for p in $PORT_A $PORT_B $PORT_P; do
  if netstat -ano 2>/dev/null | grep ":$p " | grep -q LISTENING; then
    echo "FATAL: port $p is already in use — aborting before any setup." >&2; exit 1
  fi
done

TMP="$(mktemp -d)"
A="$TMP/trip-a"; B="$TMP/trip-b"; P="$TMP/portal"
PID_A=""; PID_B=""; PID_P=""
cleanup() {
  for pid in "$PID_A" "$PID_B" "$PID_P"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 1
  # Unlink the borrowed node_modules BEFORE the recursive delete, so nothing
  # can ever walk through the link into the repo's own node_modules.
  for d in "$A" "$B" "$P"; do
    [ -e "$d/node_modules" ] || continue
    case "$(uname -s)" in
      MINGW*|MSYS*) cmd //c rmdir "$(cygpath -w "$d/node_modules")" >/dev/null 2>&1 ;;
      *) rm -f "$d/node_modules" ;;
    esac
  done
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

echo "==> stamping two trip instances and the portal into scratch"
# WORKING TREE, not HEAD. hub-rehearsal.sh and multi-rehearsal.sh stamp from
# `git archive HEAD` because they rehearse what a DEPLOY would ship. A test
# harness wants the opposite: an uncommitted edit to server.js must be the
# thing under test, or the run comes back green about code that isn't yours.
# `git ls-files` still gives the tracked-file list, so data.db, .env and
# node_modules are excluded exactly as git archive excluded them.
stamp() { # stamp <dest> [pathspec]
  (cd "$ROOT" && git ls-files -z ${2:+"$2"} | tar --null -T - -cf -) | tar -x -C "$1"
}
mkdir -p "$A" "$B" "$P" "$TMP/stage"
stamp "$A"; stamp "$B"; stamp "$TMP/stage" family-hub
cp -r "$TMP/stage/family-hub/." "$P/"
[ -f "$A/server.js" ] && [ -f "$A/public/index.html" ] && [ -f "$A/package.json" ] \
  && [ -f "$P/server.js" ] && [ -f "$P/lib/sso.js" ]
ck $? "trip instances + portal stamped from the WORKING TREE into scratch"
link_modules "$A"; link_modules "$B"; link_modules "$P"
ck $? "node_modules borrowed from the repo (prebuilt better_sqlite3.node)"

# ── boot ────────────────────────────────────────────────────────────────────
echo "==> booting portal :$PORT_P, instance A :$PORT_A (SSO on), instance B :$PORT_B (SSO off)"
# COOKIE_DOMAIN is deliberately UNSET: a host-only cookie, which is what
# localhost needs and what the code documents as the dev default.
cd "$P"; PORT=$PORT_P FAMILY_SSO_SECRET="$SECRET" FAMILY_NAMES="$PORTAL_NAMES" \
  TRIPS_DIR="$TMP/no-such-trips-dir" node server.js > server.log 2>&1 &
PID_P=$!
cd "$A"; PORT=$PORT_A FAMILY_SSO_SECRET="$SECRET" node server.js > server.log 2>&1 &
PID_A=$!
cd "$B"; PORT=$PORT_B node server.js > server.log 2>&1 &
PID_B=$!
cd "$TMP"

up() { for _ in $(seq 1 40); do curl -s "localhost:$1/api/health" | grep -q '"status":"ok"' && return 0; sleep 0.5; done; return 1; }
up $PORT_P; ck $? "portal healthy on :$PORT_P"
up $PORT_A; ck $? "instance A healthy on :$PORT_A"
up $PORT_B; ck $? "instance B healthy on :$PORT_B"
curl -s "localhost:$PORT_P/api/health" | grep -q '"sso":true'
ck $? "portal reports sso:on (the secret reached it)"

# ── helper: sign a cookie with the portal's own lib (for the expiry case) ────
cat > "$TMP/sign.js" <<'SIGN'
'use strict';
// argv: <path to family-hub/lib/sso.js> <secret> <name> <ttlMs>
const sso = require(process.argv[2]);
process.stdout.write(sso.sign(process.argv[3], process.argv[4], Date.now(), parseInt(process.argv[5], 10)));
SIGN

# ── helper: read row counts out of an instance's data.db, read-only ──────────
cat > "$TMP/count.js" <<'COUNT'
'use strict';
// argv: <better-sqlite3 path> <data.db> <table> [nameFilter] — prints the count
const Database = require(process.argv[2]);
const db = new Database(process.argv[3], { readonly: true, fileMustExist: true });
const t = process.argv[4], who = process.argv[5];
const sql = 'SELECT COUNT(*) AS c FROM ' + t + (who ? ' WHERE name = ?' : '');
process.stdout.write(String((who ? db.prepare(sql).get(who) : db.prepare(sql).get()).c));
db.close();
COUNT
count() { node "$TMP/count.js" "$BSQ" "$A/data.db" "$@"; }

# ── the yes-path ────────────────────────────────────────────────────────────
echo "==> portal first-claim login"
J -i -X POST "localhost:$PORT_P/api/portal/login" -d '{"name":"Alex","pin":"4821"}' > "$TMP/login.txt"
grep -q '"firstTime":true' "$TMP/login.txt"
ck $? "portal: first claim sets the PIN and returns firstTime:true"

SC="$(grep -i '^set-cookie:' "$TMP/login.txt" | tr -d '\r')"
printf '%s' "$SC" | grep -q 'fam_sso='
ck $? "portal: response carries a fam_sso cookie"
printf '%s' "$SC" | grep -q 'Path=/'                 ; ck $? "cookie attribute: Path=/"
printf '%s' "$SC" | grep -q 'Max-Age=7776000'        ; ck $? "cookie attribute: Max-Age=7776000 (90 days)"
printf '%s' "$SC" | grep -q 'HttpOnly'               ; ck $? "cookie attribute: HttpOnly"
printf '%s' "$SC" | grep -q 'SameSite=Lax'           ; ck $? "cookie attribute: SameSite=Lax"
printf '%s' "$SC" | grep -q 'Domain='
[ $? -ne 0 ]; ck $? "cookie attribute: no Domain (host-only, COOKIE_DOMAIN unset)"
printf '%s' "$SC" | grep -q 'Secure'
[ $? -ne 0 ]; ck $? "cookie attribute: no Secure over plain http (nginx sets X-Forwarded-Proto in prod)"

COOKIE="$(printf '%s' "$SC" | sed 's/.*fam_sso=\([^;]*\).*/\1/')"
[ -n "$COOKIE" ]; ck $? "cookie value extracted"
curl -s -H "Cookie: fam_sso=$COOKIE" "localhost:$PORT_P/api/portal/me" | grep -q '"name":"Alex"'
ck $? "portal: /api/portal/me resolves the cookie back to Alex"

echo "==> the cookie becomes a session on the trip instance"
U0="$(count users)"; T0="$(count user_tokens)"
[ "$U0" = 0 ]; ck $? "instance A: no users row exists before SSO (nobody used a PIN)"

SSO="$(curl -s -H "Cookie: fam_sso=$COOKIE" "localhost:$PORT_A/api/sso")"
printf '%s' "$SSO" | grep -q '"ok":true'   ; ck $? "GET /api/sso with the cookie: ok:true"
printf '%s' "$SSO" | grep -q '"name":"Alex"'; ck $? "GET /api/sso: names the traveler"
TOK="$(printf '%s' "$SSO" | sed 's/.*"token":"\([a-f0-9]*\)".*/\1/')"
[ -n "$TOK" ] && [ "$TOK" != "$SSO" ]; ck $? "GET /api/sso: issued a session token"

curl -s -H "X-Auth-Token: $TOK" "localhost:$PORT_A/api/me" | grep -q '"name":"Alex"'
ck $? "the SSO token authenticates against /api/me as Alex"
PROBE='{"author":"Alex","message":"sso-rehearsal probe"}'
J -X POST "localhost:$PORT_A/api/notes" -H "X-Auth-Token: $TOK" -d "$PROBE" | grep -q '"ok":true'
ck $? "…and passes the write auth middleware on a real POST"
# The same POST without it must fail, or the assertion above proves nothing.
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "localhost:$PORT_A/api/notes" \
  -H 'Content-Type: application/json' -d "$PROBE")" = 401 ]
ck $? "…while the identical POST without the token is 401 (the gate is real)"

U1="$(count users)"; T1="$(count user_tokens)"
[ "$U1" = "$U0" ]; ck $? "instance A: SSO created NO users row (still $U1) — the PIN stays at the portal"
[ "$T1" = "$((T0 + 1))" ]; ck $? "instance A: exactly one user_tokens row was added"
[ "$(count user_tokens Alex)" = 1 ]; ck $? "…and it belongs to Alex"

# ── the no-paths ────────────────────────────────────────────────────────────
echo "==> the four ways it must say no"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ "$(code "localhost:$PORT_A/api/sso")" = 401 ]
ck $? "no cookie at all → 401"

# Flip the last character of the signature: same length (timingSafeEqual would
# throw on a length mismatch, so the length guard is a separate code path).
LAST="${COOKIE: -1}"; SWAP=$([ "$LAST" = "A" ] && echo "B" || echo "A")
BAD="${COOKIE%?}$SWAP"
[ "$BAD" != "$COOKIE" ]; ck $? "tampered cookie built (signature altered, length preserved)"
[ "$(code -H "Cookie: fam_sso=$BAD" "localhost:$PORT_A/api/sso")" = 401 ]
ck $? "tampered cookie → 401"

EXPIRED="$(node "$TMP/sign.js" "$P/lib/sso.js" "$SECRET" "Alex" -60000)"
[ -n "$EXPIRED" ]; ck $? "expired cookie minted with the portal's own signer (exp 60s in the past)"
[ "$(code -H "Cookie: fam_sso=$EXPIRED" "localhost:$PORT_A/api/sso")" = 401 ]
ck $? "expired cookie → 401 (correctly signed, but past exp)"

# Morgan really logs in at the portal — a genuine, valid, correctly signed
# cookie. The instance must still refuse: Morgan is not on this trip.
J -i -X POST "localhost:$PORT_P/api/portal/login" -d '{"name":"Morgan","pin":"1357"}' > "$TMP/morgan.txt"
grep -q '"ok":true' "$TMP/morgan.txt"; ck $? "portal: Morgan (portal family, not this trip) signs in fine"
MC="$(grep -i '^set-cookie:' "$TMP/morgan.txt" | tr -d '\r' | sed 's/.*fam_sso=\([^;]*\).*/\1/')"
curl -s -H "Cookie: fam_sso=$MC" "localhost:$PORT_P/api/portal/me" | grep -q '"name":"Morgan"'
ck $? "…and that cookie is genuinely valid at the portal"
[ "$(code -H "Cookie: fam_sso=$MC" "localhost:$PORT_A/api/sso")" = 401 ]
ck $? "valid cookie, name not in the trip's family[] → 401 (not on this trip)"
[ "$(count users)" = "$U0" ] && [ "$(count user_tokens)" = "$T1" ]
ck $? "…and none of the four rejections wrote a row"

# ── the off-path ────────────────────────────────────────────────────────────
echo "==> instance B: FAMILY_SSO_SECRET unset"
[ "$(code -H "Cookie: fam_sso=$COOKIE" "localhost:$PORT_B/api/sso")" = 404 ]
ck $? "SSO off: /api/sso is 404 — invisible, not merely disabled"
J -X POST "localhost:$PORT_B/api/login" -d '{"name":"Alex","pin":"4821"}' | grep -q '"token":'
ck $? "SSO off: /api/login still issues a token (PIN sign-in unaffected)"
curl -s "localhost:$PORT_B/api/health" | grep -q '"status":"ok"'
ck $? "SSO off: the instance is otherwise the app it always was"

echo
echo "== sso-rehearsal summary =="
printf '%s\n' "${ROWS[@]}"
echo "---------------------------"
echo "RESULT: $PASS PASS, $FAIL FAIL"
exit $FAIL
