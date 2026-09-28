# PREFLIGHT — supervised deploy checklist

Companion to `DEPLOY.md`. Work top to bottom; every ☐ is either a command to run or a
decision to make. Nothing here runs automatically. Updated v0.25.1 for `deploy.sh v2`
(one named trip, code only) and `new-trip.sh` (creating a trip).

---

## 0. Decisions to make first

- ☐ **DECISION [final URL]:** each trip's origin is `https://<name>.<your domain>`.
  **Changing it later is a NEW origin: every installed app and sign-in is lost and must
  be re-done** (`DEPLOY.md` §"What changes for the origin"). Pick the name *before*
  sharing anything.
- ☐ **DECISION [canary]:** with several trips on one server, pick one to deploy first
  and check in a browser before the others.
- ☐ **DECISION [data changes]:** read the release notes for a one-time data change on
  first start (v0.25.0's packing move is one). A release like that can't be undone by
  deploying the older code alone — see §5.

## 1. Before touching the server

- ☐ The release is merged, tagged, and pushed; you are **on `main` at the tag**:
  `git describe --tags --exact-match` prints the tag, `git status --porcelain` prints
  nothing. `deploy.sh` ships your working tree, so what's in the folder is what goes.
- ☐ `deploy/deploy.local.env` exists with `SERVER`, `SSH_KEY` (and, for a new trip,
  `PUBLIC_SUFFIX`, `CERT_EMAIL`).
- ☐ `deploy/instances.local.conf` has a row for the trip: `<name>  <app-dir>  <port>`.
  (`new-trip.sh` adds it; `deploy.sh <name>` lists the known names if you get one wrong.)
- ☐ New trip only: its `A` record resolves to the server (`nslookup <name>.<domain>
  1.1.1.1`), and ports 80 + 443 are open at the provider firewall too.

## 2. Provision (once per server)

```bash
scp -i ~/.ssh/YOUR_KEY deploy/provision.sh root@YOUR_SERVER_IP:/root/
ssh  -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "bash /root/provision.sh"
```
- ☐ Ends with node v24.x, nginx, PM2, certbot versions printed.

## 3. Back up, then deploy

- ☐ **Back up the trip's database first** (nightly copies under
  `/root/db-backups/<name>/` exist once `backup-all.sh` runs from cron, but take one
  now). `sqlite3 .backup` makes a consistent copy while the app is running;
  `provision.sh` installs the `sqlite3` tool. The `test -s` stops a mistyped name
  from "backing up" a new empty file:
```bash
ssh -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP \
  "test -s /var/www/trips/<name>/data.db && sqlite3 /var/www/trips/<name>/data.db \".backup /root/data.db.<name>.pre-deploy-$(date +%F)\" && echo backed up"
```
- ☐ New trip: `deploy/new-trip.sh <name> --dry-run`, read the plan, then type
  `deploy/new-trip.sh <name> --yes`.
- ☐ Existing trip, from the repo root:
```bash
deploy/deploy.sh <name>
```
  Ships `server.js`, `package.json`, `package-lock.json`, `tools/`, `public/`. Never
  ships `ecosystem*`, `.env`, `data.db`, `*.backup-*` or `node_modules`. Ends with
  `deployed: '<name>' is healthy on port … at v<release>.` — anything else stops the
  rollout.
- ☐ Verify from the laptop:
```bash
curl -s https://<name>.<domain>/api/health
```

## 4. Post-deploy check (in a real browser, over https://)

- ☐ Fully close the app on the phone first — a page left open keeps running the old
  code.
- ☐ Signed out (a private tab): only the sign-in screen, no trip content.
- ☐ Sign in: the trip loads; add a note, reload, still signed in, note kept.
- ☐ Map tab shows tiles and pins (the *phone* needs internet for tiles, not the server).
- ☐ Airplane mode, reopen from the home screen: the trip still opens.
- ☐ The checks the release notes list for this version.
- ☐ Then the next trip, same steps.

## 5. Rollback

- **Code:** check out the previous tag (`git checkout v<previous>`) and run
  `deploy/deploy.sh <name>`. The health gate checks that version. `data.db` is never
  touched by a deploy.
- **Data changes:** a release that migrated data on first start is not undone by
  deploying older code — read its notes (v0.25.0: per-person packing ticks are invisible
  to v0.24, so those items show unticked).
- **Database:** stop the trip, restore a backup, start it:
```bash
ssh -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP \
  "pm2 stop trip-<name> && cp /root/data.db.<name>.pre-deploy-<date> /var/www/trips/<name>/data.db && pm2 start trip-<name>"
```
