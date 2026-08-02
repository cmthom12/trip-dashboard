#!/usr/bin/env node
/*
 * apply-trip-data.js — install an AI-generated trip JSON into the app, safely.
 *
 * Does everything BUILD_WITH_AI.md Step 3 describes, automatically:
 *   1. validates the JSON (same checks as tools/validate-trip-data.js),
 *   2. backs up public/index.html and server.js to *.backup-<timestamp>,
 *   3. injects the JSON between the trip-data <script> tags,
 *   4. updates the traveler-name lists (family is in the JSON itself;
 *      ALLOWED + PLANNERS in server.js; PLANNERS in public/index.html on
 *      older trees — newer index.html derives planners from the trip data,
 *      so that patch is skipped with a note when the const is absent),
 *   5. optionally sets the timezone (patches the DEFAULT_TZ literal on older
 *      trees; on v0.6+ trees, where the literal is gone and the client reads
 *      the trip's "tz" key, --tz is written into the trip JSON itself),
 *   6. re-validates the patched files and prints what to do next.
 *
 * Zero dependencies. Safe to run twice. Usage:
 *   node tools/apply-trip-data.js my-trip.json
 *   node tools/apply-trip-data.js my-trip.json --tz America/Chicago
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const SERVER_PATH = path.join(ROOT, 'server.js');
const VALIDATOR = path.join(__dirname, 'validate-trip-data.js');

const fail = m => { console.log('✗ ' + m); process.exit(1); };

// ── arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let file = null, tz = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--tz') { tz = args[++i]; if (!tz) fail('--tz needs a value, e.g. --tz America/Chicago'); }
  else if (a.startsWith('--tz=')) tz = a.slice(5);
  else if (a.startsWith('--')) fail('Unknown option "' + a + '". The only option is --tz <timezone>.');
  else if (!file) file = a;
  else fail('I can only apply one file at a time (got "' + file + '" and "' + a + '").');
}
if (!file) {
  console.log('Usage: node tools/apply-trip-data.js <my-trip.json> [--tz America/Chicago]');
  console.log('  <my-trip.json>  the JSON your AI produced (see BUILD_WITH_AI.md)');
  console.log('  --tz            optional timezone for the calendar/clock, e.g. Europe/Rome');
  process.exit(1);
}
if (tz != null) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
  catch (e) { fail('"' + tz + '" is not a valid timezone. Use an IANA name like "America/Chicago" or "Europe/Rome".'); }
}

// ── step 1: read + validate the trip JSON ────────────────────────────────────
let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (e) { fail('Cannot read "' + file + '" — is the file in this folder and the name spelled right? (' + e.message + ')'); }
if (raw.includes('<script'))
  fail('"' + file + '" looks like an HTML file, not trip JSON. Pass the JSON file your AI gave you (usually my-trip.json).');
let trip;
try { trip = JSON.parse(raw); }
catch (e) {
  console.log('✗ "' + file + '" is not valid JSON: ' + e.message);
  console.log('  Tip: tell your AI — "That didn\'t parse as JSON — return only the JSON object, no fences, no commentary."');
  process.exit(1);
}
console.log('Checking ' + file + ' …');
const pre = spawnSync(process.execPath, [VALIDATOR, file, '--data-only'], { stdio: 'inherit' });
if (pre.status !== 0) {
  console.log('');
  fail('Not installed — fix the ✗ lines above first (paste them to your AI and ask it to correct the JSON), then run this again. Nothing was changed.');
}

const famNames = (Array.isArray(trip.family) ? trip.family : []).map(f => f && f.name).filter(Boolean);
if (!famNames.length) fail('No traveler names found in "family" — nothing was changed.');

let jsonText = JSON.stringify(trip, null, 1);
if (/<\/script/i.test(jsonText))
  fail('The JSON contains the text "</script>", which would break the app\'s HTML. Ask your AI to remove it. Nothing was changed.');

// ── read the app files and prepare every patch BEFORE writing anything ───────
let html, server;
try { html = fs.readFileSync(HTML_PATH, 'utf8'); } catch (e) { fail('Cannot read ' + HTML_PATH + ' — run this from the app folder (' + e.message + ')'); }
try { server = fs.readFileSync(SERVER_PATH, 'utf8'); } catch (e) { fail('Cannot read ' + SERVER_PATH + ' (' + e.message + ')'); }

// step 5a (prepared): where does the timezone live on this tree? Older trees
// carry a `const DEFAULT_TZ = "..."` literal to patch; v0.6+ index.html derives
// it from the trip's top-level "tz" key, so --tz goes into the trip JSON itself
// (before it is serialized and injected below). tz was already validated as a
// real IANA name, so re-serializing cannot introduce "</script>".
const TZ_RE = /const\s+DEFAULT_TZ\s*=\s*"[^"]*"/;
const tzInTrip = tz != null && !TZ_RE.test(html);
if (tzInTrip) {
  trip.tz = tz;
  jsonText = JSON.stringify(trip, null, 1);
}

// step 3 (prepared): the trip-data block
const TAG = '<script type="application/json" id="trip-data">';
const iTag = html.indexOf(TAG);
if (iTag < 0) fail('Could not find the trip-data <script> tag in public/index.html — has the file been edited by hand?');
const iEnd = html.indexOf('</' + 'script>', iTag);
if (iEnd < 0) fail('Found the trip-data tag but not its closing </' + 'script> in public/index.html.');
html = html.slice(0, iTag + TAG.length) + '\n' + jsonText + '\n' + html.slice(iEnd);

// step 4 (prepared): the three hardcoded name lists (list #4 is `family` in the JSON itself)
const namesJs = '[' + famNames.map(n => JSON.stringify(n)).join(', ') + ']';
function patchList(src, varName, where) {
  const re = new RegExp('const\\s+' + varName + '\\s*=\\s*\\[[^\\]]*\\]');
  if (!re.test(src)) fail('Could not find "const ' + varName + ' = [...]" in ' + where + ' — has the file been edited by hand? Nothing was changed.');
  return src.replace(re, 'const ' + varName + ' = ' + namesJs);
}
server = patchList(server, 'ALLOWED', 'server.js');
server = patchList(server, 'PLANNERS', 'server.js');
// v0.6+ index.html has no `const PLANNERS = [...]` — the client derives
// planners from the trip data itself, so there is nothing to patch there.
const htmlHasPlannersList = /const\s+PLANNERS\s*=\s*\[[^\]]*\]/.test(html);
if (htmlHasPlannersList) html = patchList(html, 'PLANNERS', 'public/index.html');

// step 5 (prepared): timezone (v0.6+ trees were handled in step 5a instead)
if (tz != null && !tzInTrip) {
  if (!TZ_RE.test(html)) fail('Could not find DEFAULT_TZ in public/index.html. Nothing was changed.');
  html = html.replace(TZ_RE, 'const DEFAULT_TZ = ' + JSON.stringify(tz));
}

// ── step 2: back up, then write ──────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
for (const p of [HTML_PATH, SERVER_PATH]) fs.copyFileSync(p, p + '.backup-' + stamp);
console.log('✓ Backed up public/index.html and server.js (*.backup-' + stamp + ')');
fs.writeFileSync(HTML_PATH, html);
fs.writeFileSync(SERVER_PATH, server);
console.log('✓ Trip data installed into public/index.html');
if (htmlHasPlannersList) {
  console.log('✓ Traveler lists updated in both files: ' + famNames.join(', '));
} else {
  console.log('✓ Traveler lists updated in server.js: ' + famNames.join(', '));
  console.log('  (index.html planners now derived from trip data — skipped)');
}
if (tz != null) {
  console.log('✓ Timezone set to ' + tz);
  if (tzInTrip) console.log('  (DEFAULT_TZ now lives in the trip data — wrote "tz" into the installed trip)');
}

// ── step 6: re-validate the patched app ──────────────────────────────────────
console.log('');
console.log('Double-checking the installed app …');
const post = spawnSync(process.execPath, [VALIDATOR, HTML_PATH], { stdio: 'inherit' });
console.log('');
if (post.status !== 0) {
  console.log('✗ Something is off in the patched files (see above). Your originals are safe:');
  console.log('  restore them by copying the *.backup-' + stamp + ' files back over the originals.');
  process.exit(1);
}
console.log('✅ Your trip is installed — restart the app to see it:');
console.log('   • Windows: close the dashboard window if it\'s open, then double-click Start-Dashboard.bat');
console.log('   • Terminal: press Ctrl+C in the running server, then: npm start');
console.log('   Then open http://localhost:3000 and log in as one of your travelers.');
console.log('');
console.log('   Played with the sample trip earlier? Stop the server and delete data.db once,');
console.log('   so the old sample logins don\'t linger. (Everyone re-picks a PIN on next login.)');
