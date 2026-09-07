#!/usr/bin/env bash
# deploy/new-trip.sh — stand up a NEW trip instance on the droplet in one command.
# Run FROM your laptop (Git Bash on Windows or any POSIX shell), repo root clean
# and on main, exactly like deploy/deploy.sh:
#
#   deploy/new-trip.sh <name> [--port N] [--trip-json PATH] [--dry-run] [--yes]
#
# This is ASSEMBLY of the steps that already exist — deploy/new-env.sh for the
# .env, deploy/ecosystem.template.config.js for pm2, deploy/deploy.sh for the
# code, the nginx template + the certbot webroot flow from deploy/setup-https.sh
# — plus the preflight checks whose absence caused real incidents (a tar push
# that shipped sample data; a by-name pm2 restart that lost the env). It never
# targets an existing instance: every "already exists" check is a hard refusal,
# so tools/apply-trip-data.js can only ever run on a first deploy.
#
# Credentials + policy come from deploy/deploy.local.env (gitignored; see the
# .example): SERVER, SSH_KEY, PUBLIC_SUFFIX, CERT_EMAIL, optional PORT_BAND_MIN/
# PORT_BAND_MAX/PORT_RESERVED. The instance row is appended to
# deploy/instances.local.conf BEFORE deploy.sh runs — deploy.sh needs it.
#
# Rehearsal seams (tools/new-trip-rehearsal.sh; never set these for a real run):
#   TRIPS_ROOT / NGINX_DIR / WEBROOT / LE_DIR   remote layout overrides
#   NEW_TRIP_REMOTE_SHELL="bash -c"            run "remote" commands locally
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ME="new-trip"

usage() {
  cat <<'EOF'
Usage: deploy/new-trip.sh <name> [--port N] [--trip-json PATH] [--dry-run] [--yes]

  <name>            2-20 chars, lowercase letters/digits/hyphen. Becomes the app dir
                    <TRIPS_ROOT>/<name>, pm2 process trip-<name>, nginx site <name>,
                    and the hostname <name>.<PUBLIC_SUFFIX>.
  --port N          use this port (must be free, in the band, not reserved).
                    Default: lowest free port in PORT_BAND_MIN..PORT_BAND_MAX,
                    skipping ports in instances.local.conf, in any remote .env,
                    listening on the droplet, or listed in PORT_RESERVED.
  --trip-json PATH  install this trip with tools/apply-trip-data.js on this FIRST
                    deploy only (validated locally first with --data-only).
                    Without it the instance boots with the sample trip; import the
                    real one later through the admin console.
  --dry-run         print the whole plan (chosen port, hostname, every command and
                    file) and change nothing, locally or remotely.
  --yes             skip the confirmation prompt (e.g. after a --dry-run).
  -h, --help        this text.

Preflight (all read-only, all must pass): clean tree on main; name valid and
unused locally + remotely (dir, pm2, nginx site, server_name, cert); port free;
DNS for <name>.<PUBLIC_SUFFIX> points at the droplet; trip JSON validates;
deploy/deploy.local.env present with SERVER, SSH_KEY, PUBLIC_SUFFIX, CERT_EMAIL.

Then: mkdir -> new-env.sh (+PORT, CORS_ORIGIN) -> ecosystem.config.js -> row in
instances.local.conf -> deploy.sh (pass 1 lands the code; its pm2 restart is
EXPECTED to fail, the process does not exist yet) -> [apply-trip-data.js] ->
pm2 start ecosystem.config.js && pm2 save -> deploy.sh (pass 2, health gate) ->
nginx ACME stub -> certbot --webroot -> full nginx site -> verify (local health
+ version, CORS header, HTTPS health + version, /api/sso 404) -> next steps.
EOF
}

# ── arguments ────────────────────────────────────────────────────────────────
NAME=""; WANT_PORT=""; TRIP_JSON=""; DRY_RUN=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --port) WANT_PORT="${2:-}"; [ -n "$WANT_PORT" ] || { echo "$ME: --port needs a number" >&2; exit 2; }; shift 2 ;;
    --port=*) WANT_PORT="${1#--port=}"; shift ;;
    --trip-json) TRIP_JSON="${2:-}"; [ -n "$TRIP_JSON" ] || { echo "$ME: --trip-json needs a path" >&2; exit 2; }; shift 2 ;;
    --trip-json=*) TRIP_JSON="${1#--trip-json=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) YES=1; shift ;;
    -*) echo "$ME: unknown option '$1' (see --help)" >&2; exit 2 ;;
    *) [ -z "$NAME" ] || { echo "$ME: one instance name only (got '$NAME' and '$1')" >&2; exit 2; }; NAME="$1"; shift ;;
  esac
done
[ -n "$NAME" ] || { usage >&2; exit 2; }

die() { echo "$ME: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# ── credentials + policy (same file deploy.sh uses) ──────────────────────────
SERVER="root@YOUR_SERVER_IP"; SSH_KEY="$HOME/.ssh/YOUR_KEY"
PUBLIC_SUFFIX=""; CERT_EMAIL=""; PORT_BAND_MIN=3001; PORT_BAND_MAX=3009; PORT_RESERVED=""
TRIPS_ROOT="${TRIPS_ROOT:-/var/www/trips}"; NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
WEBROOT="${WEBROOT:-/var/www/letsencrypt}"; LE_DIR="${LE_DIR:-/etc/letsencrypt}"
[ -f "$HERE/deploy.local.env" ] || die "deploy/deploy.local.env not found — copy deploy/deploy.local.env.example, fill in SERVER, SSH_KEY, PUBLIC_SUFFIX, CERT_EMAIL."
. "$HERE/deploy.local.env"
case "$SERVER" in *YOUR_SERVER*|"") die "SERVER is still the placeholder in deploy/deploy.local.env" ;; esac
[ -n "$PUBLIC_SUFFIX" ] || die "PUBLIC_SUFFIX is not set in deploy/deploy.local.env (e.g. trips.example.com)"
[ -n "$CERT_EMAIL" ]    || die "CERT_EMAIL is not set in deploy/deploy.local.env (certbot needs a real address)"
CONF="$HERE/instances.local.conf"
[ -f "$CONF" ] || CONF="$HERE/instances.conf"
SSH="ssh -i ${SSH_KEY}"; SCP="scp -i ${SSH_KEY}"

remote() { # remote <script> — run on the droplet; under the rehearsal seam, locally
  if [ -n "${NEW_TRIP_REMOTE_SHELL:-}" ]; then $NEW_TRIP_REMOTE_SHELL "$1"; else $SSH "$SERVER" "$1"; fi
}
push() { # push <local file> <remote dir> — CRLF-normalized: a Windows checkout must not ship a \r into a bash script or .env
  if [ -n "${NEW_TRIP_REMOTE_SHELL:-}" ]; then tr -d '\r' < "$1" > "$2/$(basename "$1")"
  else tr -d '\r' < "$1" | $SSH "$SERVER" "cat > '$2/$(basename "$1")'"; fi
}

# ── derived names ────────────────────────────────────────────────────────────
PM2_NAME="trip-${NAME#trip-}"           # same rule as deploy.sh: no double trip- prefix
APP_DIR="$TRIPS_ROOT/$NAME"
HOST="$NAME.$PUBLIC_SUFFIX"
SITE="$NGINX_DIR/sites-available/$NAME"; LINK="$NGINX_DIR/sites-enabled/$NAME"
CERT_DIR="$LE_DIR/live/$HOST"
LOCAL_VER="$(cd "$ROOT" && node -p "require('./package.json').version")"

# ════════════════════════════════ PREFLIGHT ═══════════════════════════════════
say "preflight for '$NAME' -> $HOST (v$LOCAL_VER)"

# 1. repo state — deploy.sh ships the WORKING TREE, so dirty = shipping unreviewed code
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
[ "$BRANCH" = "main" ] || die "refusing: current branch is '$BRANCH', not main. deploy.sh ships the working tree; stand up new instances from main only."
DIRTY="$(git -C "$ROOT" status --porcelain)"
[ -z "$DIRTY" ] || die "refusing: working tree is not clean (deploy.sh ships the working tree — commit or stash first):"$'\n'"$DIRTY"

# 2. name validity + not already in use, locally and remotely
printf '%s' "$NAME" | grep -Eq '^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$' \
  || die "invalid name '$NAME': 2-20 chars, lowercase letters/digits/hyphen, no leading/trailing hyphen"
if tr -d '\r' < "$CONF" | awk -v n="$NAME" '$1 !~ /^#/ && NF >= 3 && $1 == n { f=1 } END { exit !f }'; then
  die "refusing: '$NAME' already has a row in ${CONF##*/} — this script never touches an existing instance. Code updates are: deploy/deploy.sh $NAME"
fi
EXISTS="$(remote "
[ -e '$APP_DIR' ] && echo 'dir $APP_DIR'
pm2 jlist 2>/dev/null | grep -q '\"name\":\"$PM2_NAME\"' && echo 'pm2 process $PM2_NAME'
[ -e '$SITE' ] && echo 'nginx site $SITE'
[ -e '$LINK' ] && echo 'nginx symlink $LINK'
grep -RlE 'server_name[^;]*(^|[ ,])$HOST([ ,;]|\$)' '$NGINX_DIR/sites-enabled' 2>/dev/null | sed 's/^/server_name $HOST already in /'
[ -e '$CERT_DIR' ] && echo 'certificate $CERT_DIR'
true")"
[ -z "$EXISTS" ] || die "refusing: '$NAME' already exists on the droplet — nothing was changed. Found:"$'\n'"$EXISTS"$'\n'"If this is a half-finished earlier run, unwind by hand (docs/MULTI_INSTANCE.md §ADD-A-TRIP rollbacks) and rerun."

# 3. port — taken = local conf rows + PORT= in every remote .env + anything listening
TAKEN="$(tr -d '\r' < "$CONF" | awk -v src="${CONF##*/}" '$1 !~ /^#/ && NF >= 3 { print $3 " " src }')"
REMOTE_PORTS="$(remote "
for d in '$TRIPS_ROOT'/*/; do [ -f \"\$d.env\" ] && p=\$(tr -d '\r' < \"\$d.env\" | sed -n 's/^PORT=//p' | head -1) && [ -n \"\$p\" ] && echo \"\$p \$(basename \"\$d\")/.env\"; done
ss -ltnH 2>/dev/null | awk '{print \$4}' | sed -n 's/.*:\([0-9]*\)\$/\1 listening/p'
true")"
TAKEN="$(printf '%s\n%s\n' "$TAKEN" "$REMOTE_PORTS" | awk 'NF >= 2')"
why_taken() { # why_taken <port> -> reason or empty
  local r; r="$(printf '%s\n' "$TAKEN" | awk -v p="$1" '$1 == p { $1=""; sub(/^ /,""); print; exit }')"
  if [ -n "$r" ]; then echo "$r"; return; fi
  for x in $PORT_RESERVED; do [ "$x" = "$1" ] && { echo "reserved (PORT_RESERVED in deploy.local.env)"; return; }; done
  return 0
}
if [ -n "$WANT_PORT" ]; then
  printf '%s' "$WANT_PORT" | grep -Eq '^[0-9]+$' || die "--port must be a number (got '$WANT_PORT')"
  R="$(why_taken "$WANT_PORT")"
  [ -z "$R" ] || die "refusing: port $WANT_PORT is $R"
  PORT="$WANT_PORT"; PORT_WHY="requested with --port, verified free"
else
  PORT=""; SKIPPED=""
  p="$PORT_BAND_MIN"
  while [ "$p" -le "$PORT_BAND_MAX" ]; do
    R="$(why_taken "$p")"
    if [ -z "$R" ]; then PORT="$p"; break; fi
    SKIPPED="$SKIPPED"$'\n'"    $p  $R"; p=$((p+1))
  done
  [ -n "$PORT" ] || die "no free port in $PORT_BAND_MIN..$PORT_BAND_MAX:$SKIPPED"$'\n'"Widen PORT_BAND_MAX in deploy.local.env or pass --port."
  PORT_WHY="lowest free in $PORT_BAND_MIN..$PORT_BAND_MAX"
  [ -z "$SKIPPED" ] || PORT_WHY="$PORT_WHY; skipped:$SKIPPED"
fi

# 4. DNS — resolved on the droplet, compared with the droplet's own addresses
DNS="$(remote "getent ahostsv4 '$HOST' 2>/dev/null | awk '{print \$1}' | sort -u | tr '\n' ' '; echo; hostname -I 2>/dev/null; true")"
RESOLVED="$(printf '%s\n' "$DNS" | sed -n '1p' | tr -s ' ')"
DROPLET_IPS="$(printf '%s\n' "$DNS" | sed -n '2p')"
IP_HINT="$(printf '%s' "${SERVER#*@}" | grep -Eo '^[0-9]+(\.[0-9]+){3}$' || printf '%s' "$DROPLET_IPS" | awk '{print $1}')"
DNS_OK=0
for ip in $RESOLVED; do for mine in $DROPLET_IPS; do [ "$ip" = "$mine" ] && DNS_OK=1; done; done
[ "$DNS_OK" = 1 ] || die "DNS: $HOST resolves to [${RESOLVED:-nothing}] but the droplet is [$DROPLET_IPS]. certbot would fail mid-run. Create the record first:"$'\n'"    type A   name $NAME   value $IP_HINT   (proxy: DNS-only / grey cloud)"$'\n'"then wait for it to resolve and rerun."

# 5. trip JSON — same pre-check apply-trip-data.js itself runs (--data-only; the
#    name lists get patched on the droplet, so cross-checking them here is noise)
if [ -n "$TRIP_JSON" ]; then
  [ -f "$TRIP_JSON" ] || die "--trip-json: '$TRIP_JSON' not found"
  VOUT="$(cd "$ROOT" && node tools/validate-trip-data.js "$TRIP_JSON" --data-only 2>&1)" \
    || die "trip JSON failed validation — nothing was created:"$'\n'"$VOUT"
  WARNS="$(printf '%s\n' "$VOUT" | grep '^⚠' || true)"
  [ -z "$WARNS" ] || echo "trip JSON warnings (not blocking):"$'\n'"$WARNS"
fi

# ═══════════════════════════ THE PLAN / THE RUN ═══════════════════════════════
# The same sequence runs twice: DRY=1 prints every command (the plan), DRY=0
# executes. Output shape stays identical so a --dry-run is an honest preview.
DRY=1
DONE=()
rr() { # rr <label> <remote script>
  if [ "$DRY" = 1 ]; then echo "  remote: $2" | sed '2,$s/^/          /'; else remote "$2"; DONE+=("$1"); fi
}
rl() { # rl <label> <local command...>
  if [ "$DRY" = 1 ]; then echo "  local:  ${*:2}"; else "${@:2}"; DONE+=("$1"); fi
}
rp() { # rp <label> <local file> <remote dir>
  if [ "$DRY" = 1 ]; then echo "  copy:   $2 -> droplet:$3/"; else push "$2" "$3"; fi
}
STAGE_CMD="mktemp -d /tmp/new-trip-$NAME.XXXXXX"
CODE_MARK="server.js package.json public/index.html tools/apply-trip-data.js node_modules/express"

stand_up() {
  local STAGE
  echo
  echo "PLAN for '$NAME'  (host $HOST, port $PORT, dir $APP_DIR, pm2 $PM2_NAME, v$LOCAL_VER)"
  echo "  port: $PORT_WHY"
  echo "  trip: ${TRIP_JSON:-sample trip (import the real one via the admin console later)}"
  echo
  say "7. app directory"
  rr "created $APP_DIR" "mkdir -p '$APP_DIR/public'"

  say "8. .env via deploy/new-env.sh (fresh PIN_PEPPER, chmod 600), then PORT + CORS_ORIGIN"
  if [ "$DRY" = 1 ]; then STAGE="<tmpdir>"; echo "  remote: $STAGE_CMD"; else STAGE="$(remote "$STAGE_CMD")"; fi
  rp "" "$HERE/new-env.sh" "$STAGE"; rp "" "$HERE/env.template" "$STAGE"
  rr "wrote $APP_DIR/.env (PIN_PEPPER generated; ADMIN_KEY empty until sync-admin-key.sh)" \
     "bash '$STAGE/new-env.sh' '$APP_DIR' '$STAGE/env.template' && umask 077 && sed -e 's|^PORT=.*|PORT=$PORT|' -e 's|^CORS_ORIGIN=.*|CORS_ORIGIN=https://$HOST|' '$APP_DIR/.env' > '$APP_DIR/.env.tmp' && cat '$APP_DIR/.env.tmp' > '$APP_DIR/.env' && rm -f '$APP_DIR/.env.tmp' && chmod 600 '$APP_DIR/.env' && grep -q '^PORT=$PORT\$' '$APP_DIR/.env' && grep -q '^CORS_ORIGIN=https://$HOST\$' '$APP_DIR/.env'"

  say "9. ecosystem.config.js = the template wholesale, NAME set (env block is an allowlist — never hand-written)"
  rp "" "$HERE/ecosystem.template.config.js" "$STAGE"
  rr "wrote $APP_DIR/ecosystem.config.js" \
     "sed \"s/^const NAME = '[^']*';/const NAME = '$NAME';/\" '$STAGE/ecosystem.template.config.js' > '$APP_DIR/ecosystem.config.js' && [ \"\$(diff '$STAGE/ecosystem.template.config.js' '$APP_DIR/ecosystem.config.js' | grep -c '^>')\" = 1 ] && grep -q \"^const NAME = '$NAME';\" '$APP_DIR/ecosystem.config.js'"

  say "9b. instance row -> deploy/instances.local.conf (deploy.sh reads it; the row is the local registry)"
  if [ "$DRY" = 1 ]; then echo "  local:  append '$NAME  $APP_DIR  $PORT' to deploy/instances.local.conf"
  else printf '%s  %s  %s\n' "$NAME" "$APP_DIR" "$PORT" >> "$HERE/instances.local.conf"; DONE+=("row added to deploy/instances.local.conf"); fi

  say "10. code via deploy/deploy.sh — pass 1 lands the files + npm install; its 'pm2 restart FAILED' is EXPECTED (no process yet)"
  if [ "$DRY" = 1 ]; then echo "  local:  deploy/deploy.sh $NAME   (expected to exit 1 at pm2 restart; then verify $CODE_MARK landed)"
  else
    if bash "$HERE/deploy.sh" "$NAME"; then die "deploy.sh pass 1 succeeded, which means pm2 process $PM2_NAME already existed — preflight said it did not. Stopping; inspect 'pm2 list' on the droplet."; fi
    MISSING="$(remote "cd '$APP_DIR' && for f in $CODE_MARK; do [ -e \"\$f\" ] || echo \"\$f\"; done; true")"
    [ -z "$MISSING" ] || die "deploy.sh pass 1 failed BEFORE the code landed (missing in $APP_DIR: $MISSING). Fix the deploy.sh error above and rerun."
    DONE+=("code + node_modules landed in $APP_DIR (deploy.sh pass 1)")
    echo "  (that pm2 restart failure was the expected first-deploy case — the process is created next)"
  fi

  if [ -n "$TRIP_JSON" ]; then
    say "12. trip data via tools/apply-trip-data.js — FIRST DEPLOY ONLY (no data.db, no process yet: both re-checked)"
    rp "" "$TRIP_JSON" "$STAGE"
    rr "trip installed into the app files (seeds data.db on first boot)" \
       "[ ! -e '$APP_DIR/data.db' ] || { echo 'REFUSING: $APP_DIR/data.db exists — apply-trip-data is first-deploy-only' >&2; exit 9; }; pm2 jlist 2>/dev/null | grep -q '\"name\":\"$PM2_NAME\"' && { echo 'REFUSING: pm2 process $PM2_NAME exists' >&2; exit 9; }; cd '$APP_DIR' && node tools/apply-trip-data.js '$STAGE/$(basename "$TRIP_JSON")'"
  fi

  say "11. pm2 start BY ECOSYSTEM FILE from the app dir, then pm2 save"
  rr "pm2 process $PM2_NAME started + saved" "cd '$APP_DIR' && pm2 start ecosystem.config.js && pm2 save"

  say "10b. deploy/deploy.sh again — restart + the version-checked health gate"
  rl "deploy.sh pass 2 (health gate passed)" bash "$HERE/deploy.sh" "$NAME"

  say "13. nginx: HTTP-only ACME stub site (the two-phase flow from setup-https.sh), available + symlink, nginx -t, reload"
  local STUB="server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT; default_type \"text/plain\"; allow all; }
    location / { return 200 \"ok\\n\"; }
}"
  local UNDO="rm -f '$LINK' '$SITE'; nginx -t && systemctl reload nginx; echo 'nginx: removed $SITE + symlink, previous config restored' >&2; exit 13"
  rr "nginx stub site $SITE enabled" \
     "mkdir -p '$WEBROOT/.well-known/acme-challenge' && printf '%s\n' '$STUB' > '$SITE' && ln -sf '$SITE' '$LINK' && { nginx -t || { $UNDO; }; } && systemctl reload nginx"

  say "14. certificate: certbot certonly --webroot (renews like every other site), then the full HTTPS site"
  rr "certificate issued for $HOST" \
     "certbot certonly --webroot -w '$WEBROOT' -d '$HOST' --email '$CERT_EMAIL' --agree-tos --non-interactive --deploy-hook 'systemctl reload nginx' && [ -f '$CERT_DIR/fullchain.pem' ]"
  rp "" "$HERE/nginx/trip-dashboard.conf.template" "$STAGE"
  rr "nginx HTTPS site $SITE live" \
     "sed -e 's|__SERVER_NAME__|$HOST|g' -e 's|__APP_PORT__|$PORT|g' -e 's|__WEBROOT__|$WEBROOT|g' -e 's|__CERT_DIR__|$CERT_DIR|g' '$STAGE/trip-dashboard.conf.template' > '$SITE' && { nginx -t || { $UNDO; }; } && systemctl reload nginx && rm -rf '$STAGE'"
}

verify() {
  say "15-17. verify (the exit code depends on these)"
  if [ "$DRY" = 1 ]; then
    echo "  remote: curl http://127.0.0.1:$PORT/api/health  -> 200, version $LOCAL_VER, Access-Control-Allow-Origin: https://$HOST"
    echo "  remote: curl https://$HOST/api/health           -> 200, version $LOCAL_VER"
    echo "  remote: curl http://127.0.0.1:$PORT/api/sso     -> 404 (FAMILY_SSO_SECRET unset until sync-sso-secret.sh)"
    return
  fi
  local V
  V="$(remote "curl -s -i --max-time 10 'http://127.0.0.1:$PORT/api/health'" || true)"
  printf '%s' "$V" | head -1 | grep -q ' 200' || die "VERIFY FAILED: local /api/health on :$PORT is not 200. pm2 logs $PM2_NAME"
  printf '%s' "$V" | grep -q "\"version\":\"$LOCAL_VER\"" || die "VERIFY FAILED: local version is not $LOCAL_VER"
  printf '%s' "$V" | tr -d '\r' | grep -qi "^access-control-allow-origin: https://$HOST\$" \
    || die "VERIFY FAILED: CORS header is not https://$HOST — the .env did not reach the process (ecosystem env allowlist? by-name start?)"
  echo "  ok: local health 200, v$LOCAL_VER, CORS pinned to https://$HOST (the .env -> ecosystem -> process chain works)"
  V="$(remote "curl -s -i --max-time 15 'https://$HOST/api/health'" || true)"
  printf '%s' "$V" | head -1 | grep -q ' 200' || die "VERIFY FAILED: https://$HOST/api/health is not 200 (nginx site / cert / DNS)"
  printf '%s' "$V" | grep -q "\"version\":\"$LOCAL_VER\"" || die "VERIFY FAILED: https://$HOST serves a version other than $LOCAL_VER"
  echo "  ok: https://$HOST/api/health 200, v$LOCAL_VER"
  local C; C="$(remote "curl -s -o /dev/null -w '%{http_code}' --max-time 10 'http://127.0.0.1:$PORT/api/sso'" || echo 000)"
  [ "$C" = 404 ] || die "VERIFY FAILED: /api/sso answered $C, expected 404 (no FAMILY_SSO_SECRET yet). 401 = a secret IS set; anything else = wrong process on the port."
  echo "  ok: /api/sso 404 (SSO invisible until this trip joins the portal)"
}

next_steps() {
  cat <<EOF

DONE: '$NAME' is live at https://$HOST (port $PORT, pm2 $PM2_NAME, v$LOCAL_VER).
Next, on the droplet:
  1. bash deploy/sync-admin-key.sh                # shared ADMIN_KEY into $APP_DIR/.env
     cd $APP_DIR && pm2 reload ecosystem.config.js   # by FILE: the sync's by-name reload won't refresh a new process's env
  2. bash deploy/sync-sso-secret.sh --only $NAME  # only if this trip joins family SSO (then /api/sso answers 401, not 404)
  3. deploy/instances.local.conf already has the row '$NAME  $APP_DIR  $PORT' — future code updates: deploy/deploy.sh $NAME
  4. Backups: nothing to do — backup-all.sh picks up $APP_DIR/data.db on its next nightly sweep.
EOF
}

on_exit() {
  local rc=$?
  [ "$rc" = 0 ] || [ "$DRY" = 1 ] || {
    echo >&2; echo "$ME: FAILED (exit $rc) while standing up '$NAME'. Already done:" >&2
    if [ "${#DONE[@]}" = 0 ]; then echo "  (nothing — no remote or local change was made)" >&2; else printf '  - %s\n' "${DONE[@]}" >&2; fi
    echo "To unwind by hand (no family data exists yet): pm2 delete $PM2_NAME && pm2 save; rm -rf $APP_DIR;" >&2
    echo "  rm -f $LINK $SITE && nginx -t && systemctl reload nginx; certbot delete --cert-name $HOST;" >&2
    echo "  and remove the '$NAME' row from deploy/instances.local.conf. Then rerun — preflight will refuse until all of it is gone." >&2
  }
}
trap on_exit EXIT

stand_up; verify
if [ "$DRY_RUN" = 1 ]; then echo; echo "dry-run: nothing was changed (locally or remotely)."; exit 0; fi
if [ "$YES" != 1 ]; then
  [ -t 0 ] || die "no terminal for the confirmation prompt — rerun with --yes after reviewing the plan"
  echo; read -r -p "Type the instance name ('$NAME') to stand it up, anything else aborts: " ANS
  [ "$ANS" = "$NAME" ] || { echo "aborted — nothing was changed."; exit 1; }
fi
echo; say "standing up '$NAME'"
DRY=0
stand_up; verify; next_steps
