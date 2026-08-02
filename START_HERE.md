# Start Here 👋

This is a **make-it-your-own family trip dashboard** — one shared page where everyone on a
trip can vote on activities, see the day-by-day plan, track flights and bookings, share a
packing list, and export it all to their calendar. It runs on a cheap little server you
control (about $4–6/month), or just on your own laptop to try it out.

Right now it's filled with a **fake sample trip** (travelers named Alex, Sam, Jordan, Riley,
Casey). Your job is to swap that out for *your* trip. There are two ways to do that — pick one:

---

### 🟢 Path A — Let an AI fill it in for you  *(easiest, no coding)*
You describe your trip in plain English to ChatGPT, Claude, or Gemini, and it writes the
data file for you. Then you paste the result in and you're done.
👉 **Open [`BUILD_WITH_AI.md`](BUILD_WITH_AI.md) and follow it.** This is the recommended path
for most people.

### 🔵 Path B — Edit it by hand  *(if you like tinkering)*
Everything is data, not code. Open one file, find one block, and type your trip in.
👉 See the **"Make it your trip"** section of [`README.md`](README.md).

### Want it on paper?
Prefer reading away from the screen? Print **[`KICKSTART.md`](KICKSTART.md)** — the complete
from-zero walkthrough, Windows-first.

---

### Then: try it, then put it online
1. **Try it on your computer first.**

   **Windows — no terminal needed:** double-click **`Setup.bat`** once, then
   **`Start-Dashboard.bat`** — your browser opens the dashboard. The full from-zero
   walkthrough (downloading the zip, the folder-in-a-folder trap, installing your own
   trip with `Apply-Trip.bat`) is **[`KICKSTART.md`](KICKSTART.md)**.

   **Mac / Linux** — or if the launchers don't work — in a terminal, in this folder:
   ```
   npm install
   npm start
   ```
   Open **http://localhost:3000**. *(You'll need Node.js 24 installed first — get it
   free at nodejs.org.)*

   Either way: log in as any traveler and pick a 4-digit PIN.

2. **Put it online for the family** when you're happy with it. A complete step-by-step
   deploy kit — including turning on **HTTPS** (the padlock) — is in the **`deploy/`** folder.
   Start with [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

---

**Not technical and that's as far as you want to go?** Hand this whole folder to whoever in
the family *is* the tinkerer — Path A plus `README.md` and `deploy/DEPLOY.md` give them
everything they need, and none of it requires being a developer.
