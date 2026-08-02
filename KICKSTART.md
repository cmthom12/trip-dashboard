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

## Step 2 — Do you already have Node.js? Check first

Don't install anything yet — you may already have it.

1. Press **Start**, type **`cmd`**, and open **Command Prompt**.
   *(Use Command Prompt, not PowerShell — see the note below.)*
2. Type:
   ```
   node --version
   ```
3. **If it prints a version** like `v22.x` or `v24.x` — you're done, skip to Step 3.
   **If it says** `'node' is not recognized...` — install it: go to **https://nodejs.org**,
   download the **LTS** version, run the installer (all defaults are fine), then close
   Command Prompt, open it again, and check `node --version` once more.

> 💡 **Why Command Prompt and not PowerShell?** On many Windows PCs, PowerShell refuses to
> run `npm` with an error like:
>
> `npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is
> disabled on this system.`
>
> Nothing is broken — that's just a PowerShell security policy. The fix is simply to use
> Command Prompt instead (Start → type `cmd`), or better: use the **double-click `.bat`
> files** in this folder, which never hit that error. This guide uses the `.bat` files
> throughout.

## Step 3 — One-time setup

Double-click **`Setup.bat`** (in the app folder from Step 1). It installs the app's
packages — takes a minute or two, and the window tells you when it's done.

## Step 4 — Start the dashboard

Double-click **`Start-Dashboard.bat`**. A black window opens, and a few seconds later your
browser opens **http://localhost:3000** with a *sample* trip (travelers Alex, Sam, Jordan,
Riley, Casey).

- That black window **is** the dashboard — **closing it stops the app**. Minimize it, don't close it.
- Log in as any sample traveler and pick a 4-digit PIN, click around, get a feel for it.

## Step 5 — Make it your trip (with an AI)

Open **[`BUILD_WITH_AI.md`](BUILD_WITH_AI.md)** and follow it — you describe your trip to
ChatGPT/Claude/Gemini and it writes the data file. Three tips before you start the chat:

- **Use a fresh chat** — ideally a *temporary / incognito* chat if your AI has one.
- **Tell the AI to ignore its memory of you.** Start your message with something like:
  *"Ignore anything you remember about me from previous chats — use only what's in this
  message."* Otherwise old conversations can leak wrong names, dates, or a previous trip
  into your data.
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

## Mac / Linux

Same flow, in a terminal, from the app folder:

```
node --version                          # check first — install from nodejs.org only if missing
npm install                             # once (= Setup.bat)
npm start                               # run it, then open http://localhost:3000 (= Start-Dashboard.bat)
node tools/apply-trip-data.js my-trip.json   # install your trip (= Apply-Trip.bat)
```

Stop the server with `Ctrl+C` in the terminal.
