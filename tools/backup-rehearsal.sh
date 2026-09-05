#!/usr/bin/env bash
# tools/backup-rehearsal.sh — LOCAL rehearsal of deploy/backup-all.sh's
# fail-closed contract. Same conventions as the other rehearsals: a pass/fail
# row per assertion, non-zero exit on any failure, trap cleanup, Git-Bash-safe.
#
# WHY THIS EXISTS
# The nightly backup used to fall back to a plain `cp` whenever the sqlite3 CLI
# was missing and still exit 0 — on a droplet stood up without the CLI, the
# WAL-mode family-hub database would have been "backed up" minus its -wal file
# every night, silently. backup-all.sh now fails closed; this proves it does.
#
# HOW TO RUN
#   tools/backup-rehearsal.sh          # from anywhere inside the repo
# Builds two throwaway databases with better-sqlite3 (one rollback-journal, one
# WAL), then runs backup-all.sh against a scratch layout with SQLITE3_BIN
# pointed at a path that does not exist (= a droplet without the CLI), with
# ALLOW_CP=1, in --dry-run, and with a shim standing in for sqlite3.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BSQ="$ROOT/node_modules/better-sqlite3"
SCRIPT="${BACKUP_SCRIPT:-$ROOT/deploy/backup-all.sh}"   # override = negative-control an older copy
PASS=0; FAIL=0
declare -a ROWS
ck() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); ROWS+=("PASS  $2"); else FAIL=$((FAIL+1)); ROWS+=("FAIL  $2"); fi; }

[ -d "$BSQ" ] || { echo "FATAL: $BSQ missing — run npm install first." >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/trips/trip-a" "$TMP/family-hub" "$TMP/dest" "$TMP/shim"

node -e '
  const Database = require(process.argv[1]);
  const a = new Database(process.argv[2]); a.exec("CREATE TABLE t (x)"); a.prepare("INSERT INTO t VALUES (1)").run(); a.close();
  const b = new Database(process.argv[3]); b.pragma("journal_mode = WAL"); b.exec("CREATE TABLE t (x)"); b.prepare("INSERT INTO t VALUES (1)").run(); b.close();
' "$BSQ" "$TMP/trips/trip-a/data.db" "$TMP/family-hub/data.db"
ck $? "built one rollback-journal db (trip-a) and one WAL db (family-hub)"

run() { # run <extra env...> -- <args...>; sets OUT / RC
  OUT="$(env TRIPS_ROOT="$TMP/trips" LEGACY_DIR="$TMP/no-legacy" FAMILY_DIR="$TMP/family-hub" \
        DEST_ROOT="$TMP/dest" "$@" 2>&1)"; RC=$?
}
summary() { printf '%s\n' "$OUT" | grep '^backup-all\['; }

echo "==> no sqlite3 CLI, no override"
run SQLITE3_BIN="$TMP/no-such-sqlite3" bash "$SCRIPT"
[ "$RC" != 0 ]; ck $? "exit is non-zero (rc=$RC)"
summary | grep -q 'FAILED' && summary | grep -q 'family-hub' && summary | grep -q 'no sqlite3 CLI'
ck $? "the one-line summary names the failed db and the reason"
[ "$(summary | wc -l)" = 1 ]; ck $? "…and it is still exactly one summary line"
[ -z "$(ls "$TMP/dest/family-hub" 2>/dev/null)" ]; ck $? "no file was written for the WAL db"
[ -n "$(ls "$TMP/dest/trip-a" 2>/dev/null)" ]; ck $? "the rollback-journal db was still copied (cp is safe enough there)"
rm -rf "$TMP/dest"/*

echo "==> --dry-run without the CLI"
run SQLITE3_BIN="$TMP/no-such-sqlite3" bash "$SCRIPT" --dry-run
[ "$RC" != 0 ]; ck $? "dry-run exit is non-zero when a real run would fail (rc=$RC)"
printf '%s\n' "$OUT" | grep -q 'would FAIL family-hub'; ck $? "dry-run says which db would fail"
[ -z "$(ls -A "$TMP/dest" 2>/dev/null)" ]; ck $? "dry-run wrote nothing"

echo "==> ALLOW_CP=1 (local rehearsal override)"
run SQLITE3_BIN="$TMP/no-such-sqlite3" ALLOW_CP=1 bash "$SCRIPT"
[ "$RC" = 0 ]; ck $? "exit is zero with ALLOW_CP=1 (rc=$RC)"
summary | grep -q '2 copied'; ck $? "both databases were copied via cp"
printf '%s\n' "$OUT" | grep -q 'ALLOW_CP=1'; ck $? "…and the override is named on stderr"
rm -rf "$TMP/dest"/*

echo "==> sqlite3 present (shim: records the .backup call, then copies)"
cat > "$TMP/shim/sqlite3" <<'SHIM'
#!/usr/bin/env bash
# argv: <db> ".backup '<dest>'"
echo "$1 $2" >> "$(dirname "$0")/calls.log"
dest="$(printf '%s' "$2" | sed "s/^\.backup '\(.*\)'$/\1/")"
cp "$1" "$dest"
SHIM
chmod +x "$TMP/shim/sqlite3"
run SQLITE3_BIN="$TMP/shim/sqlite3" bash "$SCRIPT"
[ "$RC" = 0 ]; ck $? "exit is zero with the CLI present (rc=$RC)"
[ "$(grep -c '\.backup' "$TMP/shim/calls.log" 2>/dev/null)" = 2 ]; ck $? "sqlite3 .backup was invoked once per database"
summary | grep -q '2 copied' && ! summary | grep -q FAILED; ck $? "summary: 2 copied, nothing failed"

echo "==> a failing .backup fails the run"
cat > "$TMP/shim/sqlite3" <<'SHIM'
#!/usr/bin/env bash
exit 1
SHIM
run SQLITE3_BIN="$TMP/shim/sqlite3" bash "$SCRIPT"
[ "$RC" != 0 ]; ck $? "exit is non-zero when .backup itself fails (rc=$RC)"
summary | grep -q '2 FAILED'; ck $? "summary counts both failures"

echo
echo "== backup-rehearsal summary =="
printf '%s\n' "${ROWS[@]}"
echo "------------------------------"
echo "RESULT: $PASS PASS, $FAIL FAIL"
exit $FAIL
