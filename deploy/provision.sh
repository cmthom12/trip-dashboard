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
apt-get install -y curl ca-certificates gnupg build-essential python3 ufw

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
echo "  app dir: ${APP_DIR}"
echo
echo "Next:  1) from your laptop, run deploy.sh to push the app"
echo "       2) back here, edit + run setup-https.sh to turn on HTTPS"
