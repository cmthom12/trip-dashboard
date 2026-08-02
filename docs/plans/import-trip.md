# Plan: feature/import-trip (v0.6.0 headliner)

Trip setup becomes paste-JSON-into-the-admin-page. No more editing `index.html`
by hand on a deployed site.

## Storage & boot (server)

- New table `trip_config (id INTEGER PK AUTOINCREMENT, json TEXT, version INTEGER,
  updated_by TEXT, updated_at DATETIME)`. Active trip = row with highest version.
  Old rows are history; nothing deletes them.
- Boot migration: if `trip_config` is empty, parse the inline trip-data block from
  `public/index.html` (already done for TRIP_META) and insert it as version 1
  (`updated_by: 'boot-seed'`). Existing deployments upgrade in place at first
  restart.
- In-memory cache `activeTrip()` — loaded at boot, refreshed after every import.
  Admin overview's TRIP_META now reads from it.

## API

- `GET /api/trip` — active trip JSON. Public GET like every other GET.
- `GET /api/trip/export` — same JSON, `Content-Disposition: attachment` as
  `trip-data.json`. Public GET (same data as above, just a download).
- `POST /api/trip/validate` — admin-gated dry-run: `{errors, warnings, summary}`,
  stores nothing. (Extra route beyond the letter of the spec so the UI's Validate
  button doesn't need a dry-run flag on the real import.)
- `POST /api/trip` — admin-gated + X-Op-Id idempotent. Validates; on errors →
  400 with the validator's plain-English list; on pass → insert new row with
  version+1, refresh cache, return `{ok, version, warnings}`.
- Admin gating: the existing `/api/admin` middleware body moves into a named
  `adminGate(req,res,next)` reused verbatim by `app.use('/api/admin', adminGate)`
  and the two POST /api/trip* routes, all registered in the existing admin section
  (before token-auth, after idempotency) — no middleware-order changes.

## Validation: one source of truth

Refactor the pure-data checks of `tools/validate-trip-data.js` (top-level keys →
enrichments, i.e. everything that doesn't touch the filesystem) into
`tools/lib/validate.js` exporting `validateTripData(d)` → ordered
`{findings: [{type: ok|warn|err, msg}], errors, warnings, earlyExit}`. The CLI
keeps: file loading, HTML extraction, the ALLOWED/PLANNERS cross-checks, printing,
exit codes — and prints module findings with the same ✓/⚠/✗ prefixes in the same
order. **CLI output must stay byte-identical on existing inputs** (verified against
fixtures + the pre-change index.html). New module-level check: optional top-level
`"planners"` must be a non-empty subset of family names (no output when the key is
absent, so existing inputs are unaffected).

## Derived name lists (the auth-sensitive bit — exact diff flagged in the report)

- `allowedNames()` = active trip's `family[].name`; falls back to the hardcoded
  `ALLOWED` literal only when there is no active trip row.
- `plannerNames()` = active trip's optional `planners` (filtered to family);
  defaults to all family; hardcoded `PLANNERS` literal is the no-trip fallback.
- Every `ALLOWED.includes/…` and `PLANNERS.includes/…` call site swaps to the
  function. **Invariant preserved:** writers are still trusted solely by their
  token (`req.authUser`); only the membership lists became dynamic; middleware
  order untouched. The literals stay (as fallback), so the CLI validator's
  server.js cross-check regex still finds them.

## Client boot (public/index.html)

The app reads `TRIP` synchronously at script top, so boot becomes a 3-step
bootstrap without rewriting the app:
1. The main app `<script>` becomes inert (`type="text/plain" id="trip-main"`).
2. A small bootstrap script (before it) fetches `/api/trip` (3 s timeout):
   success → write JSON into the `#trip-data` node + cache in localStorage
   (`tg_trip_cache`); failure → use `tg_trip_cache` if present; else leave the
   inline block (shipped sample = fallback of last resort).
3. Bootstrap then re-injects the main script's text as a real `<script>` node —
   the app boots exactly as before, reading whichever JSON won.
- `DEFAULT_TZ` becomes `TRIP.tz || "America/New_York"` (new optional top-level
  `tz` key). Client `PLANNERS` const becomes derived: `TRIP.planners` filtered to
  family, else all family names (matches the server's derivation).
- sw.js untouched (no caching, so /api/trip is always live when online).

## Admin UI (public/admin.html) — "Trip Setup" section

Paste box → **Validate** (calls /api/trip/validate; renders ✓/✗/⚠ list + summary
card: title, dates, N travelers / days / activities) → **Import** (enabled after a
clean validate; confirm dialog states: replaces the trip for everyone; PINs and
votes for continuing names are kept; warns when >50% of activity ids change =
orphaned votes) → success + version shown. **Export** button downloads
/api/trip/export.

## Import semantics (no code beyond the above)

Users/PINs/votes/notes persist by name. Names absent from the new trip simply
fail the derived-ALLOWED login check (rows retained). New names register on first
login. Continuing names keep everything.

## Docs

ADMIN.md: Trip Setup section (validate → import → export, what survives an
import). BUILD_WITH_AI.md Step 3: web import is the primary path when an admin
console exists; apply-tool and hand-edit remain documented for localhost users.

## Stages (one commit each)

1. This plan.
2. `tools/lib/validate.js` refactor + CLI rewire. Verify: CLI output byte-identical
   on (a) extracted sample JSON, (b) pre-change public/index.html, (c) a
   deliberately broken fixture; exit codes unchanged.
3. Server storage: table, boot seed, cache, GET /api/trip + /api/trip/export.
   Verify: fresh db seeds version 1 identical to the inline block; GETs public.
4. Server import + derived lists: POST /api/trip(+/validate), allowedNames/
   plannerNames swap. Verify (harness): gate 404 unset / 401 wrong key; bad JSON →
   readable error list; import Smith-Italy trip → old name's login rejected, new
   name registers, continuing name's PIN + votes survive, version bumped, export
   round-trips.
5. Client bootstrap + tz + derived client PLANNERS. Verify: bootstrap logic unit-
   tested with stubbed fetch/localStorage (server wins; cache fallback; inline
   last resort); page smoke via real server.
6. admin.html Trip Setup UI. Verify: inline script parses; manual-shape checks.
7. Docs. Then the branch rides the full T7 sweep.

Failure rule: any stage failing twice → stop, commit WIP-STOPPED, push, move on.
