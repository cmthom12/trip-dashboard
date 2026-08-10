#!/usr/bin/env bash
# deploy/sync-sso-secret.sh — one droplet-wide family-SSO secret: put the same
# FAMILY_SSO_SECRET line into the portal's .env and into every trip instance's
# .env under TRIPS_ROOT, chmod 600 each, pm2-reload each, then print a
# fingerprint + probe table. Sibling of sync-admin-key.sh, same shape and same
# discipline — run it ON the droplet.
#
# Usage:  sync-sso-secret.sh [--only <instance>]
#   (no args)          every instance under TRIPS_ROOT, plus the portal
#   --only <instance>  the portal plus that ONE instance — this is the staged
#                      rollout: portal + a candidate trip first, the rest later.
#
# The secret is found in this order and only generated if nowhere to be found:
#   1. the portal's .env (the portal is the signer, so it is the source of truth)
#   2. the first instance .env that already carries one
#   3. freshly generated, `openssl rand -hex 24` (48 hex chars)
#
# The secret is NEVER echoed — the table shows a 12-hex sha256 fingerprint, and
# it reaches awk through the environment, not argv.
#
# The probe is the real acceptance check: GET /api/sso on an instance answers
#   401  the route is live and the secret is loaded  → good (no cookie was sent)
#   404  the route is invisible → the process does NOT have FAMILY_SSO_SECRET.
#        Almost always the instance's ecosystem.config.js env block, which is an
#        ALLOWLIST: a key it doesn't name never reaches process.env no matter
#        what the .env says. Add FAMILY_SSO_SECRET there and `pm2 reload`.
#
# Exit 0 = every target carries the same fingerprint and probes clean.
# TRIPS_ROOT / FAMILY_DIR overrides exist for local testing (no pm2 locally:
# reload prints "skipped", probes print "unreachable").
set -euo pipefail

TRIPS_ROOT="${TRIPS_ROOT:-/var/www/trips}"
FAMILY_DIR="${FAMILY_DIR:-/var/www/family-hub}"

ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; [ -n "$ONLY" ] || { echo "sync-sso-secret: --only needs an instance name" >&2; exit 2; }; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "sync-sso-secret: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done

cd "$TRIPS_ROOT" 2>/dev/null || { echo "sync-sso-secret: TRIPS_ROOT '$TRIPS_ROOT' not found" >&2; exit 2; }

ALL=()
for d in */; do [ -f "${d}.env" ] && ALL+=("${d%/}"); done
[ "${#ALL[@]}" -gt 0 ] || { echo "sync-sso-secret: no instance dirs with a .env under $TRIPS_ROOT" >&2; exit 2; }

INSTANCES=()
if [ -n "$ONLY" ]; then
  for n in "${ALL[@]}"; do [ "$n" = "$ONLY" ] && INSTANCES+=("$n"); done
  [ "${#INSTANCES[@]}" -gt 0 ] || { echo "sync-sso-secret: instance '$ONLY' has no .env under $TRIPS_ROOT" >&2; exit 2; }
else
  INSTANCES=("${ALL[@]}")
fi

PORTAL_ENV="$FAMILY_DIR/.env"
[ -f "$PORTAL_ENV" ] || { echo "sync-sso-secret: no portal .env at $PORTAL_ENV (create it from family-hub/deploy/env.template)" >&2; exit 2; }

get_key() { tr -d '\r' < "$1" | sed -n 's/^FAMILY_SSO_SECRET=//p' | head -1; }
fp_of()   { printf '%s' "$1" | sha256sum | cut -c1-12; }
# Replace the FAMILY_SSO_SECRET line, or append one if the file has none.
put_key() {
  tr -d '\r' < "$1" | SYNC_KEY="$2" awk '
    /^FAMILY_SSO_SECRET=/ { print "FAMILY_SSO_SECRET=" ENVIRON["SYNC_KEY"]; done=1; next }
    { print }
    END { if (!done) print "FAMILY_SSO_SECRET=" ENVIRON["SYNC_KEY"] }' > "$1.tmp"
  mv "$1.tmp" "$1"
  chmod 600 "$1"
}

KEY="$(get_key "$PORTAL_ENV")"
SOURCE="portal"
if [ -z "$KEY" ]; then
  for n in "${ALL[@]}"; do
    K="$(get_key "$n/.env")"
    if [ -n "$K" ]; then KEY="$K"; SOURCE="instance $n"; break; fi
  done
fi
if [ -z "$KEY" ]; then
  command -v openssl >/dev/null 2>&1 || { echo "sync-sso-secret: no existing secret and no openssl to generate one" >&2; exit 2; }
  KEY="$(openssl rand -hex 24)"
  SOURCE="generated"
fi
case "$KEY" in
  *[!0-9a-fA-F]*|"") echo "sync-sso-secret: refusing a non-hex secret from $SOURCE" >&2; exit 2 ;;
esac

SRC_FP="$(fp_of "$KEY")"
HAVE_PM2=0; command -v pm2 >/dev/null 2>&1 && HAVE_PM2=1

echo "secret: $SOURCE  (fingerprint $SRC_FP, ${#KEY} chars)"
[ -n "$ONLY" ] && echo "scope:  portal + instance '$ONLY' only (staged rollout)"
printf '%-16s %-13s %-12s %s\n' "target" "fingerprint" "pm2-reload" "probe"

BAD=0
HINT=0

# ── the portal first: it is the signer; a trip that verifies before the portal
# signs would just reject every cookie it sees. ──
put_key "$PORTAL_ENV" "$KEY"
P_FP="$(fp_of "$(get_key "$PORTAL_ENV")")"
[ "$P_FP" = "$SRC_FP" ] || BAD=$((BAD+1))
P_RELOAD="skipped (no pm2)"
if [ "$HAVE_PM2" = 1 ]; then
  if pm2 reload family-hub >/dev/null 2>&1; then P_RELOAD="ok"; else P_RELOAD="FAILED"; BAD=$((BAD+1)); fi
fi
P_PORT="$(tr -d '\r' < "$PORTAL_ENV" | sed -n 's/^PORT=//p' | head -1)"
P_PROBE="no port"
if [ -n "$P_PORT" ]; then
  # /api/health reports sso:true once the secret actually reached the process.
  BODY="$(curl -s --max-time 5 "http://127.0.0.1:${P_PORT}/api/health" 2>/dev/null || true)"
  case "$BODY" in
    *'"sso":true'*)  P_PROBE="sso on" ;;
    *'"sso":false'*) P_PROBE="SSO OFF (env not loaded)"; BAD=$((BAD+1)); HINT=1 ;;
    "")              P_PROBE="unreachable" ;;
    *)               P_PROBE="health ok (old version?)" ;;
  esac
fi
printf '%-16s %-13s %-12s %s\n' "family-hub" "$P_FP" "$P_RELOAD" "$P_PROBE"

for name in "${INSTANCES[@]}"; do
  env="$name/.env"
  put_key "$env" "$KEY"
  FP="$(fp_of "$(get_key "$env")")"
  [ "$FP" = "$SRC_FP" ] || BAD=$((BAD+1))

  RELOAD="skipped (no pm2)"
  if [ "$HAVE_PM2" = 1 ]; then
    if pm2 reload "trip-${name#trip-}" >/dev/null 2>&1; then RELOAD="ok"; else RELOAD="FAILED"; BAD=$((BAD+1)); fi
  fi

  PORT="$(tr -d '\r' < "$env" | sed -n 's/^PORT=//p' | head -1)"
  PROBE="no port"
  if [ -n "$PORT" ]; then
    # No cookie is sent, so 401 is the healthy answer: the route exists.
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://localhost:${PORT}/api/sso" 2>/dev/null || true)"
    case "$CODE" in
      401) PROBE="401 route live" ;;
      404) PROBE="404 SECRET NOT IN ENV"; BAD=$((BAD+1)); HINT=1 ;;
      000) PROBE="unreachable" ;;
      *)   PROBE="HTTP $CODE"; BAD=$((BAD+1)) ;;
    esac
  fi
  printf '%-16s %-13s %-12s %s\n' "$name" "$FP" "$RELOAD" "$PROBE"
done

if [ "$HINT" = 1 ]; then
  echo
  echo "A 404 (or portal sso:false) after a successful reload means the .env line is"
  echo "right but the process never saw it. Check that ecosystem.config.js lists"
  echo "FAMILY_SSO_SECRET in its env block — that block is an allowlist — then"
  echo "'pm2 reload ecosystem.config.js' from the app directory." >&2
fi
if [ "$BAD" -gt 0 ]; then
  echo "sync-sso-secret: $BAD problem(s) — see the table above" >&2
  exit 1
fi
echo "sync-sso-secret: portal + ${#INSTANCES[@]} instance(s) carry fingerprint $SRC_FP"
