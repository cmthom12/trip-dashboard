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
# Plain `cp` of a live SQLite db is the same tradeoff the single-instance cron
# made: fine at 03:10 when nobody is writing; the admin console's "Backup Now"
# (better-sqlite3 online backup) is the transactionally-safe alternative.
#
# --dry-run: print what would be copied/pruned, write nothing.
# TRIPS_ROOT / LEGACY_DIR / DEST_ROOT env overrides exist for local rehearsal.
set -u

TRIPS_ROOT="${TRIPS_ROOT:-/var/www/trips}"
LEGACY_DIR="${LEGACY_DIR:-/var/www/trip-dashboard}"
DEST_ROOT="${DEST_ROOT:-/root/db-backups}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

STAMP="$(date +%Y%m%d-%H%M)"
copied=0; pruned=0; skipped=0

do_one() { # do_one <name> <db-path>
  local name="$1" db="$2" dest="$DEST_ROOT/$1"
  if [ ! -f "$db" ]; then skipped=$((skipped+1)); return; fi
  if [ "$DRY" = 1 ]; then
    echo "DRY: would copy $db -> $dest/data.db.$STAMP"
    copied=$((copied+1))
    local old
    old="$(find "$dest" -name 'data.db.*' -mtime +14 2>/dev/null | wc -l)"
    if [ "$old" -gt 0 ]; then
      echo "DRY: would prune $old backup(s) older than 14 days in $dest"
      pruned=$((pruned+old))
    fi
  else
    mkdir -p "$dest"
    if ! cp "$db" "$dest/data.db.$STAMP"; then
      echo "backup-all: COPY FAILED for $name ($db)" >&2
      return
    fi
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

TAG=""
[ "$DRY" = 1 ] && TAG=" (dry-run)"
echo "backup-all[$STAMP]$TAG: $copied copied, $pruned pruned, $skipped dir(s) without data.db"
