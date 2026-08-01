# PREFLIGHT — supervised HTTPS deploy checklist

Companion to `DEPLOY.md`. Work top to bottom; every ☐ is either a command to run or a
decision to make. Nothing here runs automatically.

**Verified locally before this deploy** (see the overnight report): the app serves,
logs in, writes (with idempotent replay), and boots the full PWA behind a local
TLS-terminating proxy identical in shape to the nginx config in this kit. The server
code has no protocol/origin assumptions (no cookies, no absolute URLs, token-header
auth), and the map's tile source is `https://` (no mixed content).

---

## 0. Decisions to make first

- ☐ **DECISION [domain vs ip]:** domain mode (90-day auto-renewing cert, recommended)
  or bare-IP mode (~6-day cert, thin renewal margin, browser warnings if the box is
  ever down for days). Private/LAN IPs are not eligible.
- ☐ **DECISION [final URL]:** the origin you turn on tomorrow is the origin everyone
  keeps. **Moving from `http://IP` to `https://domain` later is a NEW origin: every
  installed PWA and login is lost and must be re-done** (`DEPLOY.md` §"What changes
  for the origin"). Pick the final URL *before* sharing anything.
- ☐ **DECISION [rehearsal]:** for a first run, rehearse certbot with `--staging`
  (see step 4) — especially in IP mode, which is rate-limited to 5 certs per IP per
  168 h. A failed real attempt burns quota.

## 1. Before touching the server

- ☐ Merge the reviewed branches; deploy from `main` (or the agreed branch).
- ☐ `git status` clean in the project folder; `npm start` + `curl -s localhost:3000/api/health` → `{"status":"ok"}`.
- ☐ Confirm the deploy scripts' EDIT-ME headers are filled in:
  - `deploy/deploy.sh` → `SERVER`, `SSH_KEY`, `APP_DIR`
  - `deploy/setup-https.sh` → `SERVER_NAME`, `CERT_MODE`, `EMAIL`
- ☐ Ports 80 + 443 open at the provider firewall too, not just ufw.
- ☐ Domain mode only: `A` record (and `AAAA` if IPv6) points at the server IP and
  has propagated (`nslookup YOUR_DOMAIN`).

## 2. Provision (once per server)

```bash
scp -i ~/.ssh/YOUR_KEY deploy/provision.sh root@YOUR_SERVER_IP:/root/
ssh  -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "bash /root/provision.sh"
```
- ☐ Ends with node v24.x, nginx, PM2, certbot ≥ 5.4 versions printed.

## 3. Back up the live DB, then deploy the app

- ☐ **If this server already ran the app, back up `data.db` FIRST:**
```bash
ssh -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP \
  "cp /var/www/trip-dashboard/data.db /root/data.db.backup-$(date +%F) 2>/dev/null || echo 'no data.db yet'"
```
- ☐ From the project folder on the laptop:
```bash
bash deploy/deploy.sh
```
  (Copies `server.js`, `package.json`, `package-lock.json`, `ecosystem.config.js`,
  and all of `public/` — which now includes `manifest.json`, `sw.js`, and the icons.
  Never copies `node_modules` or `data.db`.)
- ☐ Note: `scp -r` adds/overwrites but never deletes — if a file was *removed* from
  `public/` locally, delete it on the server by hand.
- ☐ Verify over plain HTTP before TLS:
```bash
ssh -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "curl -s localhost:3000/api/health"
```

## 4. HTTPS

- ☐ (Rehearsal, recommended) add `--staging` to the certbot command in
  `setup-https.sh`, run it once, confirm the flow completes with a test cert,
  then remove `--staging` and run again for the real cert.
- ☐ Real run, on the server:
```bash
ssh -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "bash /var/www/trip-dashboard/deploy/setup-https.sh"
```
- ☐ `curl -I https://YOUR_DOMAIN_OR_IP/` → `HTTP/2 200`.
- ☐ Domain mode only, once stable: consider enabling the commented HSTS line in
  `deploy/nginx/trip-dashboard.conf.template` site config. **Never with an IP cert.**

## 5. Post-deploy smoke test (in a real browser, over https://)

- ☐ Load the site, log in, land on the itinerary.
- ☐ Map tab shows tiles and pins (tiles come from openstreetmap.org — the *client*
  needs internet, not the server).
- ☐ Add a note; hard-refresh: still signed in, same tab, note persisted.
- ☐ Install the PWA (phone or desktop) and reopen it once.
- ☐ `systemctl list-timers | grep certbot` shows the renewal timer.
- ☐ IP mode only: diarize that the cert self-renews every ~6 days *only while the
  box and timer stay up*.

## 6. Rollback

- App code: re-run `bash deploy/deploy.sh` from any earlier checkout — `data.db` is
  never touched by deploys.
- DB: restore the step-3 backup (`cp /root/data.db.backup-… /var/www/trip-dashboard/data.db`
  with the app stopped: `pm2 stop trip-dashboard`, copy, `pm2 start trip-dashboard`).
