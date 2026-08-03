# Multi-Instance Guide — several trips on one droplet

One droplet can host a dashboard **per trip**: each trip is its own Node process,
its own directory, its own database, its own domain. All examples below use
placeholders — `trips.example.com`, `<droplet-ip>`, instance names `trip-a`/`trip-b`.

## Architecture

**Process-per-trip.** Every instance is a full copy of the app in its own
directory. `server.js` opens its database with `path.join(__dirname, 'data.db')`,
so the DB always lives *next to the code* — separate directories are what makes
instances isolated (proven locally by `tools/multi-rehearsal.sh`).

- One **PM2 process per trip**, named `trip-<name>`, configured by a per-instance
  `ecosystem.config.js` (from `deploy/ecosystem.template.config.js`).
- One **`.env` per trip** (from `deploy/env.template`, mode 600): `PORT`,
  `ADMIN_KEY`, `CORS_ORIGIN`, `NODE_ENV`.
- One **nginx** terminates TLS for everything: a server block per domain, each
  `proxy_pass`ing to its instance's localhost port
  (`deploy/nginx/trip-dashboard.conf.template` works per-instance too).
- One **backup cron** for all instances: `deploy/backup-all.sh`.

The instance table (first three columns mirror `deploy/instances.conf`, which
`deploy/deploy.sh <name>` reads — real rows go in the gitignored
`deploy/instances.local.conf`):

| name   | dir                     | port | domain (nginx)             | pm2 process |
|--------|-------------------------|------|----------------------------|-------------|
| trip-a | /var/www/trips/trip-a   | 3001 | trip-a.trips.example.com   | trip-a      |
| trip-b | /var/www/trips/trip-b   | 3002 | trip-b.trips.example.com   | trip-b      |

## ADD-A-TRIP — bring up a new instance

Prereqs: a droplet provisioned once via `deploy/provision.sh` (node, pm2, nginx,
certbot). Pick the next free port (here: `3003`, name `trip-c`,
domain `trip-c.trips.example.com`).

1. **DNS**: add an A record `trip-c.trips.example.com` → `<droplet-ip>`.
   If your DNS proxy offers a CDN toggle, keep it **DNS-only (grey cloud)** —
   certbot's HTTP challenge and the PWA behave best unproxied.
   *Rollback: delete the record.*

2. **nginx server block**: copy `deploy/nginx/trip-dashboard.conf.template` to
   `/etc/nginx/sites-available/trip-c`, fill `__SERVER_NAME__` =
   `trip-c.trips.example.com`, `__APP_PORT__` = `3003`, `__WEBROOT__` and
   `__CERT_DIR__` as in the template header. Enable and reload:
   `ln -s ../sites-available/trip-c /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx`.
   (TLS lines can be commented until step 3 issues the cert.)
   *Rollback: remove the symlink, `nginx -t && systemctl reload nginx`.*

3. **Certificate**: `certbot --nginx -d trip-c.trips.example.com` (or
   `certbot certonly --webroot` + `--expand` if you keep one multi-domain cert).
   *Rollback: `certbot delete --cert-name trip-c.trips.example.com`; an unused
   cert is harmless meanwhile.*

4. **Instance dir**: `mkdir -p /var/www/trips/trip-c`.
   *Rollback: `rm -rf /var/www/trips/trip-c` (no database exists yet).*

5. **Stamp the code + trip data**: from the laptop repo,
   `git archive v0.7.0 | ssh <droplet> "tar -x -C /var/www/trips/trip-c"`,
   then on the droplet
   `cd /var/www/trips/trip-c && npm install --omit=dev && node tools/apply-trip-data.js <trip>.json`
   (the apply tool validates, injects the trip, patches the name lists).
   *Rollback: same as step 4 — still no live data.*

6. **Environment**: `cp deploy/env.template /var/www/trips/trip-c/.env`, fill
   `PORT=3003` and `CORS_ORIGIN=https://trip-c.trips.example.com`, then
   `chmod 600 /var/www/trips/trip-c/.env`. For `ADMIN_KEY`, the droplet runs
   **one shared key** — copy the `ADMIN_KEY=` line from any existing instance's
   `.env` (or just run `deploy/sync-admin-key.sh` on the droplet after creating
   the file; it copies the key everywhere, chmods, reloads, and prints a
   fingerprint+probe table). Generate a fresh key (`openssl rand -hex 32`)
   **only** on a brand-new droplet with no instances yet.
   *Rollback: delete the file.*

7. **PM2**: `cp deploy/ecosystem.template.config.js /var/www/trips/trip-c/ecosystem.config.js`,
   set `NAME = 'trip-c'`, then
   `cd /var/www/trips/trip-c && pm2 start ecosystem.config.js && pm2 save`.
   The template refuses to load without a readable `.env` (that's step 6) and
   warns loudly if `ADMIN_KEY` is empty (admin console stays disabled/404).
   *Rollback: `pm2 delete trip-c && pm2 save`.*

8. **Verify**: on the droplet `curl -s http://localhost:3003/api/health` →
   `{"status":"ok",...}`; then open `https://trip-c.trips.example.com` on a
   phone and log in.
   *Rollback if unhealthy: `pm2 logs trip-c`, fix, or unwind steps 7→2.*

9. **Register the instance on your laptop**: add
   `trip-c  /var/www/trips/trip-c  3003` to `deploy/instances.local.conf`.
   **All later code updates are just `deploy/deploy.sh trip-c`** — it ships code
   only, restarts `trip-c`, and gates on `/api/health` reporting the local
   version. It never creates the process (that was step 7) and never touches
   `data.db`, `.env`, or `ecosystem.config.js`.

10. **Backups**: nothing to do — `deploy/backup-all.sh` (see its header for the
    cron line) discovers `/var/www/trips/*/data.db` automatically.

## MIGRATE-EXISTING-SINGLE-INSTANCE — move the old layout under /var/www/trips/

The pre-multi layout is one app at `/var/www/trip-dashboard` on port 3000 with a
PM2 process configured by a root-level `ecosystem.config.js` (that file is gone
from the repo — per-instance templates replaced it; the droplet's copy keeps
working until you do this migration). Pick the instance's new name (`trip-a`
below). Do this in a quiet moment — the family sees a minute of downtime.

1. **Safety net**: `cp /var/www/trip-dashboard/data.db /root/data.db.pre-migration-$(date +%F)`.
2. **Capture current env truth**: `pm2 env <id-of-old-process>` (or `pm2 show`) —
   note the effective `PORT`, `ADMIN_KEY`, `CORS_ORIGIN`, `NODE_ENV` values;
   they become the new `.env` in step 4. Don't trust memory — capture what the
   process actually runs with.
3. **Stop + delete the old process**: `pm2 stop <old-name> && pm2 delete <old-name> && pm2 save`.
4. **Move the dir**: `mkdir -p /var/www/trips && mv /var/www/trip-dashboard /var/www/trips/trip-a`.
   `data.db` travels with the directory (it lives next to server.js).
   Write `/var/www/trips/trip-a/.env` from the step-2 values (`chmod 600`) —
   keep `PORT` as captured (e.g. 3000) or renumber to the table's scheme (3001).
5. **New PM2 config**: `cp deploy/ecosystem.template.config.js /var/www/trips/trip-a/ecosystem.config.js`,
   set `NAME = 'trip-a'` (delete any stale root-level ecosystem file left in the
   moved dir so only the new per-instance one remains).
   **Field note (2026-08, from the real migration):** a moved pre-multi
   instance carries a **stale `deploy/` directory** — old single-instance
   scripts, possibly even a nested `deploy/deploy/` from an old copy. Do NOT
   use its templates. Replace it wholesale: `rm -rf deploy && cp -r
   /var/www/trips/<any-fresh-instance>/deploy .` (or re-stamp from a fresh
   `git archive`), so the dir matches the code version you'll deploy next.
6. **nginx**: if you renumbered the port in step 4, update the site's
   `proxy_pass http://127.0.0.1:<port>;` accordingly; `nginx -t && systemctl reload nginx`.
7. **Start + gate**: `cd /var/www/trips/trip-a && pm2 start ecosystem.config.js && pm2 save`,
   then `curl -s http://localhost:<port>/api/health` → must be 200 with the
   expected version, and the domain must load from a phone.
8. **Swap the backup cron**: `crontab -e` — remove the old single-instance
   backup line, add the `backup-all.sh` line from `deploy/backup-all.sh`'s
   header. (It would also keep backing up a not-yet-moved legacy dir, so the
   swap is safe to do first.)
9. **Laptop**: add the row to `deploy/instances.local.conf`; from now on updates
   are `deploy/deploy.sh trip-a`.

**Rollback** (any point before step 9): `pm2 delete trip-a`; `mv
/var/www/trips/trip-a /var/www/trip-dashboard`; restore the old nginx port if
changed; `pm2 start` the old config as before; the step-1 copy in `/root` is
the data safety net throughout.

## ADMIN-HUB — one read-only board for every instance

The hub (`admin-hub/` in the repo) serves an aggregate admin console at one
admin domain: a card per instance with health, trip summary, db/backup stats,
and an "open full admin" link to that instance's own `admin.html`. It discovers
instances by scanning `/var/www/trips/*/.env` (name = dirname, `PORT` +
`CORS_ORIGIN` from the file) — no config of its own. It stores **no secrets**:
the admin key is typed into the page, held in tab sessionStorage, sent as
`X-Admin-Key`, and forwarded verbatim to each instance over localhost; instance
status codes (incl. 401) pass through unchanged.

> **HAZARD — placement.** The hub's home is `/var/www/admin-hub`. It must
> **never** live under `/var/www/trips`: it would discover itself as an
> "instance" and `backup-all.sh` would sweep its directory into the db-backup
> loop. (The code and templates repeat this warning.)

Install (placeholders as usual; port `3010`):

1. **DNS**: A record `admin.trips.example.com` → `<droplet-ip>` (DNS-only /
   grey cloud). *Rollback: delete the record.*
2. **nginx**: copy `deploy/nginx/trip-dashboard.conf.template` to
   `/etc/nginx/sites-available/admin-hub`, fill `__SERVER_NAME__` =
   `admin.trips.example.com`, `__APP_PORT__` = `3010`, `__WEBROOT__`/
   `__CERT_DIR__` per the template header; symlink into `sites-enabled`,
   `nginx -t && systemctl reload nginx`. *Rollback: remove the symlink, reload.*
3. **Cert**: `certbot certonly --webroot -w /var/www/letsencrypt -d admin.trips.example.com`,
   then enable the TLS lines. *Rollback: `certbot delete --cert-name admin.trips.example.com`.*
4. **Code**: `mkdir -p /var/www/admin-hub`, copy `admin-hub/server.js`,
   `admin-hub/package.json`, `admin-hub/public/` up (first time by hand or by
   running `admin-hub/deploy-hub.sh` once the process exists — see step 6),
   `cd /var/www/admin-hub && npm install --omit=dev`.
   *Rollback: `rm -rf /var/www/admin-hub` (no data lives here, ever).*
5. **Env**: `cp admin-hub/env.template /var/www/admin-hub/.env`, keep
   `PORT=3010`, `chmod 600 .env`. Note there is deliberately **no ADMIN_KEY**
   line. *Rollback: delete the file.*
6. **PM2**: `cp admin-hub/ecosystem.template.config.js /var/www/admin-hub/ecosystem.config.js`,
   `cd /var/www/admin-hub && pm2 start ecosystem.config.js && pm2 save`.
   *Rollback: `pm2 delete admin-hub && pm2 save`.*
7. **Verify**: `curl -s http://localhost:3010/api/health` → `{"status":"ok",...}`;
   `curl -s http://localhost:3010/api/instances` → one entry per trip with
   health; open `https://admin.trips.example.com`, enter the droplet admin key,
   confirm every card fills in and each "open full admin" link lands on the
   right instance. **Code updates from then on: `admin-hub/deploy-hub.sh`**
   (same restart + version-checking health gate as instance deploys).
