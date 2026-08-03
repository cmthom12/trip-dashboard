#!/usr/bin/env bash
# admin-hub/deploy-hub.sh — push the hub's code to the droplet and restart it,
# with the same health gate as deploy/deploy.sh gives trip instances.
#
# Why not a deploy.sh instance row: the hub's source lives in admin-hub/ (its
# own server.js, public/, package.json), while deploy.sh ships the repo-root
# app — a row would ship the wrong files. Same shape, different source dir.
#
# Ships CODE ONLY: admin-hub/server.js, package.json, public/. Never ships
# ecosystem*, .env, node_modules. The pm2 process 'admin-hub' must already
# exist (docs/MULTI_INSTANCE.md §ADMIN-HUB first-time install).
set -euo pipefail

# ===================== EDIT THESE =====================
SERVER="root@YOUR_SERVER_IP"          # e.g. root@203.0.113.10
SSH_KEY="$HOME/.ssh/YOUR_KEY"         # e.g. ~/.ssh/id_ed25519
HUB_DIR="/var/www/admin-hub"          # NEVER under /var/www/trips (self-discovery hazard)
HUB_PORT="3010"                       # must match the hub's .env PORT
# ======================================================

HERE="$(cd "$(dirname "$0")" && pwd)"
LOCAL_VER="$(cd "$HERE" && node -p "require('./package.json').version")"
SSH="ssh -i ${SSH_KEY}"
SCP="scp -i ${SSH_KEY}"

echo "==> deploying admin-hub v${LOCAL_VER} to ${HUB_DIR}, port ${HUB_PORT}"
$SSH "$SERVER" "mkdir -p ${HUB_DIR}/public"
cd "$HERE"
$SCP server.js package.json "${SERVER}:${HUB_DIR}/"
$SCP -r public "${SERVER}:${HUB_DIR}/"

echo "==> installing deps + restarting pm2 admin-hub"
$SSH "$SERVER" "cd ${HUB_DIR} && npm install --omit=dev"
if ! $SSH "$SERVER" "pm2 restart admin-hub"; then
  echo "deploy-hub.sh: pm2 restart admin-hub FAILED — the process must exist first." >&2
  echo "First-time install is docs/MULTI_INSTANCE.md §ADMIN-HUB." >&2
  exit 1
fi

echo "==> health gate: HTTP 200 + version ${LOCAL_VER} on localhost:${HUB_PORT}"
sleep 2
CODE="$($SSH "$SERVER" "curl -s -o /dev/null -w '%{http_code}' http://localhost:${HUB_PORT}/api/health" || echo 000)"
BODY="$($SSH "$SERVER" "curl -s http://localhost:${HUB_PORT}/api/health" || true)"
if [ "$CODE" != "200" ]; then
  echo "deploy-hub.sh: HEALTH GATE FAILED — HTTP ${CODE}. Check: pm2 logs admin-hub" >&2
  exit 1
fi
case "$BODY" in
  *"\"version\":\"${LOCAL_VER}\""*) : ;;
  *) echo "deploy-hub.sh: HEALTH GATE FAILED — running version != v${LOCAL_VER}. Body: ${BODY}" >&2; exit 1 ;;
esac

echo
echo "deployed: admin-hub healthy on port ${HUB_PORT} at v${LOCAL_VER}."
