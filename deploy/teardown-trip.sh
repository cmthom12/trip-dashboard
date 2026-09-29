#!/usr/bin/env bash
# deploy/teardown-trip.sh — remove ONE trip instance from the server, safely.
# Run ON the server as root (copy it to /root/ first, master-copy rule):
#
#   bash /root/teardown-trip.sh <name> <sha16>          (asks you to type the name)
#
# <sha16> = the first 16 hex characters of sha256 of the ARCHIVED data.db on
# your laptop (~/code/_archive/trips/<name>/data.db-<date>). The script refuses
# unless the live data.db matches it with no journal/WAL file waiting — proof
# that the archive holds exactly what is about to be deleted — and checks it
# AGAIN once the app is stopped, right before anything is deleted (the app
# writes straight into data.db, so an edit during the prompt would change it).
#
# It only removes names listed in an allow file (default
# /root/teardown-allow.txt), which also names the server it must run on:
#     host trip-server
#     trip oldtrip
#     trip othertrip
# Edit that file for each teardown; any trip not listed is refused.
#
# Order (a failure stops with everything after it untouched):
#   1. keep the nginx site + ecosystem.config.js (never .env) in
#      /root/retired/<name>-<UTC date>/
#   2. remove the nginx site, nginx -t — on failure the site is put back and
#      the script stops — then reload nginx
#   3. pm2 delete trip-<name> && pm2 save (the process name follows deploy.sh:
#      trip-<name>, or <name> itself when it already starts with "trip-")
#   4. re-check data.db against the archive (the app is stopped now)
#   5. certbot delete for the certificate the site used (its ssl_certificate
#      path) — refused up front if another enabled site uses it — then nginx -t
#   6. rm -rf the app dir
#   7. verify each of the above is gone
# Safe to re-run after a stop: it picks up the site and certificate from the
# kept copy in /root/retired.
# Afterwards, on the laptop: delete the deploy/instances.local.conf row; then
# the DNS record. The family portal drops the trip within 5 minutes (cache).
#
# Paths can be overridden for local rehearsal (tools/teardown-rehearsal.sh):
#   TRIPS_ROOT NGINX_DIR LE_DIR RETIRE_ROOT ALLOW_FILE
# Exit: 0 done · 1 stopped part-way (read the message) · 2 refused, nothing changed.
TRIPS_ROOT="${TRIPS_ROOT:-/var/www/trips}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
LE_DIR="${LE_DIR:-/etc/letsencrypt}"
RETIRE_ROOT="${RETIRE_ROOT:-/root/retired}"
ALLOW_FILE="${ALLOW_FILE:-/root/teardown-allow.txt}"
ME="teardown-trip"

refuse() { echo "$ME: REFUSED — $*" >&2; echo "RESULT: nothing was changed"; exit 2; }
stop()   { echo "$ME: STOPPED — $*" >&2; echo "RESULT: stopped part-way — read the lines above before doing anything else"; exit 1; }
say()    { echo "==> $*"; }

NAME="${1:-}"; SHA16="${2:-}"; YES="${3:-}"
[ -n "$NAME" ] && [ -n "$SHA16" ] || refuse "usage: teardown-trip.sh <name> <sha16> [--yes]"
case "$NAME" in *[!a-z0-9-]*|-*) refuse "'$NAME' is not a trip name (lowercase letters, digits, hyphens)";; esac
case "$SHA16" in *[!0-9a-f]*) refuse "<sha16> must be hex";; esac
[ "${#SHA16}" = 16 ] || refuse "<sha16> must be exactly 16 hex characters (got ${#SHA16})"
[ -z "$YES" ] || [ "$YES" = "--yes" ] || refuse "unknown option '$YES'"
PM2_NAME="trip-${NAME#trip-}"   # same rule as deploy.sh and new-trip.sh

# ── the allow file: this server, and this trip ────────────────────────────────
[ -f "$ALLOW_FILE" ] || refuse "no allow file $ALLOW_FILE — write 'host <server>' and one 'trip <name>' line per trip to remove"
WANT_HOST="$(tr -d '\r' < "$ALLOW_FILE" | awk '$1=="host"{print $2; exit}')"
[ -n "$WANT_HOST" ] || refuse "$ALLOW_FILE has no 'host <server>' line"
[ "$(hostname)" = "$WANT_HOST" ] || refuse "this is '$(hostname)', not '$WANT_HOST' (wrong server?)"
tr -d '\r' < "$ALLOW_FILE" | awk -v n="$NAME" '$1=="trip" && $2==n {f=1} END{exit f?0:1}' \
  || refuse "'$NAME' is not listed in $ALLOW_FILE (add 'trip $NAME' only if it really goes)"

# ── the data proof ────────────────────────────────────────────────────────────
APP="$TRIPS_ROOT/$NAME"
[ -d "$APP" ] || refuse "no app dir $APP"
[ -f "$APP/data.db" ] || refuse "no $APP/data.db to check against the archive"
data_ok() { # 0 when data.db matches the archive and nothing is waiting in a journal/WAL
  [ "$(sha256sum "$APP/data.db" | cut -c1-16)" = "$SHA16" ] && [ ! -s "$APP/data.db-wal" ] && [ ! -s "$APP/data.db-journal" ]
}
LIVE="$(sha256sum "$APP/data.db" | cut -c1-16)"
[ "$LIVE" = "$SHA16" ] || refuse "live data.db sha256 starts $LIVE, the archive's starts $SHA16 — re-archive first"
for j in data.db-wal data.db-journal; do
  if [ -s "$APP/$j" ]; then refuse "$APP/$j is not empty — the database has changes in flight; archive again later"; fi
done

# ── the nginx site and its certificate ───────────────────────────────────────
SITE_AV="$NGINX_DIR/sites-available/$NAME"; SITE_EN="$NGINX_DIR/sites-enabled/$NAME"
SITE_SRC=""; LINK_TARGET=""
if [ -L "$SITE_EN" ]; then LINK_TARGET="$(readlink -f "$SITE_EN" 2>/dev/null)"; fi
if [ -f "$SITE_AV" ]; then SITE_SRC="$SITE_AV"
elif [ -n "$LINK_TARGET" ] && [ -f "$LINK_TARGET" ]; then SITE_SRC="$LINK_TARGET"   # enabled via a differently named file
elif [ -f "$SITE_EN" ] && [ ! -L "$SITE_EN" ]; then SITE_SRC="$SITE_EN"
else # a re-run: this trip's own kept copy (<name>-YYYYMMDD — never another trip's <name>-x-…)
  SITE_SRC="$(ls -1d "$RETIRE_ROOT/$NAME-"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]/nginx-site 2>/dev/null | tail -1)"
fi
CERT=""
[ -n "$SITE_SRC" ] && CERT="$(tr -d '\r' < "$SITE_SRC" | grep -oE 'ssl_certificate[[:space:]]+[^;]*/live/[^/;]+/' | head -1 | sed -E 's#.*/live/([^/]+)/$#\1#')"
if [ -n "$CERT" ]; then
  OTHERS=""
  for f in "$NGINX_DIR"/sites-enabled/* "$NGINX_DIR"/conf.d/*.conf; do
    [ -e "$f" ] || continue
    [ "$(basename "$f")" = "$NAME" ] && continue
    grep -q "/live/$CERT/" "$f" 2>/dev/null && OTHERS="$OTHERS $(basename "$f")"
  done
  [ -z "$OTHERS" ] || refuse "certificate '$CERT' is also used by:$OTHERS — it can't be deleted with this trip"
fi

echo "$ME: about to remove '$NAME'"
echo "  app dir      $APP   (data.db sha256 $LIVE… = archive ✓, no journal/WAL waiting ✓)"
echo "  nginx site   ${SITE_SRC:-(none)}"
echo "  pm2 process  $PM2_NAME"
echo "  certificate  ${CERT:-(none found)}"
if [ "$YES" != "--yes" ]; then
  printf 'Type the trip name to go ahead: '
  read -r ANSWER || ANSWER=""
  [ "$ANSWER" = "$NAME" ] || refuse "you typed '$ANSWER', not '$NAME'"
fi

# ── 1. keep the site + ecosystem (no .env) ────────────────────────────────────
KEEP="$RETIRE_ROOT/$NAME-$(date -u +%Y%m%d)"
say "1. keeping the nginx site and ecosystem.config.js in $KEEP (not .env)"
mkdir -p "$KEEP" || stop "could not create $KEEP — nothing removed yet"
WAS_LINK=0; WAS_FILE=0
[ -L "$SITE_EN" ] && WAS_LINK=1
[ -f "$SITE_EN" ] && [ ! -L "$SITE_EN" ] && WAS_FILE=1
if [ -f "$SITE_AV" ]; then cp -p "$SITE_AV" "$KEEP/nginx-site" || stop "could not copy the site — nothing removed yet"
elif [ -n "$LINK_TARGET" ] && [ -f "$LINK_TARGET" ]; then cp -p "$LINK_TARGET" "$KEEP/nginx-site" || stop "could not copy the site — nothing removed yet"; fi
if [ "$WAS_FILE" = 1 ]; then
  cp -p "$SITE_EN" "$KEEP/nginx-site-enabled" || stop "could not copy the enabled site — nothing removed yet"
  [ -f "$KEEP/nginx-site" ] || cp -p "$SITE_EN" "$KEEP/nginx-site"
fi
if [ -f "$APP/ecosystem.config.js" ]; then cp -p "$APP/ecosystem.config.js" "$KEEP/" || stop "could not copy ecosystem.config.js — nothing removed yet"; fi

# ── 2. nginx: site out, test, reload (restore on a failed test) ───────────────
say "2. removing the nginx site, then nginx -t"
HAD_AV=0; [ -f "$SITE_AV" ] && HAD_AV=1
rm -f "$SITE_EN" "$SITE_AV"
if ! nginx -t >/dev/null 2>&1; then
  OK=1
  if [ "$HAD_AV" = 1 ]; then cp -p "$KEEP/nginx-site" "$SITE_AV" || OK=0; fi
  if [ "$WAS_LINK" = 1 ]; then ln -s "${LINK_TARGET:-$SITE_AV}" "$SITE_EN" || OK=0; fi
  if [ "$WAS_FILE" = 1 ]; then cp -p "$KEEP/nginx-site-enabled" "$SITE_EN" || OK=0; fi
  [ "$OK" = 1 ] && stop "nginx -t failed without the site — the site was put back as it was; nothing else was touched (run nginx -t to see why)"
  stop "nginx -t failed without the site AND putting it back failed — copies are in $KEEP; restore them by hand, then nginx -t"
fi
systemctl reload nginx || stop "nginx reload failed after the site was removed (nginx -t had passed) — check: systemctl status nginx"
if [ -n "$LINK_TARGET" ] && [ "$LINK_TARGET" != "$SITE_AV" ] && [ -f "$LINK_TARGET" ]; then
  echo "   (the site was enabled through $LINK_TARGET — left in place, no longer enabled; a copy is in $KEEP)"
fi

# ── 3. pm2 ────────────────────────────────────────────────────────────────────
say "3. pm2 delete $PM2_NAME && pm2 save"
pm2 delete "$PM2_NAME" >/dev/null 2>&1 || echo "   (no pm2 process $PM2_NAME — already gone)"
pm2 save >/dev/null 2>&1 || stop "pm2 save failed — the process list on disk may still list $PM2_NAME (re-run this script once fixed)"

# ── 4. the data, again, now that nothing can write ───────────────────────────
say "4. re-checking data.db against the archive (the app is stopped)"
data_ok || stop "data.db changed after the first check (someone used the trip during the prompt?) — NOTHING was deleted: archive it again, then re-run with the new sha. The app is stopped and its site is off; to bring it back: restore the site from $KEEP, nginx -t, reload, then cd $APP && pm2 start ecosystem.config.js && pm2 save"

# ── 5. certificate ────────────────────────────────────────────────────────────
if [ -n "$CERT" ] && [ -d "$LE_DIR/live/$CERT" ]; then
  say "5. certbot delete --cert-name $CERT, then nginx -t"
  certbot delete --cert-name "$CERT" --non-interactive >/dev/null 2>&1 || stop "certbot delete failed — the app is stopped and its site is gone; remove the certificate by hand"
  nginx -t >/dev/null 2>&1 || stop "nginx -t fails after the certificate was deleted — another site must still point at it; fix that site before the next reload"
else
  say "5. no certificate to delete"
fi

# ── 6. app dir ────────────────────────────────────────────────────────────────
say "6. removing $APP"
rm -rf "$APP" || stop "could not remove $APP"

# ── 7. verify ─────────────────────────────────────────────────────────────────
say "7. checking it is all gone"
BAD=0
[ ! -e "$APP" ] && echo "   ✓ app dir gone" || { echo "   ✗ $APP still exists"; BAD=1; }
[ ! -e "$SITE_AV" ] && [ ! -e "$SITE_EN" ] && echo "   ✓ nginx site gone" || { echo "   ✗ nginx site still there"; BAD=1; }
if pm2 jlist 2>/dev/null | grep -q "\"name\":\"$PM2_NAME\""; then echo "   ✗ pm2 still has $PM2_NAME"; BAD=1; else echo "   ✓ pm2 process $PM2_NAME gone"; fi
if [ -z "$CERT" ]; then echo "   ? no certificate was named in the site — if the trip had one, check $LE_DIR/live/ by hand"
elif [ -d "$LE_DIR/live/$CERT" ]; then echo "   ✗ certificate $CERT still there"; BAD=1
else echo "   ✓ certificate $CERT gone"; fi
[ "$BAD" = 0 ] || stop "something is still there (see ✗ above)"
echo "RESULT: '$NAME' removed. Kept: $KEEP. Next, on the laptop: delete its deploy/instances.local.conf row, then its DNS record."
exit 0
