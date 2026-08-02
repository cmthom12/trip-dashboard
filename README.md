# Trip Dashboard — Clean Template

A self-hosted family-trip dashboard (React PWA + Node/Express + SQLite). This is a
**clean template seeded with synthetic sample data — it contains no personal data.**
Replace the sample trip with your own and you have a working dashboard for any trip.

Sample travelers: **Alex, Sam, Jordan, Riley, Casey**. Sample trip: a 4-day
"Sample Family Trip" (Arrival → Old City → Seaside → Departure).

> **New here?** Read **[`START_HERE.md`](START_HERE.md)** first. The fastest way to make it
> your own is to let an AI fill in your trip — see **[`BUILD_WITH_AI.md`](BUILD_WITH_AI.md)**.
> The rest of this README is the by-hand reference.

---

## What it does
- Per-person interest voting on activities, with "consensus" highlights
- Shared **Bookings** list and a **Day Plan**, kept in a two-way mirror (add a booking
  to the plan and the pair stays linked; deletes cascade)
- Packing list, notes, suggestions, flight cards
- Calendar (.ics) export of the timed day plan, timezone-aware
- PIN login per traveler; trip planners can edit the day plan
- All data lives in a single `data.db` file on the server

---

## Requirements
- **Node.js 22 or 24 LTS** — Node 24 recommended, pinned in `.nvmrc`. (Node 20 is end-of-life; don't use it.)
- npm

---

## Quick start (run it locally)

**Windows — no terminal needed:** double-click **`Setup.bat`** once, then
**`Start-Dashboard.bat`** (starts the server and opens the browser; close its window to
stop). **`Apply-Trip.bat`** installs your own trip data — see
[`KICKSTART.md`](KICKSTART.md) for the full beginner walkthrough, including the zip
folder-in-a-folder trap and what to do if the launchers don't work.

**Mac / Linux (or any terminal):**
```bash
npm install
npm start
```
Then open **http://localhost:3000**.

First login: pick any sample traveler (Alex/Sam/Jordan/Riley/Casey) and choose a
4-digit PIN — that PIN is set on first use. Use a different browser/profile to log in
as another traveler.

Change the port with an env var: `PORT=8080 npm start`.

> **Note on `better-sqlite3`.** This package pins `better-sqlite3` to a line that ships
> prebuilt binaries for Node 22 and 24, so `npm install` won't need a compiler on a
> supported runtime. If install tries to compile and fails, you're on an unsupported Node
> version — install Node 24 (see `.nvmrc`), delete `node_modules`, and run `npm install`
> again. See `docs/maintenance/STAGE1_UPGRADE.md` for the full runtime-upgrade runbook.

---

## Make it your trip
Almost everything is data, not code. Open **`public/index.html`** and find the block:

```html
<script type="application/json" id="trip-data"> … </script>
```

Edit these keys:
- **`trip`** — title, brand, subtitle, start/end dates, optional photos URL
- **`family`** — the travelers: `name`, `color` (`[background, text]`), `interests`
- **`days`** — each day: `id`, `label`, `location`, and an `activities` array
- **`dayCoords`** — map pin per day id: `ll: [lat, lng]`, `zoom`, `name`, `date`
- **`flights`**, **`reservationsSeed`**, **`essentials`**, **`embassies`**, **`enrichments`**

Two things to keep in sync when you rename travelers:
1. the names in `family` (in `public/index.html`), **and**
2. `ALLOWED` and `PLANNERS` near the top of **`server.js`** (the login allow-list and
   who may edit the day plan).

Timezone for the calendar/now-clock: set `DEFAULT_TZ` in `public/index.html`
(e.g. `"America/Chicago"`). Optional per-day or per-activity overrides go in the
`DAY_TZ` / `ACT_TZ` objects just below it.

---

## File layout
```
trip-dashboard-template/
├── server.js              # Node/Express + SQLite API
├── public/
│   └── index.html         # the compiled React PWA (single file)
├── package.json
├── ecosystem.config.js    # PM2 process config (for deploying)
├── .nvmrc / .node-version # pins the tested Node version (24)
├── Setup.bat              # Windows: one-time install (double-click)
├── Start-Dashboard.bat    # Windows: start the app + open the browser (double-click)
├── Apply-Trip.bat         # Windows: install your my-trip.json (double-click)
├── tools/                 # validate-trip-data.js + apply-trip-data.js
├── START_HERE.md          # 👈 read this first
├── KICKSTART.md           # from-zero beginner walkthrough (Windows-first)
├── BUILD_WITH_AI.md       # let an AI fill in your trip (no coding)
├── README.md
├── .gitignore
├── docs/maintenance/      # upgrade runbooks (advanced: Node 24, Express 5)
└── deploy/                # HTTPS deploy kit (see deploy/DEPLOY.md)
    ├── DEPLOY.md
    ├── provision.sh       # one-time server setup
    ├── deploy.sh          # push app from your laptop
    ├── setup-https.sh     # get cert + turn on HTTPS (domain or IP)
    └── nginx/trip-dashboard.conf.template
```

## Your data
- `data.db` is created automatically on first run, in the project folder.
- Deploys/updates **never overwrite `data.db`** — back it up by copying the file.
- To reset to an empty dashboard, stop the server, delete `data.db`, start again.

## Live location (optional)
The Map tab has a **"Share my location"** toggle so the family can see where
everyone is during the trip — useful for "where did Dad wander off to" moments.
How it works, and what it deliberately does **not** do:

- **Off by default**, per person, per device, per visit. Nothing is shared until
  you flip the toggle, and closing the app stops updates.
- **Last known position only.** The server keeps exactly one dot per person and
  never stores a history or track. Positions older than **30 minutes** are
  deleted automatically.
- While sharing, a green **"📍 Sharing your location"** chip stays visible on
  every tab — tapping it stops sharing and removes your dot immediately.
- Updates flow **only while the app is open** (a browser rule, not a setting),
  at most every 45 seconds or when you've moved ~100 m.
- Only signed-in family members can see the dots; the map data is never public.

---

## Deploying with HTTPS
A full deploy kit is included in **`deploy/`**. Three steps:
`provision.sh` (one-time server setup) → `deploy.sh` (push the app from your laptop) →
`setup-https.sh` (get a TLS cert and turn on HTTPS). It supports both a **domain
certificate** (90-day, auto-renewing — recommended) and a **bare-IP certificate**
(Let's Encrypt's new short-lived ~6-day cert, for when you don't have a domain).
See **`deploy/DEPLOY.md`** for the walkthrough.
