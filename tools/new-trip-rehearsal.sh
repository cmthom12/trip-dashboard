#!/usr/bin/env bash
# tools/new-trip-rehearsal.sh — LOCAL rehearsal of deploy/new-trip.sh without a
# droplet. Same conventions as tools/sso-rehearsal.sh / profile-rehearsal.sh:
# a PASS/FAIL row per assertion, non-zero exit on any failure, trap cleanup,
# Git-Bash-safe.
#
# WHY THIS EXISTS
# new-trip.sh is the script that runs when a family is waiting for their trip
# URL, late, by a tired operator. Its refusals (dirty tree, taken port, name in
# use, bad DNS, bad trip JSON) and its no-half-apply promise (a failed nginx
# test leaves no enabled site) have to be proven BEFORE it is pointed at the
# real droplet — a failed real run burns a certbot quota and leaves a mess.
#
# HOW IT WORKS
# The WORKING TREE is stamped into a scratch git repo (so the dirty-tree and
# not-on-main refusals are exercised against a throwaway repo, never yours) and
# new-trip.sh runs from there with:
#   NEW_TRIP_REMOTE_SHELL="bash -c"     its "remote" commands run locally
#   TRIPS_ROOT/NGINX_DIR/WEBROOT/LE_DIR  pointed into a fake root under $TMP
#   PATH=$FAKE/bin:$PATH                shims for ssh scp npm pm2 ss getent
#                                        hostname nginx systemctl certbot curl
# deploy/deploy.sh runs UNMODIFIED under the same shims. The pm2 shim really
# boots `node server.js` from the ecosystem file's env (cached across a by-name
# restart, like real pm2), so the health gate, the CORS-header check and the
# /api/sso 404 are real HTTP answers, not mocks. Ports 3801-3809 are the band.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BSQ="$ROOT/node_modules/better-sqlite3"
PASS=0; FAIL=0
declare -a ROWS
ck() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); ROWS+=("PASS  $2"); else FAIL=$((FAIL+1)); ROWS+=("FAIL  $2")
  [ "${DEBUG:-0}" = 1 ] && [ -f "${OUT:-}" ] && { echo "---- FAIL: $2 — last output:"; tail -25 "$OUT" | sed 's/^/    | /'; }; fi; }
IS_MSYS=0; case "$(uname -s)" in MINGW*|MSYS*) IS_MSYS=1 ;; esac

[ -d "$BSQ" ] || { echo "FATAL: $BSQ missing — run npm install first." >&2; exit 1; }
for p in 3804 3805; do
  if netstat -ano 2>/dev/null | grep ":$p " | grep -q LISTENING; then echo "FATAL: port $p busy — aborting before setup." >&2; exit 1; fi
done
REAL_CURL="$(command -v curl)"

TMP="$(mktemp -d)"; REPO="$TMP/repo"; FAKE="$TMP/fake"
TRIPS="$FAKE/trips"; NGX="$FAKE/nginx"; WEBROOT="$FAKE/webroot"; LE="$FAKE/letsencrypt"; BIN="$FAKE/bin"; PM2D="$FAKE/pm2"
OUT="$TMP/out.txt"
cleanup() {
  for f in "$PM2D"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
  sleep 1
  if [ "$IS_MSYS" = 1 ]; then  # belt and braces: nothing of ours may stay listening on the band ports
    for p in 3804 3805; do pid="$(netstat -ano 2>/dev/null | grep ":$p " | grep LISTENING | awk '{print $5}' | head -1)"
      [ -n "$pid" ] && taskkill //PID "$pid" //F >/dev/null 2>&1; done
  fi
  for d in "$TRIPS"/*/; do
    [ -e "${d}node_modules" ] || continue
    if [ "$IS_MSYS" = 1 ]; then cmd //c rmdir "$(cygpath -w "${d}node_modules")" >/dev/null 2>&1; else rm -f "${d}node_modules"; fi
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

# ── the scratch repo (working tree, tracked files only, then git init on main) ──
echo "==> stamping the working tree into a scratch repo on main"
mkdir -p "$REPO" "$TRIPS/alpha" "$TRIPS/beta" "$NGX/sites-available" "$NGX/sites-enabled" "$WEBROOT" "$LE/live" "$BIN" "$PM2D"
(cd "$ROOT" && git ls-files -co --exclude-standard > "$TMP/files.txt" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -x -C "$REPO"
(cd "$REPO" && git init -q -b main . && git add --pathspec-from-file="$TMP/files.txt" \
  && git -c user.name=rehearsal -c user.email=r@example.com commit -q -m "stamp") 2>/dev/null
[ -z "$(cd "$REPO" && git status --porcelain)" ] && [ "$(cd "$REPO" && git rev-parse --abbrev-ref HEAD)" = main ]
ck $? "scratch repo stamped from the WORKING TREE: clean, on main"
cat > "$REPO/deploy/deploy.local.env" <<EOF
SERVER="root@203.0.113.10"
SSH_KEY="$TMP/fake.key"
PUBLIC_SUFFIX="trips.test"
CERT_EMAIL="rehearsal@example.com"
PORT_BAND_MIN="3801"
PORT_BAND_MAX="3809"
PORT_RESERVED="3803"
EOF
printf 'alpha  %s/alpha  3801\n' "$TRIPS" > "$REPO/deploy/instances.local.conf"
printf 'PORT=3801\nCORS_ORIGIN=https://alpha.trips.test\n' > "$TRIPS/alpha/.env"   # existing instance: its .env is a port source
: > "$TRIPS/beta/.keep"                                                            # a dir with no row: "exists remotely"
[ -z "$(cd "$REPO" && git status --porcelain)" ]; ck $? "fake deploy.local.env + instances.local.conf are gitignored (tree still clean)"
printf 'gamma.trips.test 203.0.113.10\nepsilon.trips.test 203.0.113.10\nzeta.trips.test 203.0.113.10\nwrong.trips.test 198.51.100.7\n' > "$FAKE/dns.txt"

# ── shims ────────────────────────────────────────────────────────────────────
LOG="$TMP/calls.log"   # outside $FAKE: the dry-run hash must not see shim call logging
cat > "$BIN/ssh" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift   # host
exec bash -c "$*"
EOF
cat > "$BIN/scp" <<'EOF'
#!/usr/bin/env bash
SRC=(); while [ $# -gt 0 ]; do case "$1" in -i) shift 2 ;; -*) shift ;; *) SRC+=("$1"); shift ;; esac; done
DEST="${SRC[${#SRC[@]}-1]}"; DEST="${DEST#*:}"; unset 'SRC[-1]'
exec cp -r "${SRC[@]}" "$DEST"
EOF
cat > "$BIN/npm" <<EOF
#!/usr/bin/env bash
echo "npm \$* (cwd \$PWD)" >> "$LOG"
[ -e node_modules ] && exit 0
if [ "$IS_MSYS" = 1 ]; then powershell -NoProfile -Command "New-Item -ItemType Junction -Path '\$(cygpath -w "\$PWD/node_modules")' -Target '$(cygpath -w "$ROOT/node_modules")' | Out-Null"
else ln -s "$ROOT/node_modules" node_modules; fi
EOF
cat > "$BIN/pm2" <<EOF
#!/usr/bin/env bash
# fake pm2: state in $PM2D. start/reload take an ECOSYSTEM FILE and read its env
# through the real template; restart by NAME reuses the cached env (like pm2).
S="$PM2D"; echo "pm2 \$* (cwd \$PWD)" >> "$LOG"
spawn() { # spawn <name>  (env from \$S/<name>.env, cwd from \$S/<name>.cwd)
  local cwd; cwd="\$(cat "\$S/\$1.cwd")"; mapfile -t E < "\$S/\$1.env"
  (cd "\$cwd" && export "\${E[@]}" && exec node server.js >> pm2.log 2>&1) & echo \$! > "\$S/\$1.pid"   # exec: \$! IS node's pid
  local port; port="\$(sed -n 's/^PORT=//p' "\$S/\$1.env")"
  for _ in \$(seq 1 40); do "$REAL_CURL" -s "http://127.0.0.1:\$port/api/health" | grep -q '"status":"ok"' && return 0; sleep 0.5; done
  echo "fake pm2: \$1 never became healthy on :\$port" >&2; return 1
}
stop() { [ -f "\$S/\$1.pid" ] && kill "\$(cat "\$S/\$1.pid")" 2>/dev/null; sleep 1; }
case "\$1" in
  jlist) printf '['; for f in "\$S"/*.cwd; do [ -f "\$f" ] && printf '{"name":"%s"},' "\$(basename "\${f%.cwd}")"; done; printf '{}]\n' ;;
  start|reload)
    if [ ! -f "\$2" ] || [[ "\$2" != *ecosystem.config.js ]]; then
      echo "SHIM VIOLATION: pm2 \$1 '\$2' is not an ecosystem file path" | tee -a "$LOG" >&2; exit 1; fi
    N="\$(node -e 'process.stdout.write(require(process.argv[1]).apps[0].name)' "\$PWD/\$2")" || exit 1
    node -e 'const e=require(process.argv[1]).apps[0].env; for (const k in e) console.log(k+"="+e[k])' "\$PWD/\$2" > "\$S/\$N.env"
    echo "\$PWD" > "\$S/\$N.cwd"; stop "\$N"; spawn "\$N" ;;
  restart) [ -f "\$S/\$2.cwd" ] || { echo "[PM2][ERROR] Process or Namespace \$2 not found" >&2; exit 1; }; stop "\$2"; spawn "\$2" ;;
  delete)  stop "\$2"; rm -f "\$S/\$2".{cwd,env,pid} ;;
  save)    touch "\$S/dump.pm2" ;;
  *) echo "fake pm2: unhandled '\$*'" >&2; exit 1 ;;
esac
EOF
cat > "$BIN/ss" <<'EOF'
#!/usr/bin/env bash
printf 'LISTEN 0 511 0.0.0.0:3802 0.0.0.0:*\nLISTEN 0 511 [::]:22 [::]:*\n'
EOF
cat > "$BIN/getent" <<EOF
#!/usr/bin/env bash
awk -v h="\$2" '\$1 == h { print \$2 " STREAM " h }' "$FAKE/dns.txt"
EOF
printf '#!/usr/bin/env bash\necho "203.0.113.10 10.10.0.5"\n' > "$BIN/hostname"
cat > "$BIN/nginx" <<EOF
#!/usr/bin/env bash
echo "nginx \$*" >> "$LOG"
[ -e "$FAKE/nginx-fail" ] && { echo "nginx: [emerg] injected failure" >&2; echo "nginx: configuration file test failed" >&2; exit 1; }
for e in "$NGX"/sites-enabled/*; do  # like real nginx: a site whose cert files are missing fails the test
  [ -f "\$e" ] || continue
  s="$NGX/sites-available/\$(basename "\$e")"; [ -f "\$s" ] || s="\$e"   # MSYS: ln -s is a copy, so read the real site
  for c in \$(sed -n 's/^ *ssl_certificate\(_key\)\? *\([^;]*\);/\2/p' "\$s"); do [ -f "\$c" ] || { echo "nginx: [emerg] cannot load certificate \$c" >&2; exit 1; }; done
done
echo "nginx: configuration file test is successful"
EOF
printf '#!/usr/bin/env bash\necho "systemctl $*" >> "%s"\n' "$LOG" > "$BIN/systemctl"
cat > "$BIN/certbot" <<EOF
#!/usr/bin/env bash
echo "certbot \$*" >> "$LOG"
[ -e "$FAKE/certbot-fail" ] && { echo "certbot: injected failure" >&2; exit 1; }
D=""; W=""; while [ \$# -gt 0 ]; do case "\$1" in -d) D="\$2"; shift 2 ;; -w) W="\$2"; shift 2 ;; *) shift ;; esac; done
[ -d "\$W/.well-known/acme-challenge" ] || { echo "certbot: webroot \$W has no acme-challenge dir" >&2; exit 1; }
mkdir -p "$LE/live/\$D" && touch "$LE/live/\$D/fullchain.pem" "$LE/live/\$D/privkey.pem"
EOF
cat > "$BIN/curl" <<EOF
#!/usr/bin/env bash
# https://<host>/... is answered through the fake nginx: find the enabled site
# for that server_name and hit its proxy_pass port. Everything else is real curl.
A=(); for a in "\$@"; do
  if [[ "\$a" == https://* ]]; then
    h="\${a#https://}"; h="\${h%%/*}"; p="\${a#https://\$h}"
    site=""; for e in "$NGX"/sites-enabled/*; do   # enabled entry -> its sites-available file (MSYS: ln -s is a copy)
      s="$NGX/sites-available/\$(basename "\$e")"; [ -f "\$s" ] || s="\$e"
      grep -q "server_name \$h;" "\$s" 2>/dev/null && { site="\$s"; break; }; done
    [ -n "\$site" ] || { echo "fake curl: no enabled site for \$h" >&2; exit 6; }
    port="\$(sed -n 's/.*proxy_pass http:\/\/127.0.0.1:\([0-9]*\);.*/\1/p' "\$site" | head -1)"
    [ -n "\$port" ] || { echo "fake curl: site for \$h has no proxy_pass" >&2; exit 7; }
    a="http://127.0.0.1:\$port\$p"
  fi; A+=("\$a"); done
exec "$REAL_CURL" "\${A[@]}"
EOF
chmod +x "$BIN"/*
ck 0 "shims written: ssh scp npm pm2 ss getent hostname nginx systemctl certbot curl"

# ── helpers ──────────────────────────────────────────────────────────────────
nt() { # nt <args...>  → runs new-trip.sh from the scratch repo; sets RC, output in $OUT
  (cd "$REPO" && PATH="$BIN:$PATH" NEW_TRIP_REMOTE_SHELL="bash -c" TRIPS_ROOT="$TRIPS" NGINX_DIR="$NGX" \
     WEBROOT="$WEBROOT" LE_DIR="$LE" bash deploy/new-trip.sh "$@" > "$OUT" 2>&1 < /dev/null); RC=$?
}
has() { grep -qF -- "$1" "$OUT"; }
snap() { # snap → one hash over every file (content + listing) in the fake root and the scratch repo (minus .git)
  { (cd "$FAKE" && find . -type f -print0 | sort -z | xargs -0 sha256sum; find . | sort)
    (cd "$REPO" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; find . -path ./.git -prune -o -print | sort); } | sha256sum
}
node -e '
const fs=require("fs"); const h=fs.readFileSync(process.argv[1],"utf8");
const T="<script type=\"application/json\" id=\"trip-data\">"; const i=h.indexOf(T)+T.length, j=h.indexOf("</"+"script>",i);
const t=JSON.parse(h.slice(i,j)); t.tripName="Rehearsal Trip"; fs.writeFileSync(process.argv[2], JSON.stringify(t));
' "$ROOT/public/index.html" "$TMP/good.json"
printf '{"tripName":"broken","family":"not-an-array","days":[]}' > "$TMP/bad.json"

# ── --dry-run: complete plan, zero side effects ──────────────────────────────
echo "==> dry-run"
S0="$(snap)"
nt gamma --dry-run
[ "$RC" = 0 ]; ck $? "gamma --dry-run exits 0"
[ "$(snap)" = "$S0" ]; ck $? "--dry-run wrote NOTHING (fake root + scratch repo hash unchanged)"
has "PLAN for 'gamma'" && has "port 3804" && has "gamma.trips.test" && has "dry-run: nothing was changed"
ck $? "plan names the host, the chosen port (3804) and says nothing changed"
has "3801  instances.local.conf" && has "3802  listening" && has "3803  reserved"
ck $? "auto-select skipped 3801 (conf row), 3802 (listening on the droplet), 3803 (PORT_RESERVED) — and said why"
has "deploy.sh gamma" && has "pm2 start ecosystem.config.js && pm2 save" && has "certbot certonly --webroot" && has "sites-available/gamma"
ck $? "plan lists deploy.sh, pm2 start BY FILE, certbot webroot and the nginx site file"
[ "$(grep -c 'new-env.sh' "$OUT")" -ge 1 ] && ! grep -q 'PIN_PEPPER=[0-9a-f]' "$OUT"
ck $? "plan uses new-env.sh and prints no secret"

# ── refusals (every one must leave the world untouched) ─────────────────────
echo "==> refusals"
touch "$REPO/scratch.txt"; nt gamma --dry-run; RC1=$RC; D1=$(has "not clean" && has "scratch.txt"; echo $?); rm -f "$REPO/scratch.txt"
[ "$RC1" != 0 ] && [ "$D1" = 0 ]; ck $? "dirty working tree is refused, naming the file"
(cd "$REPO" && git checkout -q -b other); nt gamma --dry-run; RC1=$RC; D1=$(has "not main"; echo $?); (cd "$REPO" && git checkout -q main)
[ "$RC1" != 0 ] && [ "$D1" = 0 ]; ck $? "a not-on-main checkout is refused"
BAD=0; for n in "bad name" "UPPER" "a" "this-name-is-far-too-long" "../etc" "-lead" "trail-"; do
  nt "$n" --dry-run; { [ "$RC" != 0 ] && { has "invalid name" || has "unknown option"; }; } || BAD=$((BAD+1)); done
[ "$BAD" = 0 ]; ck $? "invalid names refused: spaces, uppercase, 1 char, >20 chars, ../, leading/trailing hyphen"
nt alpha --yes; [ "$RC" != 0 ] && has "already has a row"; ck $? "a name with an instances.local.conf row is refused (even with --yes)"
nt beta --yes;  [ "$RC" != 0 ] && has "already exists on the droplet" && has "dir $TRIPS/beta"
ck $? "a name whose remote dir exists is refused, naming what was found"
nt gamma --port 3801 --dry-run; [ "$RC" != 0 ] && has "port 3801 is instances.local.conf"; ck $? "--port on a conf-row port is refused"
nt gamma --port 3802 --dry-run; [ "$RC" != 0 ] && has "port 3802 is listening";             ck $? "--port on a listening port is refused"
nt gamma --port 3803 --dry-run; [ "$RC" != 0 ] && has "port 3803 is reserved";              ck $? "--port on a PORT_RESERVED port is refused as reserved"
nt gamma --port 3805 --dry-run; [ "$RC" = 0 ] && has "port 3805" && has "requested with --port"; ck $? "--port on a free port is accepted"
nt wrong --dry-run; [ "$RC" != 0 ] && has "type A   name wrong   value 203.0.113.10" && has "DNS-only"
ck $? "DNS pointing elsewhere is refused with the exact record to create"
nt delta --dry-run; [ "$RC" != 0 ] && has "resolves to [nothing]"; ck $? "DNS not resolving is refused"
nt gamma --yes --trip-json "$TMP/bad.json"; [ "$RC" != 0 ] && has "failed validation" && has "nothing was created"
ck $? "a trip JSON that fails the validator is refused"
nt gamma --yes --trip-json "$TMP/no-such.json"; [ "$RC" != 0 ] && has "not found"; ck $? "a missing trip JSON path is refused"
nt gamma; [ "$RC" != 0 ] && has "rerun with --yes"; ck $? "no --yes and no terminal: refuses instead of guessing"
[ "$(snap)" = "$S0" ]; ck $? "after every refusal the fake root + scratch repo are byte-identical to the start"

# ── the full run ─────────────────────────────────────────────────────────────
echo "==> full run: gamma --yes --trip-json"
: > "$LOG"
nt gamma --yes --trip-json "$TMP/good.json"
[ "$RC" = 0 ]; ck $? "gamma --yes --trip-json exits 0"
[ "$RC" = 0 ] || sed 's/^/    | /' "$OUT" | tail -40
APP="$TRIPS/gamma"
MODE="$(stat -c '%a' "$APP/.env" 2>/dev/null)"
[ -f "$APP/.env" ] && { [ "$MODE" = 600 ] || [ "$IS_MSYS" = 1 ]; } && grep -q "chmod 600 '$APP/.env'" "$OUT"
ck $? ".env exists, chmod 600 was issued (mode now $MODE$([ "$IS_MSYS" = 1 ] && echo '; MSYS reports ACL-derived modes, exact on Linux'))"
grep -q '^PORT=3804$' "$APP/.env" && grep -q '^CORS_ORIGIN=https://gamma.trips.test$' "$APP/.env" \
  && grep -Eq '^PIN_PEPPER=[0-9a-f]{48}$' "$APP/.env" && grep -q '^ADMIN_KEY=$' "$APP/.env"
ck $? ".env: PORT=3804, CORS_ORIGIN=https://gamma.trips.test, 48-hex PIN_PEPPER, ADMIN_KEY left for sync-admin-key.sh"
grep -q "^const NAME = 'gamma';" "$APP/ecosystem.config.js"; ck $? "ecosystem.config.js NAME is 'gamma'"
T_KEYS="$(grep -oE '^ +[A-Z_]+:' "$ROOT/deploy/ecosystem.template.config.js" | sort)"
A_KEYS="$(grep -oE '^ +[A-Z_]+:' "$APP/ecosystem.config.js" | sort)"
[ -n "$T_KEYS" ] && [ "$T_KEYS" = "$A_KEYS" ]; ck $? "ecosystem env block carries every key the template has ($(echo "$T_KEYS" | wc -l) keys)"
[ "$(diff --strip-trailing-cr "$ROOT/deploy/ecosystem.template.config.js" "$APP/ecosystem.config.js" | grep -c '^>')" = 1 ]
ck $? "…and differs from the template in exactly one line (wholesale copy, not hand-written)"
grep -q "^gamma  $APP  3804$" "$REPO/deploy/instances.local.conf"; ck $? "instances.local.conf gained the row 'gamma <dir> 3804'"
grep -q "pm2 start ecosystem.config.js (cwd $APP)" "$LOG" && grep -q "pm2 save" "$LOG" && ! grep -q "SHIM VIOLATION" "$LOG"
ck $? "pm2 start was BY ECOSYSTEM FILE from the app dir, then pm2 save; never by name"
[ "$(grep -c 'pm2 restart trip-gamma' "$LOG")" = 2 ]; ck $? "deploy.sh ran twice: pass 1 (expected restart failure) + pass 2 (health gate)"
has "expected first-deploy case"; ck $? "…and the run explained the expected pass-1 failure"
has "Trip data installed into public/index.html"; ck $? "apply-trip-data.js ran on the fresh instance"
[ -f "$NGX/sites-available/gamma" ] && grep -q "server_name gamma.trips.test;" "$NGX/sites-available/gamma" \
  && grep -q "proxy_pass http://127.0.0.1:3804;" "$NGX/sites-available/gamma" && grep -q "$LE/live/gamma.trips.test/fullchain.pem" "$NGX/sites-available/gamma"
ck $? "nginx site: server_name, proxy_pass :3804 and the cert path are filled in"
if [ "$IS_MSYS" = 1 ]; then [ -e "$NGX/sites-enabled/gamma" ] && grep -q "server_name gamma.trips.test;" "$NGX/sites-enabled/gamma"
  ck $? "nginx site enabled as available+enabled pair (MSYS: ln -s is emulated as a copy, so -L is not testable here)"
else [ -L "$NGX/sites-enabled/gamma" ]; ck $? "nginx site enabled as a symlink into sites-enabled"; fi
[ "$(grep -c 'nginx -t' "$LOG")" -ge 2 ] && [ "$(grep -c 'systemctl reload nginx' "$LOG")" -ge 2 ]
ck $? "nginx -t ran before each reload (stub phase + HTTPS phase)"
grep -q "certbot certonly --webroot -w $WEBROOT -d gamma.trips.test --email rehearsal@example.com" "$LOG"
ck $? "certbot: certonly, webroot, the hostname, the configured email"
CODE="$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3804/api/sso)"; [ "$CODE" = 404 ]
ck $? "the live instance answers /api/sso 404 (no FAMILY_SSO_SECRET yet)"
"$REAL_CURL" -s -i http://127.0.0.1:3804/api/health | tr -d '\r' | grep -qi '^access-control-allow-origin: https://gamma.trips.test$'
ck $? "…and pins CORS to https://gamma.trips.test (.env -> ecosystem allowlist -> process, for real)"
has "DONE: 'gamma' is live" && has "sync-admin-key.sh" && has "pm2 reload ecosystem.config.js" \
  && has "sync-sso-secret.sh --only gamma" && has "instances.local.conf already has the row" && has "backup-all.sh"
ck $? "next-steps block: sync-admin-key (+ by-file reload), sync-sso-secret --only, the conf row, backups"
! grep -q 'PIN_PEPPER=[0-9a-f]' "$OUT"; ck $? "no secret was echoed anywhere in the run output"

echo "==> rerun after success"
S1="$(snap)"
nt gamma --yes; [ "$RC" != 0 ] && has "already has a row"; ck $? "rerunning a finished stand-up is refused"
[ "$(snap)" = "$S1" ]; ck $? "…and modified nothing"

# ── failure injected at the nginx step ──────────────────────────────────────
echo "==> nginx failure injection: epsilon"
touch "$FAKE/nginx-fail"
nt epsilon --yes
rm -f "$FAKE/nginx-fail"
[ "$RC" != 0 ]; ck $? "epsilon --yes fails when nginx -t fails"
[ ! -e "$NGX/sites-enabled/epsilon" ] && [ ! -e "$NGX/sites-available/epsilon" ]
ck $? "…no enabled (or available) site is left behind"
has "removed $NGX/sites-available/epsilon" && has "previous config restored"; ck $? "…and it said it restored the previous nginx config"
has "FAILED" && has "Already done:" && has "pm2 process trip-epsilon started" && has "To unwind by hand"
ck $? "…failure report lists what was already done and how to unwind"
[ "$(grep -c '^epsilon ' "$REPO/deploy/instances.local.conf")" = 1 ]; ck $? "…the conf row was added once"
nt epsilon --yes; [ "$RC" != 0 ] && has "already has a row"
ck $? "rerun after the failure is refused clearly (the row exists) instead of compounding"
sed -i '/^epsilon /d' "$REPO/deploy/instances.local.conf"   # operator removes the row, as the unwind text says
nt epsilon --yes; [ "$RC" != 0 ] && has "already exists on the droplet" && has "dir $TRIPS/epsilon" && has "pm2 process trip-epsilon"
ck $? "…and with the row gone it still refuses, naming the leftover dir + pm2 process (nothing compounds)"

echo
echo "== new-trip-rehearsal summary =="
printf '%s\n' "${ROWS[@]}"
echo "--------------------------------"
echo "RESULT: $PASS PASS, $FAIL FAIL"
exit $FAIL
