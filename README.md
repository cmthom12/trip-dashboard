# Trip Dashboard

A private website for planning a family trip together: everyone votes on
activities, sees the day-by-day plan, shares bookings, packing lists and notes —
all on one page that runs on your own computer. No account, no cloud, no cost.

It comes filled with a **pretend sample trip** (travelers Alex, Sam, Jordan,
Riley and Casey) so you can click around first. Then you replace the sample with
your own trip — no coding needed.

## Set it up (about 15 minutes, Windows)

1. **Download and unpack.** On the GitHub page, click the green **Code** button →
   **Download ZIP**. When it's downloaded, right-click the ZIP → **Extract All**,
   and put the folder somewhere easy like your **Desktop**. Then open the folder.
   If the first thing inside is *another* folder with the same name, open that
   one too — you're in the right place when you can see files named `Setup.bat`
   and `README.md`.

2. **Double-click `Setup.bat`** — once, the first time only. A black window opens
   and installs what the dashboard needs (it will tell you if anything is
   missing, and what to do). Wait for "Setup complete", then close it.

3. **Double-click `Start-Dashboard.bat`** whenever you want the dashboard on.
   Your web browser opens the dashboard by itself after a few seconds. The black
   window that appears **is** the dashboard running — minimize it, don't close
   it. Closing that window turns the dashboard off (nothing is lost; everything
   is saved).

4. **Build your trip with an AI.** Open the file **`BUILD_WITH_AI.md`** and
   follow it: you describe your trip to any AI chat (ChatGPT, Claude, Gemini —
   whichever you use) and it writes your trip out as one block of text called
   JSON. Save that as a file named **`my-trip.json`** inside the dashboard
   folder.

5. **Put your trip into the dashboard.** With the dashboard running, open the
   **admin page** — the address and its key are shown in the black window from
   step 3. Copy your trip to the clipboard the safe way: in File Explorer, open
   the dashboard folder (where `my-trip.json` is), click once in the **address
   bar** at the top, type `powershell` and press Enter — a blue window opens,
   already in the right folder. Paste this line into it and press Enter:

   ```
   powershell.exe -NoProfile -Command "Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 'my-trip.json')"
   ```

   Then, on the admin page, click into the big **Trip Setup** box, paste
   (Ctrl+V), click **Validate**, and — when it says it looks good — **Import**.
   Your trip is live immediately for everyone.

   > Don't copy the file with the older `clip` command (`clip.exe`) — it garbles
   > dashes, accents and emoji, and the garbled text would end up in your trip.

Each family member then opens the dashboard, taps their own name, and picks a
4-digit PIN on first login. That's the whole setup.

**Stuck?** [`KICKSTART.md`](KICKSTART.md) is the slower, more detailed
walkthrough of the same steps, including what to do when a double-click seems to
do nothing.

## Who can see it — honest limits

- **On your computer:** always, at `http://localhost:3000`.
- **Phones and laptops on your home Wi-Fi:** usually yes — the black window
  shows the address to type on the other device. Windows may show a firewall
  question the first time; choose Allow. (This is what "self-hosted" means:
  it's your computer doing the serving.)
- **From outside your home — cellular, or family in another city: no.** The
  dashboard is *not* on the internet, which also means nothing about your trip
  leaves your house. Putting it on the internet properly (so the whole family
  can use it during the trip) is a technical job — the `deploy/` folder has a
  complete kit for whoever in your family does that sort of thing.

---

*Everything below this line is the technical reference for developers and
tinkerers — you don't need it to use the dashboard.*

---

## What it does
- Per-person interest voting on activities, with "consensus" highlights
- Shared **Bookings** list and a **Day Plan**, kept in a two-way mirror (add a booking
  to the plan and the pair stays linked; deletes cascade)
- Packing list, notes, suggestions, flight cards
- Calendar (.ics) export of the timed day plan, timezone-aware
- PIN login per traveler; trip planners can edit the day plan
- All data lives in a single `data.db` file on the server

## Requirements
- **Node.js 22 or 24 LTS** — Node 24 recommended, pinned in `.nvmrc`. (Node 20 is end-of-life; don't use it.)
- npm

## Quick start (terminal)

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

## Make it your trip (by hand)

The recommended path is the admin page's **Trip Setup** import (see step 5 above,
and [`ADMIN.md`](ADMIN.md)): the active trip lives in the database (`trip_config`),
and every import is kept as a version.

The template also ships a seed copy of the trip inline in **`public/index.html`**:

```html
<script type="application/json" id="trip-data"> … </script>
```

That block is what seeds the database on the very first start (and is the
fallback the client renders before login). Its keys:

- **`trip`** — title, brand, subtitle, start/end dates, optional photos URL
- **`family`** — the travelers: `name`, `color` (`[background, text]`), `interests`
- **`days`** — each day: `id`, `label`, `location`, and an `activities` array
- **`dayCoords`** — map pin per day id: `ll: [lat, lng]`, `zoom`, `name`, `date`
- **`flights`**, **`reservationsSeed`**, **`essentials`**, **`embassies`**, **`enrichments`**

Two things to keep in sync when you rename travelers by hand:
1. the names in `family` (in `public/index.html`), **and**
2. `ALLOWED` and `PLANNERS` near the top of **`server.js`** (the fallback login
   allow-list used only when the database has no imported trip).

Timezone for the calendar/now-clock: the trip's top-level `"tz"` key
(e.g. `"America/Chicago"`). Optional per-day or per-activity overrides go in the
`DAY_TZ` / `ACT_TZ` objects in `public/index.html`.

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
├── tools/                 # validate-trip-data.js, apply-trip-data.js, profile-export.js
├── START_HERE.md          # orientation: which doc to read for what
├── KICKSTART.md           # from-zero beginner walkthrough (Windows-first)
├── BUILD_WITH_AI.md       # let an AI fill in your trip (no coding)
├── ADMIN.md               # the hidden admin page (PIN resets, backups, trip import)
├── README.md
├── .gitignore
├── docs/maintenance/      # upgrade runbooks (advanced: Node 24, Express 5)
└── deploy/                # HTTPS deploy kit (see deploy/DEPLOY.md; several trips on one server: docs/MULTI_INSTANCE.md)
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

## Deploying with HTTPS
A full deploy kit is included in **`deploy/`**. Three steps:
`provision.sh` (one-time server setup) → `deploy.sh` (push the app from your laptop) →
`setup-https.sh` (get a TLS cert and turn on HTTPS). It supports both a **domain
certificate** (90-day, auto-renewing — recommended) and a **bare-IP certificate**
(Let's Encrypt's new short-lived ~6-day cert, for when you don't have a domain).
See **`deploy/DEPLOY.md`** for the walkthrough.
