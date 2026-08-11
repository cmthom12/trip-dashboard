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

Copy everything in the box — **all of it, in one paste**. Replace the `<<< YOUR TRIP >>>`
section with your own details (keep it loose — bullet points are fine), then send it.

The prompt asks for a trip that is **full but not endless**: around 50 activities for the
whole trip, spread evenly across the travelers, plus a trip-wide **Must see & do** list of
the big regional landmarks. The family's job in the app is to vote things *down*, and they
can only vote on what's there — but past roughly fifty options, scrolling becomes a chore
and the genuinely good ideas get lost among the merely fine ones.

```
You are helping me fill in the data file for a self-hosted "family trip dashboard" web app.
Output must follow the exact schema below so the app can read it.

=== GOAL ===
Produce ONE JSON object (the app's "trip-data") describing my real trip, ready to paste
straight into the app.

=== MUST INCLUDE (all of these top-level keys) ===
trip, family, categories, days (with activities), dayCoords, flights, reservationsSeed,
essentials, embassies, enrichments.

Plus "mustDos". The app itself treats that one as optional and runs fine without it, but
this trip wants one and the checker warns about every trip that is missing it — so for my
purposes it is required. See the must-dos section below.

=== THE CONTENT BAR — READ THIS TWICE ===
This app is a VOTING tool. My family's job is to DISCARD options, never to go find more.
But a bloated trip is as bad as a thin one: nobody votes on a list they can't finish
scrolling. Four rules, all of them checkable:

1. AIM FOR ABOUT 50 ACTIVITIES FOR THE WHOLE TRIP. Not per day — for the trip. That is
   roughly the right size for anything up to about a week (a 4-day trip lands near 45-50,
   a 6-day trip near 43); scale up only for trips genuinely longer than a week.
   Going well OVER is the failure I care about most. If you have more than fifty good
   ideas, CUT to the ones someone would actually be disappointed to miss — do not spread
   the extras over more days.
   Do NOT try to hit a floor on every day. Days do not need to be equal: a travel day or a
   deliberately slow day can carry two or three things, and that is a plan, not a gap. The
   planners drag activities between days in the app anyway.

2. SPREAD THE "who" TAGS EVENLY ACROSS THE TRAVELERS. An activity's "who" array lists the
   travelers it genuinely suits, and ONE activity can suit several people at once. Add up
   the tags per person across the whole trip; aim for each traveler to land near
   (total tags / number of travelers).
   Even means even-ISH. If someone engages less with this kind of planning, giving them
   fewer but stronger, better-aimed options is right. What is wrong is a traveler sitting
   far below everyone else, with nothing of their own to vote for.
   Never pad a name onto an activity that person would not enjoy. A tag on the wrong
   activity is worse than no tag — it corrupts what the app learns about them.

3. USE WHAT I TOLD YOU ABOUT EACH PERSON. Each traveler's "interests" list is in the
   family array; if I pasted TRAVELER PROFILES below, they are the stronger signal (they
   come from what these people actually voted for and did on past trips) — follow them
   over my one-line descriptions. Every traveler should see things across the trip that
   obviously came from their own list.

4. INCLUDE A "mustDos" BLOCK. One group per place we stop in, 6-10 items in each, and each
   group's "location" spelled EXACTLY as that day's "location". See the next section — it
   is a different kind of content from the day activities, and skipping it or duplicating
   the activities into it are both wrong.

=== MUST-DOS: REGIONAL, NOT PERSONAL ===
"mustDos" is the answer to "we are going to be in this place — what would ANY visitor
regret missing?" It is the guidebook layer: the landmarks, the views, the one dish, the
one walk, the thing on every postcard. It is NOT tailored to my family, it does not
belong to a particular day, and nobody has committed to any of it. In the app it is a
trip-wide "Must see & do" list that everyone stars, and a planner can drop any item onto
a day later.

The "days[].activities" are the opposite: personalized, day-bound options chosen for
specific people out of their interests.

- ONE mustDos GROUP PER STOPPING LOCATION. Use the same place names as the days'
  "location" values. A trip that sleeps in three towns has three groups; a trip that
  never leaves one city has exactly one group.
- HOW MANY ITEMS PER GROUP: 6-10. That is enough to be the real shortlist for a place
  without turning the tab into another endless scroll. Never pad a thin destination to
  reach six; if a quiet stop only earns four, four is the honest answer and I will take
  the warning. Never stretch a rich one past ten — Rome has more than ten famous sights,
  and picking the ten that matter is the job.
- Overlap with the day activities is fine and expected — the Colosseum can be both a
  must-do (it is THE Rome landmark) and a Day 2 activity for the history lovers. When it
  is both, they are two separate entries with two different ids, written for their two
  different purposes.

=== DIETARY (OPTIONAL — AND THE ONE PLACE YOU MUST NOT IMPROVISE) ===
Some travelers have food SENSITIVITIES. These are not allergies: nobody in this family is
at risk of a reaction. Consequences are delayed and comfort-level. So this is never a
safety feature, and you must never write it like one — no warnings, no "safe for", no
telling anyone to avoid a place.

If I listed a traveler's sensitivities, copy them into that person's "dietary" array
exactly as I gave them. Do not infer anyone's sensitivities from anything else.

For a VENUE ("dietary" on an activity or a must-do), ONE HARD RULE:

    Fill it in ONLY from a published allergen menu, or an explicit statement on the
    venue's own website. Otherwise OMIT THE KEY ENTIRELY.

Leaving it out means "we do not know", which the app shows as "not checked" — an honest
and completely acceptable answer. A GUESS is the worst thing you can produce here: it
looks identical to a fact and nobody can tell them apart later. If you find yourself
reasoning "an Italian place probably has gluten-free pasta" — stop, and omit the key.
Set "source" to where the claim actually came from, and "verified" to the date you read it.

And never remove, downgrade or skip a great venue on dietary grounds. Include it, and put
whatever is worth knowing in "practical" so people can choose for themselves.

=== HARD CONSTRAINTS ===
- Output VALID JSON only — double quotes, no trailing commas, no comments.
- Use the EXACT field names and types in the SCHEMA below. Don't add or rename keys.
- Dates that are keys/anchors use ISO format "YYYY-MM-DD". Human-facing dates can be like "Sat Sep 5".
- Every traveler name must be spelled identically everywhere it appears.
- Give every day a unique id ("day1","day2",...) and put a matching entry in dayCoords for each.
- Use real-ish latitude/longitude for map pins and activity locations. If unsure, approximate the city.
- Do NOT invent confirmation numbers, prices you don't know, or bookings. Leave unknowns as "" (empty).
- 1–8 travelers.
- Pick each activity's AND each must-do's "cat" from the categories you define.
- Every id in the whole file is unique — activity ids and must-do ids share one namespace.
  Name activity ids "d2_something" and must-do ids "md_something" and they never collide.

=== SCHEMA ===
trip: { "title", "brand" (short all-caps crew name), "subtitle", "ship" (cruise name or ""),
        "startDate" "YYYY-MM-DD", "endDate" "YYYY-MM-DD", "photosUrl" "",
        "theme": {"navy":"#0D2B4E","gold":"#C9A227","emerald":"#10B981"} }
family: [ { "name", "color": ["#hexBackground","#hexText"], "interests": ["food & wine", ...],
            "dietary": [ {"tag","level":"avoids"|"limits","note"} ] (OPTIONAL - see below) } ]
categories: { "<key>": {"label","emoji","tw":"bg-<color>-100 text-<color>-800 border-<color>-200"} }
   (good starter keys: travel, culture, food, water, adventure, beach, shopping, relax)
days: [ { "id":"day1","label":"Day 1","location","emoji","arrival","departure"(or null),
          "shipNote"(or null),"note","stay":{"name","url"}(optional),"booking":true/false,
          "activities":[ ACTIVITY, ... ] } ]        <-- ~50 across the WHOLE trip
ACTIVITY: { "id","name","cat"(a categories key),"dur":"~2 hrs","durM":120(int minutes),
            "cost":"$$","costN":2(int 0-4),"safe":true,"top":true/false,"who":["Name",...],
            "desc","practical","link":"","ll":[lat,lng](optional),"tags":["..."],
            "start":"HH:MM"(optional, 24-hour),
            "dietary": {"accommodates":[tag],"unsuitable":[tag],"verified":"YYYY-MM-DD",
                        "source":"menu"|"site"|"call"|"review"|"unverified","note"}
                        (OPTIONAL - food places only, and only if you can SOURCE it) }
mustDos: [ { "location" (matches a day's "location"), "emoji",
             "items": [ MUSTDO, ... ] } ]           <-- one group per stopping location
MUSTDO:   { "id":"md_...","name","cat"(a categories key),"desc",
            "ll":[lat,lng](optional, but include it — it puts the landmark on the map),
            "link":""(optional),"note":"one practical line"(optional) }
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

=== WORKED EXAMPLE OF THE mustDos BLOCK ===
Two stopping locations, trimmed to 2 items each so you can see the shape. Yours gets
5-15 items per group.

"mustDos": [
  { "location": "Rome", "emoji": "🏛️", "items": [
      { "id": "md_colosseum", "name": "The Colosseum", "cat": "culture",
        "desc": "The one building everyone pictures when they picture Rome — and it is bigger in person than in any photo.",
        "ll": [41.8902, 12.4922], "link": "",
        "note": "Timed entry sells out days ahead; the 8:30am slot is the coolest and emptiest." },
      { "id": "md_trastevere", "name": "An evening in Trastevere", "cat": "food",
        "desc": "Cobbled lanes across the river where Rome eats dinner outdoors, no plan required.",
        "ll": [41.8890, 12.4694], "note": "Go after 8pm — before that it is half asleep." } ] },
  { "location": "Florence", "emoji": "🎨", "items": [
      { "id": "md_duomo", "name": "The Duomo and its dome climb", "cat": "culture",
        "desc": "Brunelleschi's dome, and 463 steps up inside it to the best view in Tuscany.",
        "ll": [43.7731, 11.2560], "note": "The climb books separately from the cathedral." },
      { "id": "md_piazzalemichelangelo", "name": "Sunset from Piazzale Michelangelo", "cat": "relax",
        "desc": "The postcard view of the whole city and the river, free, from a terrace above it.",
        "ll": [43.7629, 11.2650], "note": "Bus 12, or a 25-minute uphill walk." } ] }
]

=== DONE WHEN ===
All of these are true:
- The reply is a single valid JSON object that would pass JSON.parse with no edits.
- The whole trip has roughly 50 activities — not per day, and not far over.
- The "who" tags are spread evenly-ish across the travelers, counted over the whole trip:
  nobody sits far below the others.
- mustDos has one group per stopping location, 6-10 items each, and every group's
  "location" matches one of the days' "location" strings exactly.
- It passes the app's own checker, which I will run on your output:
      node tools/validate-trip-data.js my-trip.json
  That command prints ✗ for structural errors and ⚠ for a trip that falls under the
  content bar. I am looking for zero ✗ lines and no content-bar ⚠ lines. If I paste any
  back to you, fix exactly those and return the whole JSON again.

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
- TRAVELER PROFILES (optional — if we've used this app before, paste the output of
  `node tools/profile-export.js` here; it beats my descriptions above):
<<< END >>>
```

---

## Step 2 — A peek at what good output looks like

Just so you recognize it — here's a tiny **one-day** slice with **one** activity and **one**
must-do. Your real output will be the full trip: around fifty activities spread over the
days, and a `mustDos` group per place you stop in.

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
 "mustDos": [ { "location":"Rome","emoji":"🏛️","items": [
     {"id":"md_colosseum","name":"The Colosseum","cat":"culture",
      "desc":"The one building everyone pictures when they picture Rome.",
      "ll":[41.8902,12.4922],"link":"","note":"Timed entry sells out days ahead."} ] } ],
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
for travelers whose names stay the same. (See `ADMIN.md` for enabling the console —
and, if you're on Windows copying the JSON from a file, for the `Set-Clipboard` rule:
never `clip.exe`, which turns em dashes and emoji into mojibake.)
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
the trip data, updates **all four traveler-name lists** for you — and, if the dashboard has
run before (a `data.db` exists), **installs the trip straight into that database too**, the
same versioned import the admin page uses. Existing PINs, votes and lists are kept; just
restart the dashboard to see the new trip. Only if the database can't be written right then
(usually because the dashboard is still running and holds it locked) does the tool print a
**"ONE MORE STEP"** block instead — follow its instructions: either stop the dashboard and
delete `data.db` for a fresh start, or paste the same JSON into the admin page's Trip Setup
box to keep existing data (see `ADMIN.md`).

**C. Run it.**
```
npm install      # first time only
npm start
```
(or on Windows: double-click `Setup.bat` once, then `Start-Dashboard.bat`.)
Open **http://localhost:3000**, log in as one of your travelers, set a PIN, and look around.

Two quirks worth knowing on first run:
- If you played with the **sample** trip first, the install tool already swapped the trip
  inside your existing `data.db` — restart the dashboard and it shows your trip. Any PINs
  set while playing with the sample stick around for travelers whose names stay the same;
  delete `data.db` (with the dashboard stopped) only if you'd rather start from zero.
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

## The checker — your accept/reject test on the AI's work
The install tool already runs this for you, before and after installing. Run it yourself the
moment the AI hands you the JSON, before you do anything else:
```
node tools/validate-trip-data.js my-trip.json      # the AI's raw output
node tools/validate-trip-data.js public/index.html # or after pasting
```
It prints plain-English lines:

- **✗ lines are errors** — something is structurally broken (missing keys, wrong shapes, a
  day without a map pin, names that don't match the two files). The app would misbehave.
- **⚠ lines are warnings** — the trip works, but some are the *content bar*. Those read like
  this, word for word:

```
⚠ This trip has 88 activities across 4 days — aim for around 50. Past roughly that many the app stops being a shortlist and becomes a chore to scroll, and the best ideas get buried among the merely fine ones. Ask your AI to CUT the weakest options rather than spread them over more days — keep what someone would actually be disappointed to miss.
⚠ Riley (6) has far fewer activities tagged for them than the rest of the family, which averages 24 each. An activity counts for everyone listed in its "who", so ask your AI to add options that genuinely suit Riley — not to paste that name onto activities they would not enjoy. Fewer but stronger options for someone who votes on less is fine; this line only fires when someone is far below everyone else.
⚠ mustDos[0] ("Old City") has 4 items — a group reads best with 6-10. Ask your AI for the rest of what that place genuinely earns.
⚠ mustDos[1] ("Seaside Town"): no day has that exact "location". The app files must-dos under the day location text, so this group never appears beside the days it belongs to. The day locations are "Arrival", "Old City", "Seaside" and "Departure" — correct the spelling on whichever side is wrong.
⚠ This trip has no "Must see & do" list (the "mustDos" block) — that is the trip-wide list of landmarks and experiences everyone can star, separate from the day-by-day plans. Ask your AI to add one group per place you stop in, with 6-10 items in each.
```

Note what is **not** there: nothing complains about a single light day. Days are allowed to
be uneven — planners move activities between them in the app.

**Both kinds go straight back to the AI.** Paste the lines into the same chat and say
*"fix exactly these and return the whole JSON again."* Repeat until it comes back clean.
That loop is the whole quality-control process — it takes two or three rounds and it is the
difference between a dashboard the family uses and one they open once.

## Dietary sensitivities (optional)

Two optional keys let the app note where a traveler's food sensitivities and a venue's
declared options meet. Both are additive: leave them out and the app behaves exactly as it
always has.

**Read this before you use them.** These are **sensitivities, not allergies**. In the
family this was built for there is no risk of a reaction — consequences are delayed and
comfort-level. The app therefore treats the whole feature as *information*, never safety:

- no alert colours, no warning icons, no "safe for Jordan" anywhere;
- nothing is ever blocked, and nothing is hidden by default;
- a restriction **annotates** an option. It never removes one.

If anyone in your family has a genuine allergy, **this is not the feature for that.** It is
not built to carry that weight and must not be pressed into it.

### On a traveler

```json
"dietary": [
  { "tag": "gluten", "level": "avoids", "note": "feels better without it" },
  { "tag": "dairy",  "level": "limits" }
]
```

`level` is `"avoids"` (actively avoids it) or `"limits"` (cuts back, not strict). There is
deliberately no medical tier. `tag` comes from: `gluten`, `dairy`, `eggs`, `peanut`,
`almond`, `oat`, `soy`, `shellfish`, `vegetarian`, `vegan`, `pescatarian`, `other`.

### On a venue (an activity, or a must-do item)

```json
"dietary": {
  "accommodates": ["gluten"],
  "unsuitable":   ["dairy"],
  "verified": "2026-08-11",
  "source": "menu",
  "note": "the kitchen marks which dishes are which"
}
```

`source` is `menu`, `site`, `call`, `review` or `unverified`. Only put it on places that
serve food; omit the key everywhere else.

**A tag in neither list means UNKNOWN, and the app shows it as "not checked".** That is a
real answer, not a gap to be filled.

### The one hard rule

> Fill in a venue's `dietary` **only** from a published allergen menu or an explicit
> statement on the venue's own site. Otherwise **omit the key.**

Guessing is the single worst failure mode here, because a guess is indistinguishable from a
checked fact once it is written down — and unlike a wrong opening time, nobody finds out it
was wrong until they are sitting in the restaurant. "Not checked" costs nothing. A wrong
`accommodates` costs someone their dinner.

The same rule holds in the other direction: **never remove or downgrade a great venue on
dietary grounds.** Note what is worth knowing in `practical` and let people choose.

### What the family sees

On an activity with a declared `dietary`, a signed-in traveler with matching tags gets one
small gray line — *"🍽 gluten options here · dairy not checked (from the menu, checked
2026-08-11)"*. There is also an opt-in **🍽 Works for me** chip next to *For &lt;name&gt;*. Even
switched on, it hides only what the venue itself declared unsuitable; anything unknown
stays on screen, because unknown is not a no.

Travelers with no `dietary` array never see any of this.

## Changing a trip the family has already voted on

Everything above describes generating a **whole trip** from scratch. Once people have
started voting, that is the wrong move — and this is the part that is easy to get wrong.

**Votes are stored per activity id.** The `interests` table maps an activity id to the list
of people who starred it; nothing else ties a vote to an activity. So:

- **Adding** an activity, or adding a name to an existing activity's `who`, is safe. No
  existing id changes, so no existing vote moves.
- **Deleting** an activity, or **renaming its id**, silently orphans every star anyone
  already gave it. There is no undo and nobody is told.

That gives one rule: **a trip with real votes on it gets an additive patch. Only a trip
with zero votes may be regenerated wholesale.**

### The additive patch

Ask the AI for this shape instead of a whole trip:

```json
{
  "family":        [ { "name": "Riley", "interests": ["…"] } ],
  "addWho":        { "d2_market": ["Riley", "Casey"], "d3_cliffwalk": ["Riley"] },
  "newActivities": { "day2": [ ACTIVITY, ACTIVITY ], "day4": [ ACTIVITY ] },
  "mustDos":       [ { "location": "Old City", "items": [ … ] } ]
}
```

- `addWho` maps an **existing** activity id to names to **append** to that activity's
  `who`. Append only — it never removes a name and never touches the id, which is exactly
  why it is safe to run against a trip mid-vote.
- `newActivities` maps a **day id** to brand-new activities, with brand-new ids.
- `family` and `mustDos` are optional and carry the same shapes as the full schema.
- Every key is optional; send only the ones that change.

Use it when someone joins the trip, when a traveler turns out to be under-served, or when
you want more options for one day — the common cases, and none of them justify a rewrite.

### The mustDos-only patch

For "the Must see & do list needs work" and nothing else, the patch is just the bare array:

```json
[ { "location": "Old City", "emoji": "🏛️", "items": [ … ] } ]
```

Same rules as above: must-do ids are ids too, so add and edit text freely, but do not
re-id or delete an item people have already starred.

Whichever shape you use, merge it into your `my-trip.json`, then run the checker on the
**merged** file — the patch on its own is not a valid trip and will not validate.

## When it's ready
Try it locally until you like it, then put it online for the family with the deploy kit in
**`deploy/`** (HTTPS included) — see [`deploy/DEPLOY.md`](deploy/DEPLOY.md). Your trip data
and everyone's logins live in a single `data.db` file on the server; deploys never overwrite it.

## After the trip: the built-in review
The day after your trip's `endDate`, the dashboard adds a **✅ Review** tab on its own.
Travelers rate only what they personally attended (a "didn't do it" is never held against
an idea), give a quick reason when something disappointed, and can add things they did
that were never planned. Two extra tables in `data.db` hold this (`reviews` for the
scheduled items, `review_additions` for the spontaneous ones); pre-trip votes are never
overwritten. When everyone's done, `tools/profile-export.js` turns votes **and** reviews
into next-trip planning profiles — see the "After the trip" sections of
[`ADMIN.md`](ADMIN.md).
