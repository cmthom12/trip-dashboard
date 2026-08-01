# Stage 1 — Runtime & Dependency Upgrade (Node 24 LTS)

**What this stage does:** moves the platform off end-of-life Node 20 onto **Node 24 LTS**, and
refreshes the two server dependencies. No application code changes — only the runtime and pins.

| | Before | After | Why |
|---|---|---|---|
| Node.js | 20.20.2 (**EOL Apr 30 2026**) | **24 LTS** (supported to Apr 2028) | Unpatched runtime → supported runtime |
| express | ^4.19.2 | **^4.22.2** | Picks up the 4.20+ fixes (send/serve-static XSS, path-to-regexp ReDoS). Still v4 — the v4→v5 migration is Stage 2. |
| better-sqlite3 | ^12.9.0 | **^12.11.1** | Latest 12.x; ships a **prebuilt binary for Node 24** (`engines: …24.x…`), so install needs no compiler |

**Verified already:** the app passes its full 13-point smoke test on Express 4.22.2 running on a
current-LTS Node, and `server.js` uses no Node-removed APIs (only `crypto.createHash`/`randomBytes`,
`express`, `better-sqlite3`, `path`). The one thing that must run on a real Node 24 host — the native
`better-sqlite3` install — is the canary below.

> **Do this on a STAGING copy, not production.** For your production server specifically, hold this
> until after the trip. These same steps apply when you're ready.

---

## Pre-flight
```bash
# on the staging server
cp /var/www/trip-dashboard/data.db ~/data.db.backup-$(date +%F)   # back up the DB (it is NOT touched, but be safe)
node -v                                                            # note the current version for rollback
```

## Upgrade steps (on the staging server)

**1. Install Node 24.** Two options — pick one.

Via NodeSource (system-wide, matches `provision.sh`):
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs
node -v        # expect v24.x
```
Or via nvm (per-user; respects the bundled `.nvmrc`):
```bash
nvm install 24 && nvm use 24
```

**2. Re-point PM2 at the new Node** (PM2's daemon is tied to the Node it was started under):
```bash
sudo npm install -g pm2     # reinstall pm2 for Node 24
pm2 update                  # respawn the PM2 daemon under Node 24
```

**3. Reinstall dependencies clean** (in the app dir):
```bash
cd /var/www/trip-dashboard
rm -rf node_modules package-lock.json
npm install
```
Confirm `better-sqlite3` came down **prebuilt** (no compile):
```bash
npm ls better-sqlite3                                   # expect 12.11.x
node -e "require('better-sqlite3'); console.log('native module loads OK')"
npm audit                                               # review; should be clean or low
```
> If you ever see `node-gyp rebuild` churn here, the prebuilt for your exact ABI wasn't found and it
> compiled from source instead — still fine (`build-essential` + `python3` are installed by
> `provision.sh`), just slower. On Node 24 the prebuilt should be found.

**4. Restart the app and verify:**
```bash
pm2 reload ecosystem.config.js
pm2 list                                                # app "trip-dashboard" online
curl -s localhost:3000/api/health                       # -> {"status":"ok", ...}
# quick login smoke (placeholder user; pick any 4-digit PIN on first login):
curl -s -X POST localhost:3000/api/login -H 'Content-Type: application/json' \
  -d '{"name":"Alex","pin":"1234"}'                      # -> {"ok":true,"token":"...","firstTime":true}
```

## Canary (24 h)
Leave staging on Node 24 for ~24 hours and watch:
```bash
pm2 logs trip-dashboard --lines 100      # errors?
pm2 describe trip-dashboard              # memory/restarts stable?
```
Then promote (deploy to the real target the same way, or just keep this box as the new baseline).

## Rollback (low-risk — `data.db` is never modified by this stage)
```bash
# reinstall the prior Node, then:
cd /var/www/trip-dashboard
git checkout package.json 2>/dev/null || true   # or restore the old express/better-sqlite3 pins by hand
rm -rf node_modules package-lock.json && npm install
sudo npm install -g pm2 && pm2 update && pm2 reload ecosystem.config.js
```
Your DB backup from pre-flight is there if you need it, but this stage doesn't write to `data.db`.

---

**Next:** Stage 2 (Express 4 → 5) or Stage 3 (HTTPS) per the roadmap in
`Update_Path_and_Recommendations.md`.
