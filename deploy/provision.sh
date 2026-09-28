#!/usr/bin/env bash
# provision.sh — one-time server setup. Run ON the server as root (or with sudo).
#   Installs: Node.js, nginx, PM2, certbot (snap, >=5.4 for IP certs), firewall.
#   Safe to re-run.
set -euo pipefail

# ===================== EDIT THESE =====================
APP_DIR="/var/www/trip-dashboard"     # where the app will live
NODE_MAJOR="24"                       # Node LTS major (22 or 24; 24 matches .nvmrc)
WEBROOT="/var/www/letsencrypt"        # ACME challenge web root
# ======================================================

if [ "$(id -u)" != "0" ]; then echo "Run as root:  sudo bash provision.sh"; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "==> base packages"
apt-get update -y
# sqlite3: the CLI deploy/backup-all.sh needs for consistent online backups.
# Without it the nightly backup FAILS CLOSED for WAL-mode databases (the
# family hub's), so it is part of the base set rather than an afterthought.
apt-get install -y curl ca-certificates gnupg build-essential python3 ufw sqlite3

echo "==> Node.js ${NODE_MAJOR}.x (NodeSource)"
if ! command -v node >/dev/null || [ "$(node -v | grep -oE '[0-9]+' | head -1)" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

echo "==> nginx"
apt-get install -y nginx

echo "==> certbot via snap (needs >=5.4 for IP-address certs; apt's certbot is too old)"
apt-get install -y snapd
snap install core >/dev/null 2>&1 || true
snap refresh core >/dev/null 2>&1 || true
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot

echo "==> PM2"
npm install -g pm2

echo "==> directories"
mkdir -p "${APP_DIR}/public" "${WEBROOT}/.well-known/acme-challenge"
chown -R www-data:www-data "${WEBROOT}"

echo "==> firewall (SSH + HTTP/HTTPS)"
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp
ufw allow 'Nginx Full'
yes | ufw enable >/dev/null 2>&1 || true

echo
echo "provision complete."
echo "  node:    $(node -v)"
echo "  npm:     $(npm -v)"
echo "  nginx:   $(nginx -v 2>&1)"
echo "  certbot: $(certbot --version 2>&1)"
echo "  pm2:     $(pm2 -v 2>/dev/null | tail -1)"
echo "  app dir: ${APP_DIR}  (single-app layout; trips made by new-trip.sh live in /var/www/trips/<name>)"
echo
echo "Next (from your laptop, repo root, deploy/deploy.local.env filled in — see deploy/DEPLOY.md):"
echo "  1) deploy/new-trip.sh <name> --dry-run, then type: deploy/new-trip.sh <name> --yes"
echo "     (creates the trip: .env with a fresh PIN_PEPPER, PM2 process, Nginx site, certificate)"
echo "  2) every later release: deploy/deploy.sh <name>"
