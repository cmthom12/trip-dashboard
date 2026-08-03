#!/usr/bin/env bash
# tools/hub-rehearsal.sh — LOCAL rehearsal of the admin-hub against two real
# instances. Companion to tools/multi-rehearsal.sh (same stamping/junction
# pattern — that script is untouched; this one adds the hub on top).
#
# Boots instance A (:3101) + instance B (:3102) from git archive HEAD under a
# temp TRIPS_ROOT, each with a .env carrying PORT + CORS_ORIGIN (what the hub
# discovers) and the admin key in the process env (what the instances gate on).
# The hub (:3110) is stamped OUTSIDE the trips root — mirroring the layout
# hazard — and pointed at it via TRIPS_ROOT. Then asserts the board's behavior
# including a dead instance and a wrong key. Git-Bash-safe; trap cleanup.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_A=3101; PORT_B=3102; PORT_HUB=3110
KEY="hub-rehearsal-key-123"
ORIGIN_A="https://trip-a.trips.example.com"
ORIGIN_B="https://trip-b.trips.example.com"
PASS=0; FAIL=0
declare -a ROWS
ck() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); ROWS+=("PASS  $2"); else FAIL=$((FAIL+1)); ROWS+=("FAIL  $2"); fi; }

for p in $PORT_A $PORT_B $PORT_HUB; do
  if netstat -ano 2>/dev/null | grep ":$p " | grep -q LISTENING; then
    echo "FATAL: port $p busy — aborting before setup." >&2; exit 1
  fi
done

TMP="$(mktemp -d)"
TRIPS="$TMP/trips"
HUB="$TMP/hub"       # deliberately NOT under $TRIPS — the hazard the code documents
PID_A=""; PID_B=""; PID_H=""
cleanup() {
  for pid in "$PID_A" "$PID_B" "$PID_H"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 1
  rm -rf "$TMP"
}
trap cleanup EXIT

junction() { # junction <dir>
  case "$(uname -s)" in
    MINGW*|MSYS*) powershell -NoProfile -Command \
      "New-Item -ItemType Junction -Path '$(cygpath -w "$1/node_modules")' -Target '$(cygpath -w "$ROOT/node_modules")' | Out-Null" ;;
    *) ln -s "$ROOT/node_modules" "$1/node_modules" ;;
  esac
}

echo "==> stamping instances A/B under TRIPS_ROOT and the hub outside it"
mkdir -p "$TRIPS/trip-a" "$TRIPS/trip-b"
(cd "$ROOT" && git archive HEAD | tar -x -C "$TRIPS/trip-a")
(cd "$ROOT" && git archive HEAD | tar -x -C "$TRIPS/trip-b")
mkdir -p "$HUB" "$TMP/hub-stage"
(cd "$ROOT" && git archive HEAD admin-hub | tar -x -C "$TMP/hub-stage")
cp -r "$TMP/hub-stage/admin-hub/." "$HUB/"
junction "$TRIPS/trip-a"; junction "$TRIPS/trip-b"; junction "$HUB"
ck $? "three dirs stamped + node_modules provisioned"

printf 'PORT=%s\nCORS_ORIGIN=%s\nADMIN_KEY=%s\n' "$PORT_A" "$ORIGIN_A" "$KEY" > "$TRIPS/trip-a/.env"
printf 'PORT=%s\nCORS_ORIGIN=%s\nADMIN_KEY=%s\n' "$PORT_B" "$ORIGIN_B" "$KEY" > "$TRIPS/trip-b/.env"

echo "==> booting A, B, hub"
cd "$TRIPS/trip-a"; PORT=$PORT_A ADMIN_KEY=$KEY node server.js > server.log 2>&1 &
PID_A=$!
cd "$TRIPS/trip-b"; PORT=$PORT_B ADMIN_KEY=$KEY node server.js > server.log 2>&1 &
PID_B=$!
cd "$HUB"; PORT=$PORT_HUB TRIPS_ROOT=$TRIPS node server.js > server.log 2>&1 &
PID_H=$!
cd "$ROOT"
up() { for _ in $(seq 1 30); do curl -s "localhost:$1/api/health" | grep -q '"status":"ok"' && return 0; sleep 0.5; done; return 1; }
up $PORT_A; ck $? "instance A healthy on :$PORT_A"
up $PORT_B; ck $? "instance B healthy on :$PORT_B"
up $PORT_HUB; ck $? "hub healthy on :$PORT_HUB"

INST="$(curl -s "localhost:$PORT_HUB/api/instances")"
echo "$INST" | node -e "
const a=JSON.parse(require('fs').readFileSync(0,'utf8'));
const ok = a.length===2 && a[0].name==='trip-a' && a[1].name==='trip-b'
  && a.every(i=>i.health.ok && i.health.version);
process.exit(ok?0:1);"
ck $? "/api/instances: both listed with passing health"
echo "$INST" | node -e "
const a=JSON.parse(require('fs').readFileSync(0,'utf8'));
process.exit(a[0].origin==='$ORIGIN_A' && a[1].origin==='$ORIGIN_B' ? 0 : 1);"
ck $? "origins (UI hrefs) equal each temp .env's CORS_ORIGIN"

curl -s -H "X-Admin-Key: $KEY" "localhost:$PORT_HUB/api/overview" | node -e "
const a=JSON.parse(require('fs').readFileSync(0,'utf8'));
const ok = a.length===2 && a.every(o=>o.ok && o.status===200
  && o.data && o.data.trip && o.data.trip.title && Array.isArray(o.data.travelers) && o.data.db);
process.exit(ok?0:1);"
ck $? "/api/overview correct key: 2x ok:true with real overview data"

curl -s -H "X-Admin-Key: wrong-key" "localhost:$PORT_HUB/api/overview" | node -e "
const a=JSON.parse(require('fs').readFileSync(0,'utf8'));
process.exit(a.length===2 && a.every(o=>!o.ok && o.status===401) ? 0 : 1);"
ck $? "wrong key: both pass through as status 401, ok:false"

echo "==> killing instance B — the board must survive"
kill $PID_B 2>/dev/null; PID_B=""; sleep 1
T0=$(date +%s)
OV="$(curl -s --max-time 10 -H "X-Admin-Key: $KEY" "localhost:$PORT_HUB/api/overview")"
T1=$(date +%s)
echo "$OV" | node -e "
const a=JSON.parse(require('fs').readFileSync(0,'utf8'));
const A=a.find(o=>o.name==='trip-a'), B=a.find(o=>o.name==='trip-b');
process.exit(A && A.ok && B && !B.ok && B.error==='unreachable' ? 0 : 1);"
ck $? "dead instance B: board returns, B 'unreachable', A still ok"
[ $((T1 - T0)) -le 6 ]; ck $? "board answered within the fan-out timeout (${T0}s->${T1}s)"

echo ""
echo "== hub-rehearsal summary =="
printf '%s\n' "${ROWS[@]}"
echo "---------------------------"
echo "RESULT: $PASS PASS, $FAIL FAIL"
exit $FAIL
