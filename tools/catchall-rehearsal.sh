#!/usr/bin/env bash
# tools/catchall-rehearsal.sh — checks deploy/nginx/catch-all.conf against a
# real nginx, next to a site shaped like a trip site (ssl http2, own name).
#
# Runs a throwaway nginx on high ports (18080 / 18443) with a self-signed
# certificate and checks:
#   - nginx -t passes, with no "protocol options redefined" warning;
#   - an unknown name gets no answer: http closes (444), https refuses the
#     handshake (no certificate shown);
#   - a known name still works: http -> 301 to https, https -> 200;
#   - an ACME-style stub site for a new name (http only) is still served;
#   - a second default_server on the same port fails nginx -t (why the
#     install step greps for one first);
#   - the documented exception: a site served by bare IP is refused too, and
#     the install step's grep spots such a site.
# Needs nginx, openssl and curl (run with --noproxy, so a proxy setting can't
# swallow the local requests). Where nginx isn't installed (e.g. Git Bash on
# Windows) it prints SKIP and exits 0 — the file is checked where nginx runs.
# Usage: bash tools/catchall-rehearsal.sh        Exit 0 = every check passed.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/deploy/nginx/catch-all.conf"
PASS=0; FAIL=0
ck() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS  $2"; else FAIL=$((FAIL+1)); echo "FAIL  $2"; fi; }
NGINX="$(command -v nginx || ls /usr/sbin/nginx 2>/dev/null || true)"
if [ -z "$NGINX" ] || ! command -v openssl >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "SKIP  nginx/openssl/curl not available here — run this where nginx is installed"
  echo "RESULT: 0 PASS, 0 FAIL (skipped)"
  exit 0
fi
TMP="$(mktemp -d)"
cleanup() { [ -f "$TMP/nginx.pid" ] && "$NGINX" -p "$TMP" -c "$TMP/nginx.conf" -s stop >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
chmod 755 "$TMP"   # nginx workers (not root) must read the test webroot
mkdir -p "$TMP/sites" "$TMP/logs" "$TMP/webroot/.well-known/acme-challenge"
echo "stub-token" > "$TMP/webroot/.well-known/acme-challenge/probe"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=trip-a.test" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1

# the catch-all under test, moved to high ports; IPv6 lines kept only if the
# host can bind [::]
sed -e 's/listen 80 /listen 18080 /; s/listen \[::\]:80 /listen [::]:18080 /' \
    -e 's/listen 443 /listen 18443 /; s/listen \[::\]:443 /listen [::]:18443 /' "$CONF" > "$TMP/sites/000-catch-all"
if ! grep -q . /proc/net/if_inet6 2>/dev/null; then
  sed -i '/listen \[::\]/d' "$TMP/sites/000-catch-all"
fi
# a trip-shaped site (same listen options as trip-dashboard.conf.template)
cat > "$TMP/sites/trip-a" <<EOF
server { listen 18080; server_name trip-a.test; location / { return 301 https://\$host\$request_uri; } }
server { listen 18443 ssl http2; server_name trip-a.test;
  ssl_certificate $TMP/cert.pem; ssl_certificate_key $TMP/key.pem;
  location / { return 200 "trip-a ok"; } }
EOF
# an ACME stub like new-trip.sh writes before the certificate exists (http only)
cat > "$TMP/sites/trip-b" <<EOF
server { listen 18080; server_name trip-b.test;
  location ^~ /.well-known/acme-challenge/ { root $TMP/webroot; default_type text/plain; }
  location / { return 404; } }
EOF
cat > "$TMP/nginx.conf" <<EOF
pid $TMP/nginx.pid;
error_log $TMP/logs/error.log;
events {}
http {
  access_log off;
  client_body_temp_path $TMP/cb; proxy_temp_path $TMP/px; fastcgi_temp_path $TMP/fc; uwsgi_temp_path $TMP/uw; scgi_temp_path $TMP/sc;
  include $TMP/sites/*;
}
EOF

OUT="$("$NGINX" -t -p "$TMP" -c "$TMP/nginx.conf" 2>&1)"; RC=$?
[ "$RC" = 0 ]; ck $? "nginx -t passes with the catch-all next to a trip site"
! printf '%s' "$OUT" | grep -q "protocol options redefined"; ck $? "…and nginx -t prints no \"protocol options redefined\" warning"
"$NGINX" -p "$TMP" -c "$TMP/nginx.conf" 2>/dev/null
sleep 0.5

curl --noproxy '*' -s -o /dev/null --max-time 5 -H "Host: nosuch.test" http://127.0.0.1:18080/; RC=$?
[ "$RC" = 52 ]; ck $? "http for an unknown name: connection closed with no answer (curl exit $RC = empty reply)"
curl --noproxy '*' -sk -o /dev/null --max-time 5 --resolve nosuch.test:18443:127.0.0.1 https://nosuch.test:18443/; RC=$?
[ "$RC" = 35 ]; ck $? "https for an unknown name: handshake refused, no certificate shown (curl exit $RC)"
curl --noproxy '*' -sk -o /dev/null --max-time 5 https://127.0.0.1:18443/; RC=$?
[ "$RC" = 35 ]; ck $? "https by bare IP (no name at all): refused too (curl exit $RC)"
CODE="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: trip-a.test' http://127.0.0.1:18080/)"
[ "$CODE" = 301 ]; ck $? "a known name over http still redirects to https ($CODE)"
BODY="$(curl --noproxy '*' -sk --max-time 5 --resolve trip-a.test:18443:127.0.0.1 https://trip-a.test:18443/)"
[ "$BODY" = "trip-a ok" ]; ck $? "a known name over https still reaches its site"
BODY="$(curl --noproxy '*' -s --max-time 5 -H 'Host: trip-b.test' http://127.0.0.1:18080/.well-known/acme-challenge/probe)"
[ "$BODY" = "stub-token" ]; ck $? "a new trip's certificate check (ACME stub, http only) is still served"

# the documented exception: a site served by bare IP (no name in the TLS
# handshake) is refused once the catch-all is the default — why the install
# step greps for IP server_names first
cat > "$TMP/sites/ip-site" <<EOF2
server { listen 18443 ssl http2; server_name 127.0.0.1;
  ssl_certificate $TMP/cert.pem; ssl_certificate_key $TMP/key.pem;
  location / { return 200 "ip ok"; } }
EOF2
"$NGINX" -p "$TMP" -c "$TMP/nginx.conf" -s reload 2>/dev/null; sleep 0.5
curl --noproxy '*' -sk -o /dev/null --max-time 5 https://127.0.0.1:18443/; RC=$?
[ "$RC" = 35 ]; ck $? "documented exception: an https site served by bare IP is refused too (curl exit $RC) — the install check greps for one"
IPGREP='server_name[^;]*[[:space:]]([0-9]{1,3}\.){3}[0-9]{1,3}'
printf 'server { server_name ip-too.test 127.0.0.1; }\n' > "$TMP/ip-second"
grep -qE "$IPGREP" "$TMP/sites/ip-site" && grep -qE "$IPGREP" "$TMP/ip-second" && ! grep -qE "$IPGREP" "$TMP/sites/trip-a" && grep -qF "$IPGREP" "$CONF"
ck $? "…and the install check's grep (as written in the file) finds an IP anywhere in server_name, and not a named site"
rm -f "$TMP/sites/ip-site"; "$NGINX" -p "$TMP" -c "$TMP/nginx.conf" -s reload 2>/dev/null; sleep 0.3

cp "$TMP/sites/000-catch-all" "$TMP/sites/zzz-second-default"
OUT="$("$NGINX" -t -p "$TMP" -c "$TMP/nginx.conf" 2>&1)"; RC=$?
[ "$RC" != 0 ] && printf '%s' "$OUT" | grep -q "duplicate default server"; ck $? "a second default_server on the same port fails nginx -t (\"duplicate default server\") — check before installing"
rm -f "$TMP/sites/zzz-second-default"

echo "RESULT: $PASS PASS, $FAIL FAIL"
exit "$FAIL"
