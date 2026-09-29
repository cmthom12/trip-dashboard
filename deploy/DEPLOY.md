# Deploying the Trip Dashboard with HTTPS

This kit puts one or more trips on a server (a $4–6/mo cloud VM is plenty), each behind
Nginx with a real TLS certificate. Three scripts, all run from your laptop except the
first:

```
provision.sh            (on the server, once)   -> installs Node, Nginx, PM2, certbot, firewall
deploy/new-trip.sh <n>  (laptop, once per trip)  -> creates the trip: app dir, .env, PM2
                                                    process, Nginx site, certificate
deploy/deploy.sh <n>    (laptop, every update)   -> ships new CODE to that trip, restarts
                                                    it, checks the version it now reports
```

Each trip lives at `https://<n>.<your domain>`, in `/var/www/trips/<n>/` on the server,
under the PM2 process `trip-<n>`. `docs/MULTI_INSTANCE.md` is the full reference; this page
is the short path.

> **Updated v0.25.1.** Earlier versions of this page described a single-app
> `deploy.sh` that copied `ecosystem.config.js` and started the app itself. That script
> was replaced by `deploy.sh v2` (code only, one named instance, restart + version
> check) and `new-trip.sh` (everything a new instance needs).

---

## Pick your certificate type first

**Domain (what the scripts do).** Buy a cheap domain (~$10–15/yr) and give every trip a
subdomain `A` record pointing at your server's IP. Each trip gets a standard **90-day
certificate that auto-renews** and is trusted everywhere. `new-trip.sh` refuses to run
until the trip's name resolves to the server.

**Bare IP (no domain) — not covered by new-trip.sh.** Let's Encrypt issues certificates
for a raw public IP only as short-lived **~6-day** certs, and the Nginx plugin can't install
them. `deploy/setup-https.sh` (`CERT_MODE=ip`) still shows how to do it for a single app
by hand, but nothing else in the kit supports that layout any more. Private/LAN IPs
(192.168.x, 10.x) are never eligible.

---

## Prerequisites
- An Ubuntu 22.04/24.04 server with a **public IP** and ports **80 + 443** open (at the
  provider's firewall as well as `ufw`).
- A domain whose DNS you control. For each trip, an `A` record `<n>.<domain>` → the
  server IP (and `AAAA` if you use IPv6). Let it propagate before creating the trip.
- SSH access from your laptop with a key.
- `deploy/deploy.local.env` on the laptop (copy `deploy/deploy.local.env.example`):
  `SERVER`, `SSH_KEY`, `PUBLIC_SUFFIX` (your domain), `CERT_EMAIL`. It is gitignored, so
  the tracked scripts never need editing.

---

## Step 1 — provision the server (once)
```bash
scp -i ~/.ssh/YOUR_KEY deploy/provision.sh root@YOUR_SERVER_IP:/root/
ssh  -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "bash /root/provision.sh"
```
Ends by printing the Node (24.x), Nginx, PM2 and certbot versions. Edit `NODE_MAJOR` at
the top of the script first if you want Node 22.

## Step 2 — create a trip (laptop, once per trip)
From the repo root, clean and on `main`:
```bash
deploy/new-trip.sh smith --dry-run      # prints the whole plan, changes nothing
deploy/new-trip.sh smith --yes          # does it
```
Add `--trip-json path/to/smith-trip.json` to install your real trip on this first
deploy (it is validated first); without it the trip starts with the sample data and you
import the real one later through the admin page or the API.

What it does, in order: refuses if anything named `smith` already exists (dir, PM2
process, Nginx site, certificate) or the DNS doesn't point here → creates
`/var/www/trips/smith/` with a fresh `.env` → copies the ecosystem template → adds the
row to `deploy/instances.local.conf` → ships the code (`deploy.sh` pass 1 — its restart
fails on purpose, the process doesn't exist yet) → installs `--trip-json` if given →
`pm2 start ecosystem.config.js && pm2 save` → `deploy.sh` pass 2 (restart + version
check) → Nginx + certificate → checks health, version and HTTPS. It ends with a short **next steps** list (share the admin key, optional family
sign-in) — do those on the server.

Type the `--yes` line yourself rather than pasting it inside a larger block: the script
asks for confirmation with `read`, and a pasted block would feed it the next line.

## Step 3 — update a trip (laptop, every release)
From the repo root, clean, **on `main` at the release tag**:
```bash
deploy/deploy.sh smith
```
It ships **code only** — `server.js`, `package.json`, `package-lock.json`, `tools/`,
`public/` — and **never** `ecosystem*`, `.env`, `data.db` or `node_modules`, so a deploy
never touches the trip's data. Then `npm install`, `pm2 restart trip-smith`, and a
health gate: the script fails unless `/api/health` answers with the same version as your
local `package.json`.

Quick check from the laptop afterwards:
```bash
curl -s https://smith.YOUR_DOMAIN/api/health     # {"status":"ok","version":"<release>",...}
```

---

## Unknown names get nothing (catch-all site, optional)
Without a default site, nginx answers a hostname it doesn't know — a torn-down trip whose
DNS record still exists, a typo — with the first site alphabetically, under a certificate
warning. `deploy/nginx/catch-all.conf` makes it drop those requests instead (no page, no
certificate); sites reached by name are unaffected. **Not for a bare-IP install:** a
browser sends no name to an IP, so https by IP would be refused too. Install steps and the
two checks to run first are in the file's header; `tools/catchall-rehearsal.sh` checks it
against a real nginx.

## Removing a trip
`deploy/teardown-trip.sh <name> <sha16>` runs on the server (copy it to `/root/`). It only
removes a trip listed in `/root/teardown-allow.txt` (which also names the server), and only
when the live `data.db` matches your archived copy's sha256 with no unwritten WAL. It keeps
the nginx site and `ecosystem.config.js` (never `.env`) in `/root/retired/`, takes the site
out and tests nginx **before** stopping the app (a failed test puts the site back), then
removes the PM2 process, the certificate and the app folder, and checks each is gone. Archive
first (`data.db`, the trip JSON, notes, a profile export); remove the DNS record last.

## Renewal
certbot installs a systemd timer that runs twice daily and renews when due, reloading
Nginx. Verify it any time on the server:
```bash
systemctl list-timers | grep certbot
certbot renew --dry-run
```

## Troubleshooting
- **`deploy.sh: pm2 restart trip-<n> FAILED`** — that trip's PM2 process doesn't exist.
  Create the trip with `new-trip.sh` (or, for a process that was deleted, `cd
  /var/www/trips/<n> && pm2 start ecosystem.config.js && pm2 save`).
- **`HEALTH GATE FAILED`** — the process didn't come back on the new version:
  `pm2 logs trip-<n>` on the server.
- **A new setting in `.env` has no effect** — the `env` block in each trip's
  `ecosystem.config.js` is an **allowlist**. Add the key there, then reload **by file**:
  `cd /var/www/trips/<n> && pm2 reload ecosystem.config.js` (a reload by name keeps the
  old environment).
- **ACME challenge fails (timeout / connection refused)** — port 80 must be open and the
  trip's `A` record must point here and have propagated.
- **`better-sqlite3` tries to compile during `npm install`** — you're on a Node version
  without a prebuilt binary. `provision.sh` installs `build-essential` + `python3` so it
  can compile as a fallback; or switch `NODE_MAJOR` to 22 and re-provision.

## What changes for the *origin* (PWA note)
A trip's URL is its origin. Moving it later (`http://IP` → `https://domain`, or a new
subdomain) is a new origin: anyone who installed the app or signed in under the old URL
has to add it again and sign in again. Decide the final URL before sharing it.
