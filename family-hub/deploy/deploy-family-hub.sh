#!/usr/bin/env bash
# family-hub/deploy/deploy-family-hub.sh — push the family portal's code to the
# droplet and restart it, with the same health gate deploy/deploy.sh gives trip
# instances and admin-hub/deploy-hub.sh gives the admin hub.
#
# Why its own script rather than a deploy.sh instance row: like admin-hub, the
# portal's source is its own tree (family-hub/server.js, public/, package.json)
# while deploy.sh ships the repo-root app — a row would ship the wrong files.
# Same shape, different source dir.
#
# Ships CODE ONLY: family-hub/server.js, package*.json, lib/, public/. Never
# ships ecosystem*, .env, instances.dev.json, data.db or node_modules — the
# portal's PIN table lives in /var/www/family-hub/data.db and a deploy must
# never touch it (same rule as an instance's data.db in deploy/deploy.sh). The
# pm2 process 'family-hub' must already exist — first-time install is
# family-hub/README.md (§Deploy), done by hand: .env, pm2 start, nginx apex
# site, certbot.
set -euo pipefail

# ========== EDIT THESE (or use deploy/deploy.local.env) ==========
SERVER="root@YOUR_SERVER_IP"          # e.g. root@203.0.113.10
SSH_KEY="$HOME/.ssh/YOUR_KEY"         # e.g. ~/.ssh/id_ed25519
FAMILY_DIR="/var/www/family-hub"      # NEVER under /var/www/trips (self-discovery hazard)
FAMILY_PORT="3011"                    # must match the portal's .env PORT
# =================================================================

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"

# Same credential file as deploy/deploy.sh and admin-hub/deploy-hub.sh
# (gitignored — copy deploy/deploy.local.env.example): one place for
# SERVER/SSH_KEY, and it may also override FAMILY_DIR/FAMILY_PORT. Absent file
# = the placeholders above, as before.
[ -f "$APP/../deploy/deploy.local.env" ] && . "$APP/../deploy/deploy.local.env"
LOCAL_VER="$(cd "$APP" && node -p "require('./package.json').version")"
SSH="ssh -i ${SSH_KEY}"
SCP="scp -i ${SSH_KEY}"

echo "==> deploying family-hub v${LOCAL_VER} to ${FAMILY_DIR}, port ${FAMILY_PORT}"
$SSH "$SERVER" "mkdir -p ${FAMILY_DIR}/public ${FAMILY_DIR}/lib ${FAMILY_DIR}/deploy"
cd "$APP"
$SCP server.js package*.json "${SERVER}:${FAMILY_DIR}/"
$SCP -r public lib "${SERVER}:${FAMILY_DIR}/"
$SCP deploy/env.template deploy/ecosystem.template.config.js "${SERVER}:${FAMILY_DIR}/deploy/"

echo "==> installing deps + restarting pm2 family-hub"
$SSH "$SERVER" "cd ${FAMILY_DIR} && npm install --omit=dev"
if ! $SSH "$SERVER" "pm2 restart family-hub"; then
  echo "deploy-family-hub.sh: pm2 restart family-hub FAILED — the process must exist first." >&2
  echo "First-time install is family-hub/README.md (§Deploy)." >&2
  exit 1
fi

echo "==> health gate: HTTP 200 + version ${LOCAL_VER} on 127.0.0.1:${FAMILY_PORT}"
sleep 2
CODE="$($SSH "$SERVER" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${FAMILY_PORT}/api/health" || echo 000)"
BODY="$($SSH "$SERVER" "curl -s http://127.0.0.1:${FAMILY_PORT}/api/health" || true)"
if [ "$CODE" != "200" ]; then
  echo "deploy-family-hub.sh: HEALTH GATE FAILED — HTTP ${CODE}. Check: pm2 logs family-hub" >&2
  exit 1
fi
case "$BODY" in
  *"\"version\":\"${LOCAL_VER}\""*) : ;;
  *) echo "deploy-family-hub.sh: HEALTH GATE FAILED — running version != v${LOCAL_VER}. Body: ${BODY}" >&2; exit 1 ;;
esac

echo
echo "deployed: family-hub healthy on port ${FAMILY_PORT} at v${LOCAL_VER}."
