#!/usr/bin/env bash
# deploy.sh — push the app to the server and (re)start it under PM2.
# Run FROM your laptop, in the project folder (the one with server.js + public/).
# Uses scp so it works in Git Bash on Windows. Never copies node_modules or data.db,
# so the live database is never overwritten.
set -euo pipefail

# ===================== EDIT THESE =====================
SERVER="root@YOUR_SERVER_IP"          # e.g. root@203.0.113.10
SSH_KEY="$HOME/.ssh/YOUR_KEY"         # e.g. ~/.ssh/id_ed25519
APP_DIR="/var/www/trip-dashboard"     # must match provision.sh
# ======================================================

SSH="ssh -i ${SSH_KEY}"
SCP="scp -i ${SSH_KEY}"

echo "==> ensuring app dir exists"
$SSH "$SERVER" "mkdir -p ${APP_DIR}/public"

echo "==> copying app files (no node_modules, no data.db)"
$SCP server.js package.json package-lock.json ecosystem.config.js "${SERVER}:${APP_DIR}/"
$SCP -r public "${SERVER}:${APP_DIR}/"

echo "==> installing deps + starting under PM2"
$SSH "$SERVER" "cd ${APP_DIR} && npm install --omit=dev && \
  (pm2 reload ecosystem.config.js || pm2 start ecosystem.config.js) && pm2 save"

echo
echo "deployed. App is running behind PM2 on the server."
echo "If HTTPS isn't set up yet, run setup-https.sh on the server next."
