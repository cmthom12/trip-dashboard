# Server ops runbook

Day-2 operations for a deployed dashboard: automated backups, getting those
backups onto your laptop, and turning on the optional env-var features for an
existing deployment. Everything here is run **by you, deliberately** — nothing
in this folder executes on deploy.

## Nightly database backups (on the server)

`scripts/backup-db.sh` takes a SQLite-safe snapshot of `data.db` (online
`.backup`, safe while the app is running) and prunes its own snapshots after
14 days. Admin-console snapshots (`data.db.backup-admin-*`) are never pruned.

One-time setup on the server:

```bash
chmod +x /var/www/trip-dashboard/scripts/backup-db.sh
crontab -e
```

Add this line (3:10 AM server time, log to /var/log/trip-backup.log):

```
10 3 * * * /var/www/trip-dashboard/scripts/backup-db.sh >> /var/log/trip-backup.log 2>&1
```

Different app dir or retention? Prefix env vars in the cron line:
`APP_DIR=/srv/trip KEEP_DAYS=30 /srv/trip/scripts/backup-db.sh …`

## Weekly off-server copy (from your laptop)

A backup that lives only on the server dies with the server. Once a week, from
Git Bash on your laptop, pull the latest snapshot down:

```bash
scp -i ~/.ssh/YOUR_KEY "root@YOUR_SERVER_IP:/var/www/trip-dashboard/data.db.backup-$(date +%Y%m%d)*" ~/trip-backups/
```

(If the exact-date glob misses — the cron ran on a different date — list what's
there first: `ssh -i ~/.ssh/YOUR_KEY root@YOUR_SERVER_IP "ls -lt /var/www/trip-dashboard/data.db.backup-* | head"`.)

To restore: stop the app, replace `data.db` with the snapshot, start the app —
`pm2 stop trip-dashboard && cp data.db.backup-XXXX data.db && pm2 start trip-dashboard`.

## Enabling ADMIN_KEY / CORS_ORIGIN on an existing deployment

Both features are opt-in env vars read at boot. For a PM2 deployment, set them in
`ecosystem.config.js` **on the server** (this file stays on the server; never
commit a real key), then restart with `--update-env`:

```js
// /var/www/trip-dashboard/ecosystem.config.js  → inside the app entry:
env: {
  PORT: 3000,
  ADMIN_KEY: "your-long-random-key",                    // enables /admin.html (see ADMIN.md)
  CORS_ORIGIN: "https://your-dashboard-domain.example"  // pins CORS to your site
}
```

```bash
pm2 restart ecosystem.config.js --update-env && pm2 save
```

Check they took:

```bash
curl -s -D - -o /dev/null https://your-dashboard-domain.example/api/health | grep -i access-control
# → Access-Control-Allow-Origin: https://your-dashboard-domain.example
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Admin-Key: your-long-random-key" https://your-dashboard-domain.example/api/admin/overview
# → 200 (or 404 if ADMIN_KEY didn't take)
```

`pm2 save` matters: without it a server reboot resurrects the old env.
