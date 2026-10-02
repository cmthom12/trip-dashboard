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
#     the install step's grep spots such a site;
#   - the header's three pre-install commands, run exactly as written (paths
#     moved into the test dir) against a server-shaped layout: sites-available
#     holds the files, sites-enabled holds SYMLINKS to them (as on the
#     droplet). A clean layout prints nothing and "files read N of N" (a
#     hidden editor file and a site file with no server_name included); a
#     broken symlink shows one short; a second default site (default_server
#     or the older "default") and a bare-IP site are found, in sites-enabled
#     and in conf.d; plain grep -r would have missed them (why -R).
# The nginx under test also loads its sites through symlinks, like the server.
# CATCHALL_CONF=<file> checks another copy (e.g. an older one) instead.
# Needs nginx, openssl and curl (run with --noproxy, so a proxy setting can't
# swallow the local requests). Where nginx isn't installed (e.g. Git Bash on
# Windows) it prints SKIP and exits 0 — the file is checked where nginx runs.
# Usage: bash tools/catchall-rehearsal.sh        Exit 0 = every check passed.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="${CATCHALL_CONF:-$ROOT/deploy/nginx/catch-all.conf}"
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
mkdir -p "$TMP/sites-available" "$TMP/sites-enabled" "$TMP/conf.d" "$TMP/logs" "$TMP/webroot/.well-known/acme-challenge"
# like the server: each site is a file in sites-available, enabled by a symlink
enable() { ln -s "$TMP/sites-available/$1" "$TMP/sites-enabled/$1"; }
echo "stub-token" > "$TMP/webroot/.well-known/acme-challenge/probe"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=trip-a.test" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1

# the catch-all under test, moved to high ports; IPv6 lines kept only if the
# host can bind [::]
sed -e 's/listen 80 /listen 18080 /; s/listen \[::\]:80 /listen [::]:18080 /' \
    -e 's/listen 443 /listen 18443 /; s/listen \[::\]:443 /listen [::]:18443 /' "$CONF" > "$TMP/sites-available/000-catch-all"
enable 000-catch-all
if ! grep -q . /proc/net/if_inet6 2>/dev/null; then
  sed -i '/listen \[::\]/d' "$TMP/sites-available/000-catch-all"
fi
# a trip-shaped site (same listen options as trip-dashboard.conf.template)
cat > "$TMP/sites-available/trip-a" <<EOF
server { listen 18080; server_name trip-a.test; location / { return 301 https://\$host\$request_uri; } }
server { listen 18443 ssl http2; server_name trip-a.test;
  ssl_certificate $TMP/cert.pem; ssl_certificate_key $TMP/key.pem;
  location / { return 200 "trip-a ok"; } }
EOF
enable trip-a
# an ACME stub like new-trip.sh writes before the certificate exists (http only)
cat > "$TMP/sites-available/trip-b" <<EOF
server { listen 18080; server_name trip-b.test;
  location ^~ /.well-known/acme-challenge/ { root $TMP/webroot; default_type text/plain; }
  location / { return 404; } }
EOF
enable trip-b
cat > "$TMP/nginx.conf" <<EOF
pid $TMP/nginx.pid;
error_log $TMP/logs/error.log;
events {}
http {
  access_log off;
  client_body_temp_path $TMP/cb; proxy_temp_path $TMP/px; fastcgi_temp_path $TMP/fc; uwsgi_temp_path $TMP/uw; scgi_temp_path $TMP/sc;
  include $TMP/sites-enabled/*;
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
cat > "$TMP/sites-available/ip-site" <<EOF2
server { listen 18443 ssl http2; server_name 127.0.0.1;
  ssl_certificate $TMP/cert.pem; ssl_certificate_key $TMP/key.pem;
  location / { return 200 "ip ok"; } }
EOF2
enable ip-site
"$NGINX" -p "$TMP" -c "$TMP/nginx.conf" -s reload 2>/dev/null; sleep 0.5
curl --noproxy '*' -sk -o /dev/null --max-time 5 https://127.0.0.1:18443/; RC=$?
[ "$RC" = 35 ]; ck $? "documented exception: an https site served by bare IP is refused too (curl exit $RC) — the install check greps for one"
IPGREP='server_name[^;]*[[:space:]]([0-9]{1,3}\.){3}[0-9]{1,3}'
printf 'server { server_name ip-too.test 127.0.0.1; }\n' > "$TMP/ip-second"
grep -qE "$IPGREP" "$TMP/sites-available/ip-site" && grep -qE "$IPGREP" "$TMP/ip-second" && ! grep -qE "$IPGREP" "$TMP/sites-available/trip-a" && grep -qF "$IPGREP" "$CONF"
ck $? "…and the install check's grep (as written in the file) finds an IP anywhere in server_name, and not a named site"
rm -f "$TMP/sites-enabled/ip-site" "$TMP/sites-available/ip-site"; "$NGINX" -p "$TMP" -c "$TMP/nginx.conf" -s reload 2>/dev/null; sleep 0.3

cp "$TMP/sites-available/000-catch-all" "$TMP/sites-available/zzz-second-default"; enable zzz-second-default
OUT="$("$NGINX" -t -p "$TMP" -c "$TMP/nginx.conf" 2>&1)"; RC=$?
[ "$RC" != 0 ] && printf '%s' "$OUT" | grep -q "duplicate default server"; ck $? "a second default_server on the same port fails nginx -t (\"duplicate default server\") — check before installing"
rm -f "$TMP/sites-enabled/zzz-second-default" "$TMP/sites-available/zzz-second-default"

# ── the header's pre-install commands, exactly as written ─────────────────────
# Taken from the comment lines of the file under test; /etc/nginx is swapped
# for a server-shaped tree (files in sites-available, symlinks in
# sites-enabled, a conf.d) that does NOT have the catch-all yet. A header line
# is only run when it is EXACTLY one of the three commands below (so a
# doctored copy can't run anything else); change both together.
EXP1="grep -RnE --exclude='.*' '^[^#]*listen[^;]*[[:space:]]default(_server)?([[:space:];]|\$)' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/"
EXP2="grep -RnE --exclude='.*' '^[^#]*server_name[^;]*[[:space:]]([0-9]{1,3}\.){3}[0-9]{1,3}' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/"
EXP3='echo "files read: $(grep -Rc --exclude='"'"'.*'"'"' '"'"''"'"' /etc/nginx/sites-enabled/ | wc -l) of $(ls /etc/nginx/sites-enabled/ | wc -l)"'
CMDS="$(sed -n 's/^#[[:space:]]*\(grep -.*\)$/\1/p' "$CONF")"
C1="$(printf '%s\n' "$CMDS" | sed -n 1p)"; C2="$(printf '%s\n' "$CMDS" | sed -n 2p)"
C3="$(sed -n 's/^#[[:space:]]*\(echo "files read: .*\)$/\1/p' "$CONF" | head -1)"
[ -n "$C1" ] && [ -n "$C2" ] && [ -n "$C3" ]; ck $? "the header lists the three pre-install commands (two checks + a files-read proof line)"
safe() { [ "$1" = "$EXP1" ] || [ "$1" = "$EXP2" ] || [ "$1" = "$EXP3" ]; }
safe "$C1" && safe "$C2" && safe "$C3"; ck $? "…and they are exactly the three commands this rehearsal proves (nothing else gets run)"
grep -q 'not 0' "$CONF"; ck $? "…and the header says the proof count must not be 0 (0 of 0 = ran without the folders)"
PRE="$TMP/pre"; mkdir -p "$PRE/sites-available" "$PRE/sites-enabled" "$PRE/conf.d"
pre_site() { printf '%s\n' "$2" > "$PRE/sites-available/$1"; ln -s "$PRE/sites-available/$1" "$PRE/sites-enabled/$1"; }
run_doc() { safe "$1" || return 0; eval "${1//\/etc\/nginx/$PRE}" 2>/dev/null; }
pre_site trip-a 'server { listen 80; server_name trip-a.test; }'
pre_site trip-b 'server { listen 443 ssl http2; server_name trip-b.test; }'
pre_site upstreams 'upstream app_b { server 127.0.0.1:3999; }'
printf 'server { listen 80 default_server; server_name 10.0.0.7; }\n' > "$PRE/sites-enabled/.trip-a.swp"
[ -L "$PRE/sites-enabled/trip-a" ]; ck $? "the test layout really uses symlinks in sites-enabled (like the server)"
[ -z "$(run_doc "$C1")" ] && [ -z "$(run_doc "$C2")" ]; ck $? "clean layout (+ a hidden editor file nginx never loads): both checks print nothing"
[ "$(run_doc "$C3")" = "files read: 3 of 3" ]; ck $? "clean layout: the proof line counts every file nginx loads, even one with no server_name (\"$(run_doc "$C3")\")"
ln -s "$PRE/sites-available/gone" "$PRE/sites-enabled/gone"
[ "$(run_doc "$C3")" = "files read: 3 of 4" ]; ck $? "a broken symlink shows up as one short (\"$(run_doc "$C3")\")"
rm -f "$PRE/sites-enabled/gone"
pre_site old-default 'server { listen 80 default_server; server_name old.test; }'
run_doc "$C1" | grep -q old-default; ck $? "check 1 finds another default_server behind a symlink"
[ -z "$(grep -rn --exclude='.*' default_server "$PRE/sites-enabled/" 2>/dev/null)" ]; ck $? "…which plain grep -r would miss (symlinks skipped — why the header says -R)"
rm -f "$PRE/sites-enabled/old-default"
pre_site older-default 'server { listen 8081 default; server_name older.test; }'
run_doc "$C1" | grep -q older-default; ck $? "check 1 also finds the older \"listen … default\" spelling"
rm -f "$PRE/sites-enabled/older-default"
pre_site commented 'server { listen 80; server_name c.test; # listen 80 default_server;
  # listen 443 ssl default_server; # server_name 10.0.0.6;
}'
[ -z "$(run_doc "$C1")" ] && [ -z "$(run_doc "$C2")" ]; ck $? "commented-out default_server / IP lines (as in Ubuntu's stock site) are not reported"
rm -f "$PRE/sites-enabled/commented"
printf 'server { listen 80 default_server; server_name conf-d.test; }\n' > "$PRE/conf.d/x.conf"
run_doc "$C1" | grep -q conf.d/x.conf; ck $? "check 1 looks in conf.d too"
rm -f "$PRE/conf.d/x.conf"
pre_site by-ip 'server { listen 443 ssl; server_name 10.0.0.9; }'
run_doc "$C2" | grep -q by-ip; ck $? "check 2 finds a bare-IP site behind a symlink"
printf 'server { listen 443 ssl; server_name 10.0.0.8; }\n' > "$PRE/conf.d/y.conf"
run_doc "$C2" | grep -q conf.d/y.conf; ck $? "check 2 looks in conf.d too"
rm -f "$PRE/conf.d/y.conf"
! sed -n 's/^#[[:space:]]*grep //p' "$CONF" | tr ' ' '\n' | grep -qE '^-[A-Za-z]*r|^--recursive$|^--directories=recurse'
ck $? "no pre-install command in the header uses a non-following recursive grep (-r, --recursive)"

echo "RESULT: $PASS PASS, $FAIL FAIL"
exit "$FAIL"
