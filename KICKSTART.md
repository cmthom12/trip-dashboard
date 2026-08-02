# Kickstart 🚀 — from downloaded zip to *your* trip dashboard

The complete beginner path, no experience needed. Windows instructions first (that's most
people); Mac/Linux notes are at the [bottom](#mac--linux). Budget ~30 minutes, most of
which is chatting with an AI about your trip.

---

## Step 1 — Get the files in the right place

If you downloaded this as a **zip**: right-click it → **Extract All**, then open the
extracted folder.

> ⚠️ **The folder-inside-a-folder trap.** Extracting often produces a folder that contains
> *another* folder with the same name (e.g. `trip-dashboard-main\trip-dashboard-main`).
> Keep opening folders until you see the actual files — `Setup.bat`, `server.js`,
> `README.md`, a `public` folder. **That** inner folder is the app. Everything below
> happens inside it.

## Step 2 — One-time setup (Node.js included)

Double-click **`Setup.bat`** (in the app folder from Step 1). No terminal needed — it
does the checking for you:

- **If Node.js is missing**, the window says so and sends you to **https://nodejs.org** —
  download the **LTS** version, run the installer (all defaults are fine), then
  double-click `Setup.bat` again.
- **Otherwise** it installs the app's packages — takes a minute or two, and the window
  tells you when it's done.

*(Nothing happens when you double-click, or the window flashes and vanishes? See
[If the launchers don't work](#if-the-launchers-dont-work) below.)*

## Step 3 — Start the dashboard

Double-click **`Start-Dashboard.bat`**. A black window opens, and a few seconds later your
browser opens **http://localhost:3000** with a *sample* trip (travelers Alex, Sam, Jordan,
Riley, Casey).

- That black window **is** the dashboard — **closing it stops the app**. Minimize it, don't close it.
- Log in as any sample traveler and pick a 4-digit PIN, click around, get a feel for it.

## Step 4 — Make it your trip (with an AI)

Open **[`BUILD_WITH_AI.md`](BUILD_WITH_AI.md)** and follow it — you describe your trip to
ChatGPT/Claude/Gemini and it writes the data file. One tip before you start the chat:

- **Ask for plenty of activity options (5–8 per day).** This app is for voting — overshoot
  rather than undershoot; the family discards options, they don't add them.

When the AI gives you the JSON: save it as **`my-trip.json`** in the app folder, double-click
**`Apply-Trip.bat`**, and press Enter. It checks everything, installs your trip, and tells
you what to do if something's off. Then close the dashboard window and double-click
`Start-Dashboard.bat` again — it's your trip now.

*(Played with the sample first? Delete the `data.db` file once, while the dashboard is
stopped, so the sample logins disappear.)*

## Restarting later

Any time you come back to it: just double-click **`Start-Dashboard.bat`**. Your trip, PINs,
votes and lists are all kept in one file (`data.db`) and survive restarts and reboots.
Close the window to stop; double-click to start. That's the whole lifecycle.

## When you're ready to share it

Running on your PC, only you (on your own computer) can see it. To put it online for the
whole family, see the deploy kit in **`deploy/`** — start with
[`deploy/DEPLOY.md`](deploy/DEPLOY.md).

---

## If the launchers don't work

The `.bat` files are the easy path, but if double-clicking gets you nowhere (a security
tool blocks them, the window flashes shut, etc.), the terminal does the same things:

1. In File Explorer, open the app folder from Step 1, click in the **address bar**, type
   **`cmd`** and press Enter — Command Prompt opens **already in the right folder**. (This
   sidesteps the classic `cd` maze and `ENOENT: no such file or directory` errors, which
   almost always mean "you're in the wrong folder".)
2. Then, in that window:
   ```
   node --version          ← no version? Install the LTS from https://nodejs.org first
   npm install             ← once (this is what Setup.bat does)
   npm start               ← then open http://localhost:3000  (= Start-Dashboard.bat)
   node tools/apply-trip-data.js my-trip.json    ← install your trip (= Apply-Trip.bat)
   ```
   Stop the server with `Ctrl+C` in that window.

> 💡 **Use Command Prompt, not PowerShell.** On many Windows PCs, PowerShell refuses to run
> `npm` with an error like:
>
> `npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is
> disabled on this system.`
>
> Nothing is broken — that's just a PowerShell security policy. Command Prompt (and the
> `.bat` files) never hit it.

## Mac / Linux

Same flow, in a terminal, from the app folder:

```
node --version                          # check first — install from nodejs.org only if missing
npm install                             # once (= Setup.bat)
npm start                               # run it, then open http://localhost:3000 (= Start-Dashboard.bat)
node tools/apply-trip-data.js my-trip.json   # install your trip (= Apply-Trip.bat)
```

Stop the server with `Ctrl+C` in the terminal.
