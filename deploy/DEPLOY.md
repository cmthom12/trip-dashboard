# Deploying the Trip Dashboard with HTTPS

This kit puts the app on a server (a $4–6/mo cloud VM is plenty), behind Nginx with a
real TLS certificate. Three small steps, two of them copy-paste.

```
provision.sh   (on the server, once)   -> installs Node, Nginx, PM2, certbot, firewall
deploy.sh      (from your laptop)      -> pushes the app, starts it under PM2
setup-https.sh (on the server)         -> gets the certificate, turns on HTTPS
```

---

## Pick your certificate type first

**Domain (recommended).** Buy a cheap domain (~$10–15/yr), point an `A` record at your
server's IP, and you get a standard **90-day certificate that auto-renews** and is trusted
everywhere. This is the sturdy, set-and-forget option.

**Bare IP (no domain).** Let's Encrypt now issues certificates for a raw public IP, but
**only as short-lived ~6-day certs**, and the Nginx plugin can't install them, so this kit
gets the cert by webroot and reloads Nginx on each renewal. It works, but the margin is
thin: if the server is offline for a few days the cert lapses and browsers warn until it
renews. Fine for a personal always-on box; a domain is better for anything you hand to
family. Requires **certbot ≥ 5.4** (the snap install in `provision.sh` gives you that).

> Private/LAN IPs (192.168.x, 10.x) are **not** eligible — only public IPs.

---

## Prerequisites
- An Ubuntu 22.04/24.04 server with a **public IP** and ports **80 + 443** open.
- For domain mode: a domain with an `A` record (and `AAAA` if you use IPv6) pointing at
  that IP. Let the DNS propagate before step 3.
- SSH access from your laptop with a key (the kit assumes key auth).

---

## Step 1 — provision the server (once)
Copy `provision.sh` to the server and run it as root:
```bash
scp -i ~/.ssh/YOUR_KEY deploy/provision.sh root@YOUR_SERVER_IP:/root/
ssh  -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "bash /root/provision.sh"
```
Edit the three variables at the top of the script first if you want a different Node
version or app path.

## Step 2 — deploy the app (from your laptop)
In the project folder (the one containing `server.js` and `public/`), edit the three
variables at the top of `deploy/deploy.sh` (`SERVER`, `SSH_KEY`, `APP_DIR`), then:
```bash
bash deploy/deploy.sh
```
This copies `server.js`, `public/`, `package.json`, and `ecosystem.config.js`, runs
`npm install`, and starts the app under PM2. It deliberately **never copies
`node_modules` or `data.db`**, so re-deploying never clobbers the live database.

Quick check that the app is up (plain HTTP, before TLS):
```bash
ssh -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "curl -s localhost:3000/api/health"
# -> {"status":"ok", ...}
```

## Step 3 — turn on HTTPS (on the server)
Edit the variables at the top of `deploy/setup-https.sh`:
- `SERVER_NAME` = your domain (or the public IP for ip mode)
- `CERT_MODE` = `domain` or `ip`
- `EMAIL` = a real address (renewal/expiry notices)

Then run it as root:
```bash
ssh -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "bash /var/www/trip-dashboard/deploy/setup-https.sh"
# (or scp the deploy/ folder up and run it from there)
```
When it finishes:
```bash
curl -I https://YOUR_DOMAIN_OR_IP/      # expect: HTTP/2 200
```
Open the site, log in, done.

> **Test runs:** IP certs are rate-limited (5 per identical IP per 168h). To rehearse,
> add `--staging` (or `--test-cert`) to the certbot command in `setup-https.sh` first —
> you'll get an untrusted test cert, but you'll confirm the whole flow works. Remove it
> for the real cert.

---

## Updating later
Just re-run `deploy/deploy.sh` from your laptop. It re-uploads the app and `pm2 reload`s
it with zero downtime. The certificate and Nginx config stay as they are.

## Renewal
certbot installs a systemd timer that runs twice daily and renews when due, reloading
Nginx via the deploy-hook. Verify it any time:
```bash
systemctl list-timers | grep certbot
certbot renew --dry-run        # domain mode
```

## Troubleshooting
- **`nginx -t` fails on cert paths** — the cert wasn't issued. Re-check step 3's certbot
  output; the script stops before enabling HTTPS if the cert is missing.
- **ACME challenge fails (timeout / connection refused)** — port 80 must be open and
  reaching this server; for domain mode the `A` record must point here and have propagated.
- **`better-sqlite3` tries to compile during `npm install`** — you're on a Node version
  without a prebuilt binary. `provision.sh` installs `build-essential` + `python3` so it
  can compile as a fallback; or switch `NODE_MAJOR` to 22 and re-provision.
- **App not responding on :3000** — `pm2 logs trip-dashboard` on the server.

## What changes for the *origin* (PWA note)
Moving from `http://IP` to `https://domain` is a new origin: anyone who installed the PWA
or logged in under the old URL will need to re-add it and log in again. Decide your final
URL before sharing it widely.
