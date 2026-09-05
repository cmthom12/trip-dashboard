#!/usr/bin/env bash
# deploy/new-env.sh — write a FRESH .env from a template, with PIN_PEPPER
# generated at creation time (openssl rand -hex 24). This replaces the bare
# `cp env.template .env` step in the stand-up recipes, so a new instance (or
# a new portal) is peppered from its first sign-in instead of by a later
# migration.
#
#   deploy/new-env.sh <dest-dir | .env path> [template]
#
#   trip instance : bash deploy/new-env.sh /var/www/trips/<name>
#   family portal : bash deploy/new-env.sh /var/www/family-hub family-hub/deploy/env.template
#
# Template default: env.template next to this script. Only PIN_PEPPER is
# generated — PORT, ADMIN_KEY, CORS_ORIGIN and the rest stay exactly as the
# template has them, to be filled in by hand as before (docs/MULTI_INSTANCE.md
# §ADD-A-TRIP, family-hub/README.md §Deploy). The file is written chmod 600.
#
# An EXISTING .env is never touched (exit 3): PIN_PEPPER must never change
# once set, or every PIN already hashed under it stops matching (ADMIN.md
# §PIN pepper). Rotate a pepper only by choice, never by re-running this.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:?usage: new-env.sh <dest-dir | .env path> [template]}"
TPL="${2:-$HERE/env.template}"
[ -d "$DEST" ] && DEST="$DEST/.env"

[ -f "$TPL" ] || { echo "new-env: template not found: $TPL" >&2; exit 2; }
if [ -e "$DEST" ]; then
  echo "new-env: $DEST already exists — existing .env files are never touched (a PIN_PEPPER must not change once set)." >&2
  exit 3
fi
grep -q '^PIN_PEPPER=$' "$TPL" || { echo "new-env: $TPL has no empty 'PIN_PEPPER=' line to fill" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "new-env: openssl not found — needed to generate PIN_PEPPER" >&2; exit 2; }

PEPPER="$(openssl rand -hex 24)"
umask 077
sed "s/^PIN_PEPPER=\$/PIN_PEPPER=$PEPPER/" "$TPL" > "$DEST"
chmod 600 "$DEST"
grep -q "^PIN_PEPPER=$PEPPER\$" "$DEST" || { echo "new-env: PIN_PEPPER did not land in $DEST" >&2; rm -f "$DEST"; exit 1; }

TODO="$(grep -oE '^[A-Z_]+=$' "$DEST" | tr -d '=' | tr '\n' ' ')"
echo "new-env: wrote $DEST from $(basename "$TPL") with a fresh PIN_PEPPER (chmod 600)."
[ -n "$TODO" ] && echo "new-env: still empty, fill in by hand: $TODO"
exit 0
