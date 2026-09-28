#!/usr/bin/env bash
# tools/sync-rehearsal.sh — local checks for deploy/sync-admin-key.sh.
#
# Builds a throwaway TRIPS_ROOT with fake instances and puts a fake `pm2` and
# `curl` first on PATH (they only log what they were asked), then runs the
# real script and checks:
#   - the default source is the first instance with a NON-EMPTY ADMIN_KEY
#     (a brand-new instance with an empty key, sorted first, is skipped);
#   - every .env ends with the same key, chmod 600, and the key never appears
#     in the script's output or on curl's command line;
#   - each instance is reloaded BY FILE (cd <dir> && pm2 reload
#     ecosystem.config.js), also with a relative TRIPS_ROOT;
#   - an instance without an ecosystem.config.js is reported as a problem
#     (exit 1) and not reloaded — a reload can't deliver the key to it;
#   - a probe that finds the process not listening yet is retried;
#   - naming a source with an empty key, or having no key anywhere, refuses
#     with exit 2 and changes nothing.
# Usage: bash tools/sync-rehearsal.sh      Exit 0 = every check passed.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/deploy/sync-admin-key.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ck() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS  $2"; else FAIL=$((FAIL+1)); echo "FAIL  $2"; fi; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/pm2" <<'EOF'
#!/usr/bin/env bash
echo "$(pwd)|$*" >> "$PM2_LOG"
EOF
# fake curl: logs its arguments (never its stdin), answers 000 ("not listening")
# for the first $CURL_DOWN calls, then 200
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null 2>&1
echo "$*" >> "$CURL_LOG"
n=$(grep -c . "$CURL_LOG")
if [ "$n" -le "${CURL_DOWN:-0}" ]; then printf '000'; else printf '200'; fi
EOF
chmod +x "$TMP/bin/pm2" "$TMP/bin/curl"
KEY="k$(printf 'rehearsal' | sha256sum | cut -c1-40)"
FP="$(printf '%s' "$KEY" | sha256sum | cut -c1-12)"

fleet() { # fresh TRIPS_ROOT: aaa-new (empty key, sorted first), beta (no ADMIN_KEY line), gamma (the key)
  rm -rf "$TMP/trips"; mkdir -p "$TMP/trips/aaa-new" "$TMP/trips/beta" "$TMP/trips/gamma"
  printf 'PORT=3990\nADMIN_KEY=\n' > "$TMP/trips/aaa-new/.env"
  printf 'PORT=3991\n' > "$TMP/trips/beta/.env"
  printf 'PORT=3992\nADMIN_KEY=%s\n' "$KEY" > "$TMP/trips/gamma/.env"
  for d in aaa-new beta gamma; do echo 'module.exports = {}' > "$TMP/trips/$d/ecosystem.config.js"; done
  : > "$TMP/pm2.log"; : > "$TMP/curl.log"
}
run() { PATH="$TMP/bin:$PATH" PM2_LOG="$TMP/pm2.log" CURL_LOG="$TMP/curl.log" TRIPS_ROOT="${ROOT_OVERRIDE:-$TMP/trips}" bash "$SCRIPT" "$@" > "$TMP/out" 2>&1; }

echo "==> default source"
fleet; run; RC=$?
[ "$RC" = 0 ]; ck $? "no source named: runs clean (exit $RC)"
grep -q "^source: gamma " "$TMP/out"; ck $? "…and picks gamma, the first instance with a key — not the empty new one sorted first"
ALL=1; for d in aaa-new beta gamma; do [ "$(sed -n 's/^ADMIN_KEY=//p' "$TMP/trips/$d/.env")" = "$KEY" ] || ALL=0; done
[ "$ALL" = 1 ]; ck $? "every .env now carries the same key (beta had no ADMIN_KEY line: appended)"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ck 0 "…each chmod 600 (not checkable here: chmod has no effect on Windows files — checked on Linux)" ;;
  *) PERM="$(stat -c %a "$TMP/trips/aaa-new/.env" "$TMP/trips/beta/.env" "$TMP/trips/gamma/.env" | sort -u)"
     [ "$PERM" = 600 ]; ck $? "…each chmod 600" ;;
esac
! grep -q "$KEY" "$TMP/out" && grep -q "$FP" "$TMP/out"; ck $? "the key never appears in the output; its fingerprint does"
[ -s "$TMP/curl.log" ] && ! grep -q "$KEY" "$TMP/curl.log"; ck $? "…nor on curl's command line (it goes in on stdin)"

echo "==> reloads"
[ "$(sort "$TMP/pm2.log" | tr '\n' ' ')" = "$TMP/trips/aaa-new|reload ecosystem.config.js $TMP/trips/beta|reload ecosystem.config.js $TMP/trips/gamma|reload ecosystem.config.js " ]
ck $? "each instance is reloaded once, BY FILE, from its own dir"
fleet; ( cd "$TMP" && ROOT_OVERRIDE=trips run ); RC=$?
[ "$RC" = 0 ] && [ "$(grep -c '|reload ecosystem.config.js$' "$TMP/pm2.log")" = 3 ]
ck $? "…also with a relative TRIPS_ROOT (exit $RC)"
fleet; rm "$TMP/trips/beta/ecosystem.config.js"; run; RC=$?
[ "$RC" = 1 ] && grep -q "^beta .*NO ecosystem.config.js" "$TMP/out" && ! grep -q "trips/beta|" "$TMP/pm2.log" && [ "$(sed -n 's/^ADMIN_KEY=//p' "$TMP/trips/beta/.env")" = "$KEY" ]
ck $? "an instance without an ecosystem.config.js is reported (exit 1) and not reloaded — its .env still gets the key"

echo "==> probe"
fleet; CURL_DOWN=2 run; RC=$?
[ "$RC" = 0 ] && [ "$(grep -c . "$TMP/curl.log")" = 5 ] && ! grep -q unreachable "$TMP/out"
ck $? "a process not listening yet right after its reload is probed again (2 misses, then ok; exit $RC)"

echo "==> refusals"
fleet; run aaa-new; RC=$?
[ "$RC" = 2 ] && grep -q "empty ADMIN_KEY" "$TMP/out" && [ "$(sed -n 's/^ADMIN_KEY=//p' "$TMP/trips/beta/.env")" = "" ] && [ ! -s "$TMP/pm2.log" ]
ck $? "naming a source with an empty key refuses (exit 2) and touches nothing"
fleet; printf 'PORT=3992\nADMIN_KEY=\n' > "$TMP/trips/gamma/.env"; run; RC=$?
[ "$RC" = 2 ] && grep -q "no instance .* non-empty ADMIN_KEY" "$TMP/out" && [ ! -s "$TMP/pm2.log" ]
ck $? "no key anywhere: refuses (exit 2), no reloads"
fleet; run nosuch; RC=$?
[ "$RC" = 2 ] && [ ! -s "$TMP/pm2.log" ]; ck $? "naming a source that doesn't exist refuses (exit $RC), no reloads"

echo "RESULT: $PASS PASS, $FAIL FAIL"
exit "$FAIL"
