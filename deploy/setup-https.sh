#!/usr/bin/env bash
# setup-https.sh — turn on HTTPS. Run ON the server as root, AFTER deploy.sh.
#   CERT_MODE=domain : standard 90-day Let's Encrypt cert, auto-installed + auto-renewed (RECOMMENDED)
#   CERT_MODE=ip     : Let's Encrypt short-lived (~6 day) cert for a bare public IP (no domain needed)
# Works in two phases: serve the ACME challenge over HTTP, get the cert, then enable HTTPS.
set -euo pipefail

# ===================== EDIT THESE =====================
SERVER_NAME="trip.example.com"        # your DOMAIN, or your server's PUBLIC IP for ip mode
CERT_MODE="domain"                    # "domain" (recommended) or "ip"
EMAIL="you@example.com"               # real email for renewal/expiry notices
APP_PORT="3000"
WEBROOT="/var/www/letsencrypt"
TEMPLATE="$(dirname "$0")/nginx/trip-dashboard.conf.template"
SITE="/etc/nginx/sites-available/trip-dashboard"
# ======================================================

if [ "$(id -u)" != "0" ]; then echo "Run as root:  sudo bash setup-https.sh"; exit 1; fi
mkdir -p "${WEBROOT}/.well-known/acme-challenge"; chown -R www-data:www-data "${WEBROOT}"

echo "==> phase 1: temporary HTTP site so certbot can validate"
cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};
    location ^~ /.well-known/acme-challenge/ { root ${WEBROOT}; default_type "text/plain"; allow all; }
    location / { return 200 "ok\n"; }
}
EOF
ln -sf "$SITE" /etc/nginx/sites-enabled/trip-dashboard
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> phase 2: obtaining certificate (${CERT_MODE} mode)"
if [ "$CERT_MODE" = "ip" ]; then
  # IP certs are only issued under the 'shortlived' profile. The nginx plugin can't
  # install IP certs, so we use --webroot and reload nginx via --deploy-hook.
  certbot certonly --webroot -w "$WEBROOT" \
    --preferred-profile shortlived \
    --ip-address "$SERVER_NAME" \
    --email "$EMAIL" --agree-tos --non-interactive \
    --deploy-hook 'systemctl reload nginx'
else
  certbot certonly --webroot -w "$WEBROOT" \
    -d "$SERVER_NAME" \
    --email "$EMAIL" --agree-tos --non-interactive \
    --deploy-hook 'systemctl reload nginx'
fi

CERT_DIR="/etc/letsencrypt/live/${SERVER_NAME}"
if [ ! -f "${CERT_DIR}/fullchain.pem" ]; then
  echo "ERROR: certificate not found at ${CERT_DIR}. Check the certbot output above."
  echo "Tip: test first by adding --staging (or --test-cert) to the certbot command."
  exit 1
fi

echo "==> phase 3: enabling HTTPS reverse proxy"
sed -e "s|__SERVER_NAME__|${SERVER_NAME}|g" \
    -e "s|__APP_PORT__|${APP_PORT}|g" \
    -e "s|__WEBROOT__|${WEBROOT}|g" \
    -e "s|__CERT_DIR__|${CERT_DIR}|g" \
    "$TEMPLATE" > "$SITE"
nginx -t && systemctl reload nginx

echo
echo "HTTPS is live:  https://${SERVER_NAME}/"
echo "Test it:        curl -I https://${SERVER_NAME}/"
echo "Renewal timer:  systemctl list-timers | grep certbot"
if [ "$CERT_MODE" = "ip" ]; then
  echo
  echo "IP-CERT NOTES:"
  echo "  * This cert is valid ~6 days (160h). certbot's timer auto-renews it (twice daily)"
  echo "    and reloads nginx via the deploy-hook. Keep the server + timer running."
  echo "  * Margin is thin: if the server is offline for several days the cert can lapse"
  echo "    and browsers will warn until it renews. A domain cert avoids this entirely."
  echo "  * Leave HSTS commented out in the nginx config for IP mode."
fi
