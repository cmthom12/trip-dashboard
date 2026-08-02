# Build Your Trip With an AI 🤖

You don't have to hand-write anything. Describe your trip to an AI assistant
(**ChatGPT, Claude, or Gemini** all work), let it produce the data file, and paste the
result into the app. About 15 minutes start to finish.

## How it works (the whole flow)
1. Open a **fresh** chat with an AI.
2. **Copy the big prompt below**, fill in your trip where it says `<<< YOUR TRIP >>>`, and send it.
3. The AI asks a few follow-up questions, then returns one block of **JSON** (the trip data).
4. **Save that JSON as `my-trip.json`** in the app folder and run the install tool
   (one double-click on Windows) — it checks the JSON and wires everything up for you.
5. Run it and look. Want changes? Tell the AI "change day 3 to a beach day", save the new
   version, and apply it again. Repeat until it's right.

> You never need to understand the JSON. You're just moving it from the AI into one file.

---

## Step 1 — The prompt to give the AI

Copy everything in the box. Replace the `<<< YOUR TRIP >>>` section with your own details
(keep it loose — bullet points are fine), then send it.

```
You are helping me fill in the data file for a self-hosted "family trip dashboard" web app.
Output must follow the exact schema below so the app can read it.

=== GOAL ===
Produce ONE JSON object (the app's "trip-data") describing my real trip, ready to paste
straight into the app.

=== MUST INCLUDE (all of these top-level keys) ===
trip, family, categories, days (with activities), dayCoords, flights, reservationsSeed,
essentials, embassies, enrichments.

=== HARD CONSTRAINTS ===
- Output VALID JSON only — double quotes, no trailing commas, no comments.
- Use the EXACT field names and types in the SCHEMA below. Don't add or rename keys.
- Dates that are keys/anchors use ISO format "YYYY-MM-DD". Human-facing dates can be like "Sat Sep 5".
- Every traveler name must be spelled identically everywhere it appears.
- Give every day a unique id ("day1","day2",...) and put a matching entry in dayCoords for each.
- Use real-ish latitude/longitude for map pins and activity locations. If unsure, approximate the city.
- Do NOT invent confirmation numbers, prices you don't know, or bookings. Leave unknowns as "" (empty).
- 1–8 travelers. Give EVERY day of the trip 5–8 activity OPTIONS. This app is for VOTING —
  overshoot rather than undershoot; the family discards options, they don't add them.
- Pick each activity's "cat" from the categories you define.

=== SCHEMA ===
trip: { "title", "brand" (short all-caps crew name), "subtitle", "ship" (cruise name or ""),
        "startDate" "YYYY-MM-DD", "endDate" "YYYY-MM-DD", "photosUrl" "",
        "theme": {"navy":"#0D2B4E","gold":"#C9A227","emerald":"#10B981"} }
family: [ { "name", "color": ["#hexBackground","#hexText"], "interests": ["food & wine", ...] } ]
categories: { "<key>": {"label","emoji","tw":"bg-<color>-100 text-<color>-800 border-<color>-200"} }
   (good starter keys: travel, culture, food, water, adventure, beach, shopping, relax)
days: [ { "id":"day1","label":"Day 1","location","emoji","arrival","departure"(or null),
          "shipNote"(or null),"note","stay":{"name","url"}(optional),"booking":true/false,
          "activities":[ ACTIVITY, ... ] } ]
ACTIVITY: { "id","name","cat"(a categories key),"dur":"~2 hrs","durM":120(int minutes),
            "cost":"$$","costN":2(int 0-4),"safe":true,"top":true/false,"who":["Name",...],
            "desc","practical","link":"","ll":[lat,lng](optional),"tags":["..."],
            "start":"HH:MM"(optional, 24-hour) }
dayCoords: { "day1": {"ll":[lat,lng],"zoom":11,"name","date":"YYYY-MM-DD"}, ... } (one per day id)
flights: [ {"id","flight":"DL 100","route":"HOME → CITY","date":"Sat Sep 5","dep":"8:00 AM",
            "arr":"12:30 PM","aircraft","cabin","seats","terminal","trackUrl":"","homeNote"} ]
reservationsSeed: [ {"title","date":"Sep 5","time":"8:00 AM" or "","notes"} ]
essentials: [ { "country","flag":"🇮🇹","ports":"City · City",
                "rows":[ {"icon":"💶","title":"Currency","detail":"one practical sentence"}, ... ] } ]
   (one object per country — 4-6 rows each: currency, power, connectivity, transport, emergency)
embassies: [ {"flag":"🇺🇸","name","covers","addr","tel":"+39 ...","site":"https://...",
              "mapsq":"text to search on Google Maps"} ] (your home-country post at the destination)
enrichments: {
  "missions": { "day1":"a fun optional to-do for that day", "day2":"...", ... (one per day id) },
  "phrases":  { "day1": {"flag":"🇮🇹","gr":"phrase in the LOCAL language","en":"English meaning",
                          "say":"phonetic pronunciation"}, "day2": {...}, ... (one per day id) },
  "facts":    { "day1":"a neat fact about that day's destination", "day2":"...", ... (one per day id) } }

=== DONE WHEN ===
The reply is a single valid JSON object matching the schema, covering every day, that would
pass JSON.parse with no edits.

=== OUTPUT ===
Return ONLY the JSON. No explanation, no ```json fences, nothing before or after it.

<<< YOUR TRIP >>>
- Trip name / who we are (crew name):
- Travelers (names) and what each likes:
- Where we're going and the dates:
- Day-by-day rough plan (even loose bullets are fine):
- Flights we know about:
- Hotels / cruise / big bookings:
- Anything special (a birthday, a must-do, a place we already booked):
<<< END >>>
```

---

## Step 2 — A peek at what good output looks like

Just so you recognize it — here's a tiny **one-day** slice (your real output will be the full
trip and much longer):

```json
{
 "trip": { "title": "Smith Family Italy", "brand": "TEAM SMITH", "subtitle": "10 days in Italy",
           "ship": "", "startDate": "2026-09-05", "endDate": "2026-09-14", "photosUrl": "",
           "theme": {"navy":"#0D2B4E","gold":"#C9A227","emerald":"#10B981"} },
 "family": [ {"name":"John","color":["#EFF6FF","#1E40AF"],"interests":["history & sites","food & wine"]} ],
 "categories": { "culture": {"label":"Culture","emoji":"🏛️","tw":"bg-amber-100 text-amber-800 border-amber-200"} },
 "days": [ { "id":"day1","label":"Day 1","location":"Rome","emoji":"🏛️",
   "arrival":"Land at FCO midday","departure":null,"shipNote":null,
   "note":"Arrive and settle in near the Forum.","booking":true,
   "activities": [ {"id":"d1_colosseum","name":"Colosseum & Forum","cat":"culture",
       "dur":"~3 hrs","durM":180,"cost":"€€","costN":2,"safe":true,"top":true,
       "who":["John"],"desc":"Skip-the-line tour of the Colosseum and Roman Forum.",
       "practical":"Book a timed entry; bring water and a hat.","link":"",
       "ll":[41.8902,12.4922],"tags":["ancient","must-see"],"start":"14:00"} ] } ],
 "dayCoords": { "day1": {"ll":[41.9028,12.4964],"zoom":12,"name":"Rome","date":"2026-09-05"} },
 "flights": [ {"id":"out1","flight":"DL 100","route":"JFK → FCO","date":"Fri Sep 4","dep":"6:00 PM",
     "arr":"9:00 AM +1","aircraft":"A330","cabin":"Economy","seats":"","terminal":"4",
     "trackUrl":"","homeNote":"Overnight to Rome."} ],
 "reservationsSeed": [ {"title":"Hotel Forum","date":"Sep 5","time":"","notes":"3 nights, central Rome."} ],
 "essentials": [ { "country":"Italy","flag":"🇮🇹","ports":"Rome",
   "rows":[ {"icon":"💶","title":"Currency","detail":"Euro. Cards widely accepted; carry ~€50 cash for markets."},
            {"icon":"🔌","title":"Power","detail":"Type C/F/L plugs, 230V — bring an adapter."} ] } ],
 "embassies": [ {"flag":"🇺🇸","name":"U.S. Embassy Rome","covers":"All of Italy","addr":"Via Vittorio Veneto 121, Rome","tel":"+39 06 46741","site":"https://it.usembassy.gov/","mapsq":"U.S. Embassy Rome, Via Vittorio Veneto 121"} ],
 "enrichments": { "missions": {"day1":"Find the best gelato near the Pantheon"},
                  "phrases":  {"day1": {"flag":"🇮🇹","gr":"Ciao","en":"Hello","say":"chow"}},
                  "facts":    {"day1":"The Colosseum held ~50,000 spectators."} }
}
```

If the AI ever returns something that **isn't** clean JSON (extra text, code fences, a blank
page when you paste it), just tell it: *"That didn't parse as JSON — return only the JSON
object, no fences, no commentary,"* and it'll fix it.

---

## Step 3 — Put it into the app

**Already running on a server with the admin console enabled?** That's the easy path:
open `/admin.html` on your dashboard, scroll to **Trip Setup**, paste the AI's JSON,
hit **Validate**, then **Import**. Done — no files, no restart, and PINs/votes are kept
for travelers whose names stay the same. (See `ADMIN.md` for enabling the console.)
The steps below are for the local/first-time route, and they still work everywhere.

**A. Save the AI's answer as a file named `my-trip.json`**, in the app folder (the same
folder as this file). Any editor works — e.g. paste it into Notepad, then *File → Save As*,
type `my-trip.json` as the name. (If Windows saved it as `my-trip.json.txt`, rename it.)

**B. Install it** — pick one:

- **Windows:** double-click **`Apply-Trip.bat`** and press Enter at the file-name prompt.
- **Any terminal (Mac/Linux/Windows):**
  ```
  node tools/apply-trip-data.js my-trip.json
  ```
  Add your timezone for the calendar/clock if it isn't US-Eastern, e.g.
  `node tools/apply-trip-data.js my-trip.json --tz Europe/Rome`. (The double-click route
  keeps the default timezone — run the command above, or see the advanced section, to change it.)

The tool checks the JSON first and refuses politely if something's wrong — paste any ✗ lines
back to your AI, save the corrected JSON, and run it again (**running it twice is safe**).
When it goes through, it backs up the two files it touches (`*.backup-<timestamp>`), installs
the trip data, and updates **all four traveler-name lists** for you.

**C. Run it.**
```
npm install      # first time only
npm start
```
(or on Windows: double-click `Setup.bat` once, then `Start-Dashboard.bat`.)
Open **http://localhost:3000**, log in as one of your travelers, set a PIN, and look around.

Two quirks worth knowing on first run:
- If you played with the **sample** trip first, stop the server and delete `data.db` before
  your first real run — otherwise the old sample logins linger in the user list.
- Before your trip's start date the Itinerary can open on an empty day ("0 activities").
  Just tap any day in the day strip — the app only auto-selects a day during the trip itself.

<details>
<summary><b>Advanced: install it by hand instead</b> (what the tool does, as manual edits)</summary>

**A. Paste the trip data.** Open `public/index.html` in any text editor. Find this line
(it's near the top):
```html
<script type="application/json" id="trip-data">
```
Select **everything between** that opening tag and the matching `</script>` and replace it
with the JSON the AI gave you. Save.

**B. Update the traveler lists (three spots, two files).** Set every list to your traveler
names — spelled **exactly** like the `name` fields in your trip:

1. In `server.js`, near the top (~line 89):
```js
const ALLOWED  = ["John","Jane","Max"];   // who can log in
```
2. Also in `server.js`, further down (~line 253 — search for `PLANNERS`):
```js
const PLANNERS = ["John","Jane","Max"];   // who can edit the day plan (often everyone)
```
3. In `public/index.html`, just below the trip-data block (search for `const PLANNERS`):
   this one controls whether the Day-Plan **edit buttons are shown**; if you skip it,
   planners can log in but see a read-only day plan:
```js
const PLANNERS = ["John", "Jane", "Max"];
```

**C. (Optional) Set your timezone** for the calendar and clock. In `public/index.html` find:
```js
const DEFAULT_TZ = "America/New_York";
```
and change it to yours (e.g. `"America/Chicago"`, `"Europe/Rome"`).

</details>

---

## The four places names must match
**If you used `Apply-Trip.bat` / `apply-trip-data.js` above, this is already handled — the
tool sets all four from your JSON.** For the curious (and the hand-editors):
every traveler name has to be **identical** in all four —
1. each `"name"` in **`family`** (in `public/index.html`),
2. **`ALLOWED`** in `server.js`,
3. **`PLANNERS`** in `server.js`,
4. **`PLANNERS`** in `public/index.html` (just below the trip-data block).
If a name is misspelled in 1–3, that person can't log in; if it's misspelled in 4, they can
log in but the Day-Plan edit buttons never appear for them. That's the #1 gotcha.

## Optional: check the JSON yourself
The install tool already runs this check for you, before and after installing. But you can
also run it on its own — it catches all of the common problems: missing keys,
wrong shapes, a day without a map pin, names that don't match the two files:
```
node tools/validate-trip-data.js my-trip.json      # the AI's raw output
node tools/validate-trip-data.js public/index.html # or after pasting
```
It prints plain-English ✗/⚠ lines ("day3 has no dayCoords entry — no map pin for that
day"). Paste any ✗ line back to your AI and ask it to fix the JSON.

## When it's ready
Try it locally until you like it, then put it online for the family with the deploy kit in
**`deploy/`** (HTTPS included) — see [`deploy/DEPLOY.md`](deploy/DEPLOY.md). Your trip data
and everyone's logins live in a single `data.db` file on the server; deploys never overwrite it.
