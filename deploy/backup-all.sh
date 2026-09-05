#!/usr/bin/env bash
# deploy/backup-all.sh — nightly SQLite backups for EVERY trip instance.
#
# Target: droplet root cron. This REPLACES the old single-instance backup cron
# entry — remove that line when installing this one. Suggested crontab line:
#
#   10 3 * * * /root/backup-all.sh >> /var/log/db-backup.log 2>&1
#
# Copies each /var/www/trips/<name>/data.db — plus the legacy pre-multi
# /var/www/trip-dashboard/data.db while it still exists — to
# /root/db-backups/<name>/data.db.<YYYYMMDD-HHMM>, prunes copies older than
# 14 days, and prints exactly one summary line per run (the cron log stays
# one line per night).
#
# Uses SQLite's online backup (`sqlite3 .backup`) so a database being written
# to is snapshotted consistently — this matters most for the WAL-mode family
# hub, where a plain `cp` misses whatever is still in the -wal file.
#
# The sqlite3 CLI is REQUIRED for a real run (deploy/provision.sh installs
# it). When it is missing the run FAILS CLOSED: every WAL-mode or unknown-mode
# database is reported as FAILED, the one-line summary says why, and the exit
# code is non-zero so cron mails it. A rollback-journal database (file header
# byte 18 == 1) is still copied with `cp` in that case — cp of one is at worst
# torn, never silently missing a -wal file — and the summary still says the CLI
# was absent.
#
#   ALLOW_CP=1    LOCAL REHEARSALS ONLY: with the CLI missing, fall back to cp
#                 for EVERY database (the pre-v3 behavior), noted once on stderr.
#                 Never set this in the droplet's crontab.
#   SQLITE3_BIN   the binary to use (default: sqlite3 on PATH). Rehearsals point
#                 it at a missing path to simulate a droplet without the CLI.
#
# --dry-run: print what would be copied/pruned/FAILED, write nothing; the exit
# code still reflects would-fail so a dry run on a new droplet is an honest
# preflight.
# TRIPS_ROOT / LEGACY_DIR / FAMILY_DIR / DEST_ROOT env overrides exist for
# local rehearsal.
set -u

TRIPS_ROOT="${TRIPS_ROOT:-/var/www/trips}"
LEGACY_DIR="${LEGACY_DIR:-/var/www/trip-dashboard}"
FAMILY_DIR="${FAMILY_DIR:-/var/www/family-hub}"
DEST_ROOT="${DEST_ROOT:-/root/db-backups}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

STAMP="$(date +%Y%m%d-%H%M)"
copied=0; pruned=0; skipped=0; failed=0; failed_names=""
SQLITE3_BIN="${SQLITE3_BIN:-sqlite3}"
ALLOW_CP="${ALLOW_CP:-0}"
HAVE_SQLITE3=0
if command -v "$SQLITE3_BIN" >/dev/null 2>&1; then
  HAVE_SQLITE3=1
elif [ "$ALLOW_CP" = 1 ]; then
  echo "backup-all: sqlite3 CLI not found — ALLOW_CP=1, falling back to cp for every database (rehearsal only; a live WAL-mode database may not copy cleanly)" >&2
else
  echo "backup-all: sqlite3 CLI not found — WAL-mode and unknown-mode databases will FAIL (install sqlite3; ALLOW_CP=1 is for local rehearsals only)" >&2
fi

# Journal mode straight from the file header, so it needs no sqlite3: byte 18
# is the write version — 1 = rollback journal, 2 = WAL. Anything else (empty
# file, not SQLite, unreadable) is unknown, and unknown fails closed.
db_mode() { # db_mode <path> → rollback | wal | unknown
  local b
  b="$(dd if="$1" bs=1 skip=18 count=1 2>/dev/null | od -An -tu1 | tr -d ' \n')"
  case "$b" in 1) echo rollback ;; 2) echo wal ;; *) echo unknown ;; esac
}
fail_one() { # fail_one <name> <reason> — counts the failure; loud line unless dry
  failed=$((failed+1)); failed_names="$failed_names $1"
  [ "$DRY" = 1 ] || echo "backup-all: BACKUP FAILED for $1: $2" >&2
}

do_one() { # do_one <name> <db-path>
  local name="$1" db="$2" dest="$DEST_ROOT/$1"
  if [ ! -f "$db" ]; then skipped=$((skipped+1)); return; fi
  # Decide the method up front so dry-run and real run agree.
  local via="sqlite3" mode=""
  if [ "$HAVE_SQLITE3" = 0 ]; then
    mode="$(db_mode "$db")"
    if [ "$ALLOW_CP" = 1 ] || [ "$mode" = rollback ]; then via="cp"; else via="FAIL"; fi
  fi
  if [ "$DRY" = 1 ]; then
    if [ "$via" = FAIL ]; then
      echo "DRY: would FAIL $name ($db): $mode-mode database and no sqlite3 CLI"
      fail_one "$name" "$mode-mode database, no sqlite3 CLI"
      return
    fi
    echo "DRY: would copy (via $via) $db -> $dest/data.db.$STAMP"
    copied=$((copied+1))
    local old
    old="$(find "$dest" -name 'data.db.*' -mtime +14 2>/dev/null | wc -l)"
    if [ "$old" -gt 0 ]; then
      echo "DRY: would prune $old backup(s) older than 14 days in $dest"
      pruned=$((pruned+old))
    fi
  else
    mkdir -p "$dest"
    # SQLite's online backup is the only consistent copy of a live database:
    # cp can capture a torn page mid-write, and for a WAL-mode database (the
    # family hub runs one) it silently misses everything still in -wal.
    case "$via" in
      sqlite3)
        if ! "$SQLITE3_BIN" "$db" ".backup '$dest/data.db.$STAMP'"; then
          fail_one "$name" "sqlite3 .backup failed ($db)"; return
        fi ;;
      cp)
        if ! cp "$db" "$dest/data.db.$STAMP"; then
          fail_one "$name" "cp failed ($db)"; return
        fi ;;
      FAIL)
        fail_one "$name" "$mode-mode database and no sqlite3 CLI ($db)"; return ;;
    esac
    copied=$((copied+1))
    local n
    n="$(find "$dest" -name 'data.db.*' -mtime +14 -print -delete 2>/dev/null | wc -l)"
    pruned=$((pruned+n))
  fi
}

for dir in "$TRIPS_ROOT"/*/; do
  [ -d "$dir" ] || continue
  do_one "$(basename "$dir")" "${dir}data.db"
done
if [ -f "$LEGACY_DIR/data.db" ]; then
  do_one "legacy" "$LEGACY_DIR/data.db"
fi

if [ -f "$FAMILY_DIR/data.db" ]; then
  do_one "family-hub" "$FAMILY_DIR/data.db"
fi
TAG=""
[ "$DRY" = 1 ] && TAG=" (dry-run)"
# Still exactly one summary line per run; a failure is appended to it with
# its reason, and the exit code goes non-zero so cron reports it.
WHY=""
if [ "$failed" -gt 0 ]; then
  [ "$HAVE_SQLITE3" = 0 ] && WHY=" — no sqlite3 CLI (apt-get install sqlite3)" || WHY=" — see stderr"
  WHY=", $failed FAILED:$failed_names$WHY"
fi
echo "backup-all[$STAMP]$TAG: $copied copied, $pruned pruned, $skipped dir(s) without data.db$WHY"
[ "$failed" -eq 0 ]
