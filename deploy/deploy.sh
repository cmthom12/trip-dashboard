#!/usr/bin/env bash
# deploy.sh v2 — push the app CODE to one named instance and restart it under PM2.
# Run FROM your laptop, in Git Bash on Windows or any POSIX shell:
#
#   deploy/deploy.sh <instance>
#
# The instance map lives in deploy/instances.local.conf (gitignored — your real
# rows) or, if that file doesn't exist, deploy/instances.conf (tracked, EXAMPLE
# rows only). Row format: <name>  <app-dir-on-droplet>  <port>
#
# Ships CODE ONLY: server.js, package.json, package-lock.json, tools/, public/
# (minus *.backup-* safety copies). NEVER ships: ecosystem* (per-instance config
# lives on the droplet — see deploy/ecosystem.template.config.js), .env, data.db,
# *.backup-*, node_modules. The live database is never touched by a deploy.
#
# The PM2 process trip-<name> must already exist on the droplet (created once by
# the add-a-trip recipe in docs/MULTI_INSTANCE.md). This script only restarts it,
# then gates on /api/health matching the local package.json version.
set -euo pipefail

# ========== EDIT THESE (or use deploy/deploy.local.env) ==========
SERVER="root@YOUR_SERVER_IP"          # e.g. root@203.0.113.10
SSH_KEY="$HOME/.ssh/YOUR_KEY"         # e.g. ~/.ssh/id_ed25519
# =================================================================

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Real credentials live in deploy/deploy.local.env (gitignored — copy
# deploy/deploy.local.env.example). When present it overrides the placeholders
# above, so the tracked script never needs editing; editing in place still
# works as before when the file is absent.
[ -f "$HERE/deploy.local.env" ] && . "$HERE/deploy.local.env"
CONF="$HERE/instances.local.conf"
[ -f "$CONF" ] || CONF="$HERE/instances.conf"

usage() {
  echo "Usage: deploy.sh <instance>" >&2
  echo "Known instances (from ${CONF##*/}):" >&2
  tr -d '\r' < "$CONF" | awk '$1 !~ /^#/ && NF >= 3 { printf "  %-12s %-32s port %s\n", $1, $2, $3 }' >&2
  exit 1
}

NAME="${1:-}"
[ -n "$NAME" ] || usage
ROW="$(tr -d '\r' < "$CONF" | awk -v n="$NAME" '$1 !~ /^#/ && NF >= 3 && $1 == n { print $2, $3; exit }')"
if [ -z "$ROW" ]; then
  echo "deploy.sh: unknown instance '$NAME'" >&2
  usage
fi
read -r APP_DIR PORT <<<"$ROW"
# PM2 process = trip-<name>, but names that already carry the trip- prefix
# (like the example rows) aren't double-prefixed: trip-a -> trip-a, smith -> trip-smith.
PM2_NAME="trip-${NAME#trip-}"
LOCAL_VER="$(cd "$ROOT" && node -p "require('./package.json').version")"

SSH="ssh -i ${SSH_KEY}"
SCP="scp -i ${SSH_KEY}"

echo "==> deploying '$NAME' (v$LOCAL_VER) to ${APP_DIR}, port ${PORT}, pm2 ${PM2_NAME}"

echo "==> ensuring app dir exists"
$SSH "$SERVER" "mkdir -p ${APP_DIR}/public"

echo "==> copying app files (code only — no ecosystem*, .env, node_modules, data.db, *.backup-*)"
cd "$ROOT"
$SCP server.js package.json package-lock.json "${SERVER}:${APP_DIR}/"
$SCP -r tools "${SERVER}:${APP_DIR}/"   # server requires tools/lib/validate.js since the trip-import feature
STAGE="$(mktemp -d)"
cp -r public "$STAGE/public"
find "$STAGE/public" -name '*.backup-*' -type f -delete
$SCP -r "$STAGE/public" "${SERVER}:${APP_DIR}/"
rm -rf "$STAGE"

echo "==> installing deps + restarting ${PM2_NAME}"
$SSH "$SERVER" "cd ${APP_DIR} && npm install --omit=dev"
if ! $SSH "$SERVER" "pm2 restart ${PM2_NAME}"; then
  echo "deploy.sh: pm2 restart ${PM2_NAME} FAILED — the process must exist before deploying." >&2
  echo "First-time setup for an instance is the add-a-trip recipe in docs/MULTI_INSTANCE.md." >&2
  exit 1
fi

echo "==> health gate: expecting HTTP 200 and version ${LOCAL_VER} on localhost:${PORT}"
sleep 2
CODE="$($SSH "$SERVER" "curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/api/health" || echo 000)"
BODY="$($SSH "$SERVER" "curl -s http://localhost:${PORT}/api/health" || true)"
if [ "$CODE" != "200" ]; then
  echo "deploy.sh: HEALTH GATE FAILED — /api/health returned HTTP ${CODE} on port ${PORT}." >&2
  echo "Check: pm2 logs ${PM2_NAME}" >&2
  exit 1
fi
case "$BODY" in
  *"\"version\":\"${LOCAL_VER}\""*) : ;;
  *)
    echo "deploy.sh: HEALTH GATE FAILED — running version does not match local v${LOCAL_VER}." >&2
    echo "Health body: ${BODY}" >&2
    exit 1
    ;;
esac

echo
echo "deployed: '$NAME' is healthy on port ${PORT} at v${LOCAL_VER}."
