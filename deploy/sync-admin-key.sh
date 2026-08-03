#!/usr/bin/env bash
# deploy/sync-admin-key.sh — one droplet-wide admin key: copy the ADMIN_KEY
# line from a source instance's .env into EVERY instance's .env under
# TRIPS_ROOT, chmod 600 each, pm2-reload each, then print a fingerprint+probe
# table. Tracked port of the droplet's ad-hoc /root/sync-admin-key.sh, which
# this file supersedes — run it ON the droplet.
#
# Usage:  sync-admin-key.sh [source-instance]
#   source-instance defaults to the first directory (sorted) under TRIPS_ROOT
#   that contains a .env. TRIPS_ROOT env override exists for local testing
#   (no pm2 locally: reload prints "skipped", probes print "unreachable").
#
# The key itself is NEVER echoed — the table shows a 12-hex sha256 fingerprint;
# the key is passed to awk via the environment, not argv.
# Exit 0 = every instance ends with the source fingerprint; nonzero otherwise.
set -euo pipefail

TRIPS_ROOT="${TRIPS_ROOT:-/var/www/trips}"
cd "$TRIPS_ROOT" 2>/dev/null || { echo "sync-admin-key: TRIPS_ROOT '$TRIPS_ROOT' not found" >&2; exit 2; }

INSTANCES=()
for d in */; do [ -f "${d}.env" ] && INSTANCES+=("${d%/}"); done
[ "${#INSTANCES[@]}" -gt 0 ] || { echo "sync-admin-key: no instance dirs with a .env under $TRIPS_ROOT" >&2; exit 2; }

SRC="${1:-${INSTANCES[0]}}"
[ -f "$SRC/.env" ] || { echo "sync-admin-key: source instance '$SRC' has no .env here" >&2; exit 2; }

get_key() { tr -d '\r' < "$1" | sed -n 's/^ADMIN_KEY=//p' | head -1; }
fp_of()   { printf '%s' "$1" | sha256sum | cut -c1-12; }

KEY="$(get_key "$SRC/.env")"
[ -n "$KEY" ] || { echo "sync-admin-key: source '$SRC' has an empty ADMIN_KEY — nothing to sync" >&2; exit 2; }
SRC_FP="$(fp_of "$KEY")"
HAVE_PM2=0; command -v pm2 >/dev/null 2>&1 && HAVE_PM2=1

echo "source: $SRC  (key fingerprint $SRC_FP)"
printf '%-16s %-13s %-12s %s\n' "instance" "fingerprint" "pm2-reload" "probe"
BAD=0
for name in "${INSTANCES[@]}"; do
  env="$name/.env"
  if [ "$name" != "$SRC" ]; then
    # replace (or append) the ADMIN_KEY line; key travels via the environment
    tr -d '\r' < "$env" | SYNC_KEY="$KEY" awk '
      /^ADMIN_KEY=/ { print "ADMIN_KEY=" ENVIRON["SYNC_KEY"]; done=1; next }
      { print }
      END { if (!done) print "ADMIN_KEY=" ENVIRON["SYNC_KEY"] }' > "$env.tmp"
    mv "$env.tmp" "$env"
  fi
  chmod 600 "$env"
  FP="$(fp_of "$(get_key "$env")")"
  [ "$FP" = "$SRC_FP" ] || BAD=$((BAD+1))

  RELOAD="skipped (no pm2)"
  if [ "$HAVE_PM2" = 1 ]; then
    if pm2 reload "trip-${name#trip-}" >/dev/null 2>&1; then RELOAD="ok"; else RELOAD="FAILED"; BAD=$((BAD+1)); fi
  fi

  PORT="$(tr -d '\r' < "$env" | sed -n 's/^PORT=//p' | head -1)"
  PROBE="no port"
  if [ -n "$PORT" ]; then
    # on connect failure curl still prints 000 for %{http_code}; don't add more
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -H "X-Admin-Key: $KEY" "http://localhost:${PORT}/api/admin/overview" 2>/dev/null || true)"
    case "$CODE" in
      200) PROBE="200 ok" ;;
      000) PROBE="unreachable" ;;
      *)   PROBE="HTTP $CODE"; BAD=$((BAD+1)) ;;
    esac
  fi
  printf '%-16s %-13s %-12s %s\n' "$name" "$FP" "$RELOAD" "$PROBE"
done

if [ "$BAD" -gt 0 ]; then
  echo "sync-admin-key: $BAD problem(s) — see the table above" >&2
  exit 1
fi
echo "sync-admin-key: all instances carry fingerprint $SRC_FP"
