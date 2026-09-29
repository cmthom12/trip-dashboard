#!/usr/bin/env bash
# tools/teardown-rehearsal.sh — local checks for deploy/teardown-trip.sh.
#
# Builds a throwaway server layout (trips, nginx sites, certificates, an allow
# file) and puts fake `hostname`, `nginx`, `systemctl`, `pm2` and `certbot`
# first on PATH. They log what they are asked; the fake pm2 keeps a real
# process list (delete removes only the named process; jlist shows what is
# left); nginx -t / pm2 save can be told to fail. Then it runs the real script
# and checks:
#   - every refusal changes nothing: wrong server, trip not in the allow file,
#     no allow file, data.db sha mismatch, a journal/WAL waiting, bad
#     arguments, a certificate another site uses, a mistyped confirmation;
#   - the happy path keeps the site + ecosystem (never .env), takes the site
#     out BEFORE pm2 (nginx -t, reload, pm2 delete + save), re-checks the data,
#     deletes the site's own certificate, removes the app dir, leaves other
#     trips alone, and verifies;
#   - a trip named "trip-…" stops the process deploy.sh started (not
#     "trip-trip-…");
#   - a failing nginx -t puts the site back as it was (a symlink, or a plain
#     file in sites-enabled) and touches nothing else;
#   - data that changes after the prompt stops it before anything is deleted;
#   - a re-run after a stop finishes the job, certificate included.
# Usage: bash tools/teardown-rehearsal.sh      Exit 0 = every check passed.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/deploy/teardown-trip.sh"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Git Bash copies files for `ln -s` unless Windows symlinks are enabled, and
    # these checks are about symlinked nginx sites. The script only ever runs on
    # the Linux server; this suite is run on Linux (the cloud build, or the server).
    echo "SKIP  teardown checks need real symlinks (Linux) — run on Linux"
    echo "RESULT: 0 PASS, 0 FAIL (skipped)"
    exit 0 ;;
esac
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ck() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS  $2"; else FAIL=$((FAIL+1)); echo "FAIL  $2"; fi; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/pm2" <<'EOF'
#!/usr/bin/env bash
echo "pm2 $*" >> "$FAKE_LOG"
case "$1" in
  delete) grep -qx "$2" "$FAKE_PM2_LIST" || exit 1
          grep -vx "$2" "$FAKE_PM2_LIST" > "$FAKE_PM2_LIST.n"; mv "$FAKE_PM2_LIST.n" "$FAKE_PM2_LIST"
          [ -n "$FAKE_WRITE_ON_DELETE" ] && printf 'late-write' >> "$FAKE_WRITE_ON_DELETE"
          exit 0 ;;
  save)   exit "${FAKE_PM2_SAVE_RC:-0}" ;;
  jlist)  printf '['; sep=''; while read -r n; do [ -n "$n" ] && printf '%s{"name":"%s","pm_id":0}' "$sep" "$n" && sep=','; done < "$FAKE_PM2_LIST"; printf ']\n' ;;
esac
exit 0
EOF
cat > "$TMP/bin/nginx" <<'EOF'
#!/usr/bin/env bash
echo "nginx $*" >> "$FAKE_LOG"
[ "$1" = "-t" ] && exit "${NGINX_T_RC:-0}"
exit 0
EOF
cat > "$TMP/bin/certbot" <<'EOF'
#!/usr/bin/env bash
echo "certbot $*" >> "$FAKE_LOG"
[ "$1" = delete ] && rm -rf "$LE_DIR/live/$3"
exit 0
EOF
printf '#!/usr/bin/env bash\necho "systemctl $*" >> "$FAKE_LOG"\n' > "$TMP/bin/systemctl"
printf '#!/usr/bin/env bash\necho "${FAKE_HOST:-trip-server}"\n' > "$TMP/bin/hostname"
chmod +x "$TMP/bin/"*

S="$TMP/srv"
server() { # a fresh fake server: "old" (to remove), "keeper", "trip-b" (a trip- name)
  rm -rf "$S"; mkdir -p "$S/trips/old" "$S/trips/keeper" "$S/trips/trip-b" "$S/nginx/sites-available" "$S/nginx/sites-enabled" "$S/le/live/old-cert" "$S/le/live/b.trips.test" "$S/retired"
  printf 'SQLite format 3 old-trip-bytes' > "$S/trips/old/data.db"
  printf 'keeper-bytes' > "$S/trips/keeper/data.db"
  printf 'b-bytes' > "$S/trips/trip-b/data.db"
  echo 'ADMIN_KEY=secret-never-copied' > "$S/trips/old/.env"
  echo 'module.exports = { apps: [] }' > "$S/trips/old/ecosystem.config.js"
  # the site names itself old.trips.test but its certificate lives under "old-cert"
  printf 'server {\n  listen 443 ssl http2;\n  server_name old.trips.test www.old.trips.test;\n  ssl_certificate %s/le/live/old-cert/fullchain.pem;\n}\n' "$S" > "$S/nginx/sites-available/old"
  ln -s "$S/nginx/sites-available/old" "$S/nginx/sites-enabled/old"
  printf 'server { server_name keeper.trips.test; ssl_certificate /x/live/keeper.trips.test/fullchain.pem; }\n' > "$S/nginx/sites-available/keeper"
  ln -s "$S/nginx/sites-available/keeper" "$S/nginx/sites-enabled/keeper"
  printf 'server { server_name b.trips.test; ssl_certificate %s/le/live/b.trips.test/fullchain.pem; }\n' "$S" > "$S/nginx/sites-available/trip-b"
  ln -s "$S/nginx/sites-available/trip-b" "$S/nginx/sites-enabled/trip-b"
  printf 'host trip-server\ntrip old\ntrip trip-b\n' > "$S/allow.txt"
  printf 'trip-old\ntrip-keeper\ntrip-b\n' > "$TMP/pm2list"
  : > "$TMP/log"
  SHA="$(sha256sum "$S/trips/old/data.db" | cut -c1-16)"
}
envrun() { env PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/log" FAKE_PM2_LIST="$TMP/pm2list" TRIPS_ROOT="$S/trips" NGINX_DIR="$S/nginx" LE_DIR="$S/le" RETIRE_ROOT="$S/retired" ALLOW_FILE="$S/allow.txt" "$@"; }
run() { envrun bash "$SCRIPT" "$@" > "$TMP/out" 2>&1; }
untouched() { [ -f "$S/trips/old/data.db" ] && [ -f "$S/nginx/sites-available/old" ] && [ -L "$S/nginx/sites-enabled/old" ] && [ -d "$S/le/live/old-cert" ] && grep -qx trip-old "$TMP/pm2list" && ! grep -qE '^(pm2|certbot|systemctl)' "$TMP/log"; }

echo "==> refusals change nothing (exit 2)"
server; FAKE_HOST=other-box run old "$SHA" --yes; RC=$?
[ "$RC" = 2 ] && grep -q "wrong server" "$TMP/out" && untouched; ck $? "on the wrong server (hostname is not the allow file's host)"
server; run keeper "$(sha256sum "$S/trips/keeper/data.db" | cut -c1-16)" --yes; RC=$?
[ "$RC" = 2 ] && grep -q "not listed" "$TMP/out" && untouched && [ -d "$S/trips/keeper" ]; ck $? "a trip that is not in the allow file (a keeper)"
server; rm "$S/allow.txt"; run old "$SHA" --yes; RC=$?
[ "$RC" = 2 ] && grep -q "no allow file" "$TMP/out" && untouched; ck $? "no allow file at all"
server; run old 0123456789abcdef --yes; RC=$?
[ "$RC" = 2 ] && grep -q "re-archive first" "$TMP/out" && untouched; ck $? "the live data.db does not match the archive's sha"
A=0; for j in data.db-wal data.db-journal; do server; printf 'pending' > "$S/trips/old/$j"; run old "$SHA" --yes; [ $? = 2 ] && grep -q "changes in flight" "$TMP/out" && untouched || A=1; done
[ "$A" = 0 ]; ck $? "a non-empty data.db-wal or data.db-journal (changes in flight)"
server; A=0; for args in "" "old" "Old $SHA" "../x $SHA" "old abc" "old $SHA --force"; do run $args; [ $? = 2 ] || A=1; done
[ "$A" = 0 ] && untouched; ck $? "bad arguments (missing, capital letters, a path, a short sha, an unknown option)"
server; printf 'server { ssl_certificate %s/le/live/old-cert/fullchain.pem; }\n' "$S" > "$S/nginx/sites-available/keeper"; run old "$SHA" --yes; RC=$?
[ "$RC" = 2 ] && grep -q "also used by: keeper" "$TMP/out" && untouched; ck $? "its certificate is also used by another enabled site"
server; printf 'olf\n' | envrun bash "$SCRIPT" old "$SHA" > "$TMP/out" 2>&1; RC=$?
[ "$RC" = 2 ] && grep -q "you typed 'olf'" "$TMP/out" && untouched; ck $? "without --yes it asks for the name; a typo stops it"

echo "==> the happy path"
server; printf 'old\n' | envrun bash "$SCRIPT" old "$SHA" > "$TMP/out" 2>&1; RC=$?
[ "$RC" = 0 ] && grep -q "^RESULT: 'old' removed" "$TMP/out"; ck $? "typing the name runs it to the end (exit $RC)"
KEEP="$(ls -d "$S/retired/old-"* 2>/dev/null | head -1)"
[ -n "$KEEP" ] && [ -f "$KEEP/nginx-site" ] && [ -f "$KEEP/ecosystem.config.js" ] && [ ! -e "$KEEP/.env" ] && ! grep -rq secret-never-copied "$KEEP"
ck $? "the nginx site and ecosystem.config.js are kept in /root/retired/old-<date>/ — the .env is not"
ORDER="$(grep -oE '^(nginx -t|systemctl reload|pm2 delete|pm2 save|certbot delete)' "$TMP/log" | tr '\n' ',')"
[ "$ORDER" = "nginx -t,systemctl reload,pm2 delete,pm2 save,certbot delete,nginx -t," ]; ck $? "order: site out + nginx -t + reload BEFORE pm2 delete + save, then the certificate and nginx -t again ($ORDER)"
grep -q "^certbot delete --cert-name old-cert --non-interactive" "$TMP/log"; ck $? "the certificate deleted is the one the site used (its ssl_certificate path), not a guess from server_name"
[ ! -e "$S/trips/old" ] && [ ! -e "$S/nginx/sites-available/old" ] && [ ! -e "$S/nginx/sites-enabled/old" ] && [ ! -e "$S/le/live/old-cert" ] && ! grep -qx trip-old "$TMP/pm2list"
ck $? "app dir, both site files, the certificate and the pm2 process are gone"
[ -f "$S/trips/keeper/data.db" ] && [ -f "$S/nginx/sites-available/keeper" ] && grep -qx trip-keeper "$TMP/pm2list" && [ -d "$S/trips/trip-b" ]; ck $? "the other trips are untouched"

echo "==> a trip whose name starts with trip-"
server; SB="$(sha256sum "$S/trips/trip-b/data.db" | cut -c1-16)"; run trip-b "$SB" --yes; RC=$?
[ "$RC" = 0 ] && grep -q "^pm2 delete trip-b$" "$TMP/log" && ! grep -qx trip-b "$TMP/pm2list" && ! grep -q "trip-trip-b" "$TMP/log"
ck $? "\"trip-b\" stops the process deploy.sh named trip-b (not trip-trip-b), and verifies it is gone"

echo "==> a failing nginx -t"
server; NGINX_T_RC=1 run old "$SHA" --yes; RC=$?
[ "$RC" = 1 ] && grep -q "put back as it was" "$TMP/out" && untouched; ck $? "the site is put back (file + symlink), and pm2, the certificate and the app dir are not touched (exit $RC)"
server; rm "$S/nginx/sites-enabled/old"; mv "$S/nginx/sites-available/old" "$S/nginx/sites-enabled/old"; NGINX_T_RC=1 run old "$SHA" --yes; RC=$?
[ "$RC" = 1 ] && [ -f "$S/nginx/sites-enabled/old" ] && [ ! -L "$S/nginx/sites-enabled/old" ] && [ ! -e "$S/nginx/sites-available/old" ] && [ -f "$(ls -d "$S/retired/old-"*)/nginx-site" ]
ck $? "a site that lives only in sites-enabled (a plain file) is kept in /root/retired and put back as a plain file"

echo "==> the data changes after the prompt"
server; FAKE_WRITE_ON_DELETE="$S/trips/old/data.db" run old "$SHA" --yes; RC=$?
[ "$RC" = 1 ] && grep -q "NOTHING was deleted" "$TMP/out" && [ -f "$S/trips/old/data.db" ] && [ -d "$S/le/live/old-cert" ] && ! grep -q "^certbot" "$TMP/log"
ck $? "a write that lands before the app stops is caught by the second check: the app dir and certificate stay (exit $RC)"
server; FAKE_WRITE_ON_DELETE="$S/trips/old/data.db-journal" run old "$SHA" --yes; RC=$?
[ "$RC" = 1 ] && grep -q "NOTHING was deleted" "$TMP/out" && [ -f "$S/trips/old/data.db" ]
ck $? "…and so is a journal left behind by the stopping app (exit $RC)"

echo "==> a re-run after a stop"
server; FAKE_PM2_SAVE_RC=1 run old "$SHA" --yes; RC1=$?
: > "$TMP/log"; run old "$SHA" --yes; RC2=$?
[ "$RC1" = 1 ] && [ "$RC2" = 0 ] && grep -q "^certbot delete --cert-name old-cert" "$TMP/log" && [ ! -e "$S/le/live/old-cert" ] && [ ! -e "$S/trips/old" ]
ck $? "stopped at pm2 save (exit $RC1), the re-run finishes — the certificate comes from the kept copy (exit $RC2)"

echo "==> kept copies and oddly enabled sites"
server; mkdir -p "$S/retired/old-x-20260101" "$S/le/live/oldx-cert"; printf 'server { ssl_certificate %s/le/live/oldx-cert/f.pem; }\n' "$S" > "$S/retired/old-x-20260101/nginx-site"
FAKE_PM2_SAVE_RC=1 run old "$SHA" --yes; : > "$TMP/log"; run old "$SHA" --yes; RC=$?
[ "$RC" = 0 ] && grep -q "^certbot delete --cert-name old-cert" "$TMP/log" && [ -d "$S/le/live/oldx-cert" ] && ! grep -q "oldx-cert" "$TMP/log"
ck $? "a re-run uses this trip's own kept copy — never another trip's (old-x-…) — and deletes only its own certificate"
server; mv "$S/nginx/sites-available/old" "$S/nginx/sites-available/old.conf"; rm "$S/nginx/sites-enabled/old"; ln -s "$S/nginx/sites-available/old.conf" "$S/nginx/sites-enabled/old"
run old "$SHA" --yes; RC=$?
[ "$RC" = 0 ] && grep -q "^certbot delete --cert-name old-cert" "$TMP/log" && [ -f "$(ls -d "$S/retired/old-"2*)/nginx-site" ] && [ ! -e "$S/nginx/sites-enabled/old" ]
ck $? "a site enabled through a differently named file (old -> old.conf) is found, kept, and its certificate deleted"
server; mv "$S/nginx/sites-available/old" "$S/nginx/sites-available/old.conf"; rm "$S/nginx/sites-enabled/old"; ln -s "$S/nginx/sites-available/old.conf" "$S/nginx/sites-enabled/old"
NGINX_T_RC=1 run old "$SHA" --yes; RC=$?
[ "$RC" = 1 ] && [ "$(readlink "$S/nginx/sites-enabled/old")" = "$S/nginx/sites-available/old.conf" ] && [ -f "$S/nginx/sites-available/old.conf" ]
ck $? "…and a failing nginx -t puts that link back pointing at old.conf (exit $RC)"
server; printf 'server {\n  server_name old.trips.test;\n}\n' > "$S/nginx/sites-available/old"; run old "$SHA" --yes; RC=$?
[ "$RC" = 0 ] && grep -q "no certificate was named in the site" "$TMP/out" && ! grep -q "✓ certificate" "$TMP/out"
ck $? "a site that names no certificate: says so and asks for a hand check (no false \"gone\")"

echo "RESULT: $PASS PASS, $FAIL FAIL"
exit "$FAIL"
