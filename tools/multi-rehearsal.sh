#!/usr/bin/env bash
# tools/multi-rehearsal.sh — LOCAL rehearsal of the multi-instance model.
# Proves two instances stamped from the same code are fully isolated: a write to
# instance A must change A's data.db and leave B's byte-identical.
#
# Why per-directory isolation works: server.js opens its database with
# path.join(__dirname, 'data.db') — the DB always lives NEXT TO server.js,
# regardless of cwd. Two code directories therefore mean two databases, which is
# exactly the multi-instance layout (/var/www/trips/<name>/).
#
# Git-Bash-safe. node_modules is provisioned per instance dir by junction
# (Windows) / symlink (elsewhere) to this repo's node_modules — same trick as
# the overnight sweep harness; pass NPM_CI=1 to force a real `npm ci` per dir
# instead (slower, but proves a from-scratch install).
#
# Usage: tools/multi-rehearsal.sh   (from anywhere inside the repo)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_A=3101
PORT_B=3102
PASS=0; FAIL=0
declare -a ROWS
ck() {  # ck <0|nonzero> <label>
  if [ "$1" = 0 ]; then PASS=$((PASS+1)); ROWS+=("PASS  $2"); else FAIL=$((FAIL+1)); ROWS+=("FAIL  $2"); fi
}
J() { curl -s -H 'Content-Type: application/json' "$@"; }
hash_of() { sha256sum "$1" | cut -d' ' -f1; }

for p in $PORT_A $PORT_B; do
  if netstat -ano 2>/dev/null | grep ":$p " | grep -q LISTENING; then
    echo "FATAL: port $p is already in use — aborting before any setup." >&2; exit 1
  fi
done

TMP_A="$(mktemp -d)"; TMP_B="$(mktemp -d)"
PID_A=""; PID_B=""
cleanup() {
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null
  sleep 1
  rm -rf "$TMP_A" "$TMP_B"
}
trap cleanup EXIT

echo "==> stamping two instance dirs from HEAD"
(cd "$ROOT" && git archive HEAD | tar -x -C "$TMP_A")
ck $? "instance A stamped from git archive HEAD"
(cd "$ROOT" && git archive HEAD | tar -x -C "$TMP_B")
ck $? "instance B stamped from git archive HEAD"

provision() { # provision <dir>
  if [ "${NPM_CI:-0}" = 1 ]; then
    (cd "$1" && npm ci --omit=dev --silent)
  elif [ -d "$ROOT/node_modules" ]; then
    case "$(uname -s)" in
      MINGW*|MSYS*)
        powershell -NoProfile -Command \
          "New-Item -ItemType Junction -Path '$(cygpath -w "$1/node_modules")' -Target '$(cygpath -w "$ROOT/node_modules")' | Out-Null" ;;
      *) ln -s "$ROOT/node_modules" "$1/node_modules" ;;
    esac
  else
    (cd "$1" && npm ci --omit=dev --silent)
  fi
}
provision "$TMP_A"; ck $? "instance A node_modules provisioned"
provision "$TMP_B"; ck $? "instance B node_modules provisioned"

echo "==> booting A on :$PORT_A and B on :$PORT_B"
cd "$TMP_A"
PORT=$PORT_A node server.js > server.log 2>&1 &
PID_A=$!
cd "$TMP_B"
PORT=$PORT_B node server.js > server.log 2>&1 &
PID_B=$!
cd "$ROOT"

up() { # up <port>
  for _ in $(seq 1 30); do
    curl -s "localhost:$1/api/health" | grep -q '"status":"ok"' && return 0
    sleep 0.5
  done
  return 1
}
up $PORT_A; ck $? "A healthy on :$PORT_A"
up $PORT_B; ck $? "B healthy on :$PORT_B"

# hash AFTER boot (boot itself seeds trip_config) and BEFORE the test write
H_A0="$(hash_of "$TMP_A/data.db")"
H_B0="$(hash_of "$TMP_B/data.db")"
[ -n "$H_A0" ] && [ -n "$H_B0" ]; ck $? "pre-test db hashes captured"

echo "==> one authenticated mutating write against A only"
# Simplest authed write in the API: login (open route, issues the token), then
# POST /api/notes carrying X-Auth-Token — the auth middleware gates every
# non-GET except /api/login and /api/health.
R="$(J -X POST "localhost:$PORT_A/api/login" -d '{"name":"Alex","pin":"1234"}')"
TOK="$(printf '%s' "$R" | sed 's/.*"token":"\([a-f0-9]*\)".*/\1/')"
[ -n "$TOK" ]; ck $? "A: login issued a token"
J -X POST "localhost:$PORT_A/api/notes" -H "X-Auth-Token: $TOK" \
  -d '{"author":"Alex","message":"multi-rehearsal isolation probe"}' | grep -q '"ok":true'
ck $? "A: authenticated note write accepted"
curl -s "localhost:$PORT_A/api/notes" | grep -q 'isolation probe'
ck $? "A: note visible on read-back"

H_A1="$(hash_of "$TMP_A/data.db")"
H_B1="$(hash_of "$TMP_B/data.db")"
[ "$H_A0" != "$H_A1" ]; ck $? "A: data.db hash CHANGED after the write"
[ "$H_B0" = "$H_B1" ]; ck $? "B: data.db byte-identical to pre-test (isolation)"
curl -s "localhost:$PORT_B/api/notes" | grep -q 'isolation probe'
[ $? -ne 0 ]; ck $? "B: the note does not appear via B's API"

echo
echo "== multi-rehearsal summary =="
printf '%s\n' "${ROWS[@]}"
echo "-----------------------------"
echo "RESULT: $PASS PASS, $FAIL FAIL"
exit $FAIL
