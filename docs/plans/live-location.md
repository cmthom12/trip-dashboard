# Plan: feature/live-location

Opt-in "where is everyone right now" on the map. Deliberately NOT a tracker:
**last known position only, no history table ever, 30-minute hard expiry,
always-visible indicator while sharing, one-tap off.**

## Server (all additive)

- `locations (name TEXT PRIMARY KEY, lat REAL, lng REAL, acc REAL, updated_at TEXT)`
  — one row per traveler, upserted; DELETE removes it. No history, by design.
- `POST /api/location {lat, lng, acc?}` — goes through the normal token-auth
  middleware; **name always = req.authUser** (never from the body). Validates
  lat ∈ [-90,90], lng ∈ [-180,180], acc ≥ 0 when present. Upserts with
  `updated_at = new Date().toISOString()`. No X-Op-Id involvement — the client
  never queues these (a replayed stale position would lie about where someone is).
- `DELETE /api/location` — token-auth; deletes the caller's row. Stop sharing =
  disappear immediately.
- `GET /api/locations` — **token-checked in the handler** (GETs skip the auth
  middleware, but this is family-only data, so it 401s without a valid token —
  the one deliberate exception to "GETs are public"). Returns only rows with
  `updated_at` within 30 minutes as `[{name, lat, lng, acc, agoS}]`. Server-side
  expiry is authoritative; expired rows are also deleted opportunistically.

## Client (public/index.html)

- `LocShare` — a small framework-free singleton owning the geolocation watch:
  - `start()`: `watchPosition(...)`; POST via **plain fetch only** (explicitly
    never `qfetch`/outbox; failures drop silently, next tick retries) at most
    every 45 s OR on >100 m movement (equirectangular approx), whichever first.
  - Pauses while `document.hidden` (visibilitychange), resumes on visible.
  - `stop()`: `clearWatch` + `DELETE /api/location`.
  - Permission denied → auto-stop + friendly note in the Map tab.
  - State is **in-memory per page load** (OFF by default). Judgment call: no
    auto-resume across reloads — sharing should never outlive an explicit choice;
    the 30-min server expiry is the backstop. (Spec said "per device+login";
    this is the more private reading — flagged in the report.)
- `ShareChip` — rendered under the header/tab bar (next to Countdown), visible on
  every tab while sharing: "📍 Sharing" in green; tapping it = one-tap off.
- Map tab (TripMap):
  - Toggle row under the map: "Share my location" + copy: "Others on this trip
    can see your location while the app is open. Turns off automatically when
    you're not sharing." + honest limitation: "Updates only while the app is
    open — that's a browser rule."
  - Location layer: poll `GET /api/locations` every 40 s while TripMap is
    mounted (interval cleared on unmount = leaving the Map tab stops polling);
    belt-and-suspenders client filter `agoS <= 1800`. One dot per traveler:
    family color fill, white ring, initial letter; own dot gets a dashed ring;
    popup "Name · N min ago (±Xm)".

## Docs

- README: "Live location" section — what it does, what it deliberately does not
  do (no history, 30-min expiry, off by default, updates only while open).
- ADMIN.md note: admins get **no** location override powers, deliberately.

## Stages (one commit each)

1. This plan.
2. Server table + three routes. Verify by curl: tokenless 401 ×3; upsert keeps
   one row per name; DELETE clears; GET hides a row aged >30 min (inserted
   directly with an old timestamp).
3. Client LocShare + toggle + chip + map layer. Verify with stubbed geolocation
   + fake timers: start → watch + immediate POST; <100 m and <45 s → no POST;
   >100 m → POST; hidden → paused; toggle off → DELETE; denied → reverts OFF;
   poll renders only fresh rows; plain-fetch invariant (no qfetch reference in
   the new code).
4. Docs.

Failure rule: stage fails twice → WIP-STOPPED commit, push, move on.
