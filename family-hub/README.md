# family-hub — the family portal (Phase 2: one sign-in for every trip)

One public page at your apex domain (`https://example.com` in this template —
the real one lives only in the gitignored `.env`) where a family member signs in
**once** and sees every trip as a card: their own trips highlighted and sorted
first, each linking straight through to `https://<instance>.example.com` — and
landing there **already signed in**.

It is the family-facing sibling of [`admin-hub/`](../admin-hub) and copies its
conventions deliberately: same `.env` reader, same instance discovery, same
`/api/health` shape, same pm2/deploy kit. Where the admin hub is one operator
looking at everything, this is everyone looking at their own trip.

**What it is not:** no `ADMIN_KEY`, no trip data, no writes to any instance, no
service worker, no CDN, no framework. The trip list is still a read-only
consumer of each instance's already-public `GET /api/trip`. The only state the
portal owns is one PIN per family member.

> **HAZARD — placement.** Its droplet home is `/var/www/family-hub`. Like the
> admin hub it must **never** live under `/var/www/trips`: it would discover
> itself as an "instance" and `deploy/backup-all.sh` would sweep its directory
> into the db-backup loop.

---

## How it works

**Discovery** — every subdirectory of `TRIPS_DIR` (`/var/www/trips`) that
contains a `.env` is an instance: the name is the dirname, the `PORT` comes
from that `.env`. Identical rule to `admin-hub` and `deploy/backup-all.sh`, so
a new trip appears in the portal the moment it is deployed — nothing to
register.

**Fan-out** — `GET /api/trips` fetches `http://127.0.0.1:<port>/api/trip` from
each instance with a 2-second timeout and caches the whole list in memory for
5 minutes. An instance that is down, restarting or has no trip configured comes
back as `reachable: false` (dimmed, unlinked card) instead of failing the page.

**What can leave the portal** — the projection is an allowlist, not a filter:

```
{ name, url, title, subtitle, brand, startDate, endDate,
  family: ["…names only…"], theme, reachable }
```

Days, activities, reservations, flights, traveler colors/interests and instance
ports are never read, so they cannot leak through this public endpoint no
matter what an instance returns. Keep it that way if you extend the shape.

**Who may sign in** — `FAMILY_NAMES` in the portal's `.env` (comma-separated).
It is served to the page by `GET /api/config`, so the name list lives in exactly
one place and no tracked file carries a real one. Guests are deliberately still
excluded: a guest is on exactly one trip, reaches it by its own link, and signs
in there with that trip's own PIN — unchanged by any of this.

---

## Family SSO

Sign in at the portal, open any trip, and it already knows who you are.

```
  portal                                         trip instance
  ------                                         -------------
  POST /api/portal/login {name, pin}
    → checks its own users table
    → Set-Cookie: fam_sso=<payload>.<hmac>
        Domain=.example.com; HttpOnly; SameSite=Lax; 90d
                                                 GET /api/sso   (cookie rides along)
                                                   → verifies the HMAC with the
                                                     SAME shared secret
                                                   → name must be on THIS trip
                                                   → mints a normal session token
                                                 → {ok, token, name}
```

**The cookie is self-contained and stateless.** Its value is
`base64url(JSON{n:<name>, exp:<unix-ms>}) . base64url(HMAC-SHA256(secret, part1))`.
There is no session table on either side: a trip verifies the signature itself
and never calls the portal, so a portal outage cannot lock anyone out of a trip
that is already open, and no shared session store has to exist.

**One shared secret, `FAMILY_SSO_SECRET`.** The portal signs with it; every
instance verifies with it. `deploy/sync-sso-secret.sh` generates it once and
writes it into the portal's `.env` and each instance's `.env` (see below).

**It is off by default, on both sides.**

| Where | With no `FAMILY_SSO_SECRET` |
| --- | --- |
| portal | login still works, no cookie is issued, the UI says auto sign-in is off — i.e. exactly the Phase-1 launcher |
| trip instance | `GET /api/sso` returns **404**: the feature is invisible and the app is byte-for-byte what it was |

So SSO switches on per instance, which is what makes a staged rollout possible
(`sync-sso-secret.sh --only <instance>`).

**What the trip app does with the cookie** — `GET /api/sso` in the root
`server.js` verifies it, checks the name is on *this* trip, and mints a token
the same way `POST /api/login` does, minus the users-table work: `user_tokens`
is the sole authority for a token, so no `users` row is created and no PIN is
ever seen by the instance. The client tries it only when it finds no `tg_token`
in `localStorage`; 404, 401 and network failure all fall through to the usual
PIN screen. Someone with no portal account, or whose cookie names a person this
trip doesn't list, simply sees the PIN screen — the trip's own membership list
is still the authority on who gets in.

**Credentials** — a PIN is claimed first-come, exactly like the trip app: no
row yet means whoever signs in first sets it. Wrong PINs get the same
5-strikes / 30-minute in-memory lockout, which a restart clears by design.
Forgotten PIN: `node tools/portal-reset-pin.js <name>` (see its `--help`) —
deleting the row re-opens first-time claim. Note that clearing a PIN does not
invalidate cookies already issued; only rotating the secret does that.

**Signing out** clears the cookie at the portal. Trips already opened keep their
own `tg_token` session until it is cleared there — the two are deliberately
independent, so signing out of the portal on a shared laptop is not the same as
being kicked out of a trip mid-week.

---

## Run it locally

`/var/www/trips` doesn't exist on a laptop, so the portal falls back to a dev
instance map and can run against real instances:

```bash
cd family-hub
cp instances.dev.json.example instances.dev.json   # gitignored; put real names/URLs here
FAMILY_SSO_SECRET=$(openssl rand -hex 24) node server.js   # → http://localhost:3011
```

Leave `COOKIE_DOMAIN` unset locally: the cookie becomes host-only, which is what
you want when everything is `localhost`. To exercise the whole round trip, start
one trip instance with the **same** secret on another port and sign in at the
portal first:

```bash
curl -s 127.0.0.1:3011/api/health   # {"status":"ok","version":"1.1.0","sso":true,…}
curl -s 127.0.0.1:3011/api/config   # {"names":[…],"suffix":"…","sso":true,…}
curl -s 127.0.0.1:3011/api/trips    # one row per dev instance

curl -s -c /tmp/j -X POST 127.0.0.1:3011/api/portal/login \
  -H 'Content-Type: application/json' -d '{"name":"Alex","pin":"1234"}'
curl -s -b /tmp/j 127.0.0.1:3005/api/sso   # → {"ok":true,"token":"…","name":"Alex"}
```

`data.db` is created next to `server.js` on first boot and is gitignored. Delete
it to reset every PIN. There is no build step: `public/index.html` is the whole
front end, edit and refresh.

Dependencies are Express and better-sqlite3 (same versions the trip app pins),
resolved from the repo root's `node_modules` locally and installed standalone on
the droplet.

---

## Config

`deploy/env.template` → `/var/www/family-hub/.env` (`chmod 600` — since v1.1.0
this file holds a secret).

| Key | Default | What it does |
| --- | --- | --- |
| `PORT` | `3011` | localhost port nginx proxies the apex domain to |
| `TRIPS_DIR` | `/var/www/trips` | where instances are discovered; if it doesn't exist, `instances.dev.json` is used instead |
| `PUBLIC_SUFFIX` | `example.com` | card links are `https://<instance-name>.<suffix>` |
| `FAMILY_NAMES` | `Alex,Sam,…` | comma-separated; who may sign in. Must match the spelling in each trip's family list, or SSO lands on that trip's PIN screen |
| `FAMILY_SSO_SECRET` | *(empty)* | the shared signing secret. Empty = SSO off. Set it with `deploy/sync-sso-secret.sh` |
| `COOKIE_DOMAIN` | *(empty)* | e.g. `.example.com`, so every `<trip>.example.com` sees the cookie. Empty = host-only (localhost dev) |
| `NODE_ENV` | `production` | leave as-is on the droplet |

`deploy/ecosystem.template.config.js`'s `env` block is an **allowlist**: a key
it doesn't name never reaches `process.env`, however right the `.env` line is.
The same is true of each trip instance's `deploy/ecosystem.template.config.js`
— an instance whose ecosystem config doesn't pass `FAMILY_SSO_SECRET` through
will keep answering **404** on `/api/sso` after a perfectly successful secret
sync. `sync-sso-secret.sh` probes for exactly that and prints the fix.

---

## Deploy

First-time install is **by hand and supervised** — same seven beats as
`docs/MULTI_INSTANCE.md` §ADMIN-HUB, with the apex domain and port `3011`.
Placeholders as usual; substitute your real domain for `example.com`.

1. **DNS**: A record `example.com` (the apex) → `<droplet-ip>`, DNS-only
   / grey cloud. *Rollback: delete the record.*
2. **nginx**: copy `deploy/nginx/trip-dashboard.conf.template` to
   `/etc/nginx/sites-available/family-hub`, fill `__SERVER_NAME__` =
   `example.com`, `__APP_PORT__` = `3011`, `__WEBROOT__`/`__CERT_DIR__`
   per the template header; symlink into `sites-enabled`, then
   `nginx -t && systemctl reload nginx`. *Rollback: remove the symlink, reload.*
3. **Cert**: `certbot certonly --webroot -w /var/www/letsencrypt -d example.com`,
   then enable the TLS lines. *Rollback: `certbot delete --cert-name example.com`.*
4. **Code**: `mkdir -p /var/www/family-hub`, copy `family-hub/server.js`,
   `family-hub/package.json`, `family-hub/lib/` and `family-hub/public/` up
   (first time by hand — `deploy/deploy-family-hub.sh` needs the pm2 process to
   exist, see step 6), then `cd /var/www/family-hub && npm install --omit=dev`.
   *Rollback: `rm -rf /var/www/family-hub` — but note that from v1.1.0 the PINs
   live here in `data.db`, so back it up first if anyone has set one.*
5. **Env**: `cp family-hub/deploy/env.template /var/www/family-hub/.env`, keep
   `PORT=3011`, set `PUBLIC_SUFFIX`, `FAMILY_NAMES` and `COOKIE_DOMAIN`, leave
   `FAMILY_SSO_SECRET` empty for now, `chmod 600 .env`. *Rollback: delete the file.*
6. **PM2**: `cp family-hub/deploy/ecosystem.template.config.js /var/www/family-hub/ecosystem.config.js`,
   then `cd /var/www/family-hub && pm2 start ecosystem.config.js && pm2 save`.
   *Rollback: `pm2 delete family-hub && pm2 save`.*
7. **Verify**: `curl -s http://127.0.0.1:3011/api/health` → `{"status":"ok",…}`;
   `curl -s http://127.0.0.1:3011/api/trips` → one row per trip, `reachable:true`;
   open the portal on a phone, sign in, confirm the highlighted cards are right
   and each card lands on the correct trip.

**Turning SSO on (staged):**

```bash
deploy/sync-sso-secret.sh --only <one-instance>   # portal + one candidate trip
# … live with it for a day, then:
deploy/sync-sso-secret.sh                         # portal + every instance
```

It finds or generates one 48-hex secret, writes `FAMILY_SSO_SECRET` into each
target `.env` (`chmod 600`), pm2-reloads each, and prints a fingerprint + probe
table. A healthy instance probes **401** on `/api/sso` (the route exists; no
cookie was sent); **404** means the process never got the secret — see the
allowlist note under Config. *Rollback: blank `FAMILY_SSO_SECRET` in the `.env`
and reload; the instance's `/api/sso` goes back to 404 and everyone falls back
to PINs.*

**Code updates from then on:**

```bash
family-hub/deploy/deploy-family-hub.sh
```

It takes `SERVER`/`SSH_KEY` from the gitignored `deploy/deploy.local.env` (the
same file `deploy/deploy.sh` and `admin-hub/deploy-hub.sh` use, which may also
override `FAMILY_DIR`/`FAMILY_PORT`), ships **code only** — never `.env`,
`ecosystem*`, `instances.dev.json`, `data.db` or `node_modules` — runs
`npm install --omit=dev`, restarts pm2, and gates on `/api/health` reporting the
version it just pushed. A failed gate leaves the old process's logs to read
(`pm2 logs family-hub`).

---

## Boundaries

Still out of scope, in rough order of likely next: per-person "what's next"
pulled from each trip's day plan; guests in the picker; a countdown on upcoming
trips; any write path into a trip. Also deliberately absent: cookie revocation
(rotate the secret instead), password reset by email, and any notion of roles —
the portal says *who you are*, and each trip decides on its own what you may do.
