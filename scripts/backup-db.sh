#!/usr/bin/env bash
# backup-db.sh — sqlite-safe snapshot of the trip dashboard database, made for cron.
# Runs ON THE SERVER. Uses sqlite3's online .backup (safe while the app is live);
# never copies the file directly. Prunes its own snapshots after KEEP_DAYS, but
# leaves data.db.backup-admin-* (deliberate pre-change snapshots) alone.
#
# Install (as the user that owns the app dir):   crontab -e
#   10 3 * * * /var/www/trip-dashboard/scripts/backup-db.sh >> /var/log/trip-backup.log 2>&1
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/trip-dashboard}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB="$APP_DIR/data.db"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$APP_DIR/data.db.backup-$STAMP"

command -v sqlite3 >/dev/null 2>&1 || { echo "$(date -Is) ERROR: sqlite3 not installed (apt-get install -y sqlite3)"; exit 1; }
[ -f "$DB" ] || { echo "$(date -Is) ERROR: no database at $DB"; exit 1; }

sqlite3 "$DB" ".backup '$OUT'"

# Prune only nightly snapshots (timestamp-named); admin snapshots are kept.
find "$APP_DIR" -maxdepth 1 -name 'data.db.backup-[0-9]*' -mtime +"$KEEP_DAYS" -type f -delete

echo "$(date -Is) backup written: $OUT ($(du -h "$OUT" | cut -f1))"
