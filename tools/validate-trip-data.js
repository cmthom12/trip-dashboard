#!/usr/bin/env node
/*
 * validate-trip-data.js — sanity-check a trip-data JSON file before pasting it
 * into the app (or after pasting: point it at public/index.html directly).
 *
 * Zero dependencies. Usage:
 *   node tools/validate-trip-data.js my-trip.json
 *   node tools/validate-trip-data.js public/index.html
 *
 * Checks the shapes the app ACTUALLY reads (see BUILD_WITH_AI.md), the
 * day <-> dayCoords pairing, category keys, traveler-name consistency, and —
 * when server.js / public/index.html are findable — that the same names appear
 * in ALLOWED, PLANNERS (server.js) and PLANNERS (public/index.html).
 *
 * Exit code 0 = no errors (warnings allowed), 1 = errors found.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.log('Usage: node tools/validate-trip-data.js <trip-data.json | public/index.html>');
  process.exit(1);
}

let errors = 0, warnings = 0;
const err  = m => { errors++;   console.log('✗ ' + m); };
const warn = m => { warnings++; console.log('⚠ ' + m); };
const ok   = m => {             console.log('✓ ' + m); };

// ── load (plain JSON, or extract the trip-data block from an HTML file) ──────
let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (e) { console.log('✗ Cannot read ' + file + ': ' + e.message); process.exit(1); }

const TAG = '<script type="application/json" id="trip-data">';
if (raw.includes(TAG)) {
  const i = raw.indexOf(TAG) + TAG.length;
  const j = raw.indexOf('</' + 'script>', i);
  raw = raw.slice(i, j);
  ok('Found the trip-data block inside the HTML file');
}

let d;
try { d = JSON.parse(raw); }
catch (e) {
  err('Not valid JSON: ' + e.message);
  console.log('  Tip: tell your AI — "That didn\'t parse as JSON — return only the JSON object, no fences, no commentary."');
  process.exit(1);
}
ok('Valid JSON');

const isStr = x => typeof x === 'string';
const isNum = x => typeof x === 'number' && isFinite(x);
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const isLL  = x => Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1]);
const ISO   = /^\d{4}-\d{2}-\d{2}$/;

// ── required top-level keys ──────────────────────────────────────────────────
for (const k of ['trip', 'family', 'categories', 'days', 'dayCoords', 'flights',
                 'reservationsSeed', 'essentials', 'embassies', 'enrichments']) {
  if (!(k in d)) err('Missing top-level key "' + k + '" — the app will crash or show a blank section without it');
}
if (errors) { summary(); process.exit(1); }
ok('All 10 top-level keys present');

// ── trip ─────────────────────────────────────────────────────────────────────
const t = d.trip;
if (!isObj(t)) err('"trip" must be an object');
else {
  for (const k of ['title', 'brand', 'subtitle']) if (!isStr(t[k]) || !t[k]) err('trip.' + k + ' must be a non-empty string (shown in the header)');
  for (const k of ['startDate', 'endDate']) if (!ISO.test(String(t[k] || ''))) err('trip.' + k + ' must be "YYYY-MM-DD" (got ' + JSON.stringify(t[k]) + ')');
}

// ── family ───────────────────────────────────────────────────────────────────
const fam = Array.isArray(d.family) ? d.family : [];
if (!fam.length) err('"family" must be a non-empty array — nobody could log in');
if (fam.length > 8) warn('family has ' + fam.length + ' travelers — the UI is designed for 1–8');
const famNames = [];
fam.forEach((f, i) => {
  if (!isStr(f.name) || !f.name.trim()) err('family[' + i + '].name must be a non-empty string');
  else famNames.push(f.name);
  if (!Array.isArray(f.color) || f.color.length !== 2 || !f.color.every(isStr))
    warn('family[' + i + '] ("' + (f.name || '?') + '") color should be ["#background","#text"] — name chips fall back to gray');
});
if (new Set(famNames).size !== famNames.length) err('Traveler names in family are not unique');
else if (famNames.length) ok('family: ' + famNames.length + ' travelers (' + famNames.join(', ') + ')');

// ── categories ───────────────────────────────────────────────────────────────
if (!isObj(d.categories) || !Object.keys(d.categories).length) err('"categories" must be a non-empty object');
else {
  for (const [k, c] of Object.entries(d.categories)) {
    if (!isObj(c) || !isStr(c.label) || !isStr(c.emoji) || !isStr(c.tw))
      warn('categories.' + k + ' should have {label, emoji, tw} — activities in it render with a gray badge');
  }
  ok('categories: ' + Object.keys(d.categories).join(', '));
}

// ── days + activities ────────────────────────────────────────────────────────
const days = Array.isArray(d.days) ? d.days : [];
if (!days.length) err('"days" must be a non-empty array');
const dayIds = days.map(x => x && x.id);
if (new Set(dayIds).size !== dayIds.length) err('day ids are not unique');
const actIds = new Set();
days.forEach((day, di) => {
  const label = 'days[' + di + '] ("' + (day.id || '?') + '")';
  if (!isStr(day.id) || !day.id) err(label + ' needs a string "id" like "day1"');
  if (!isStr(day.label)) warn(label + ' has no "label" — the day strip shows blank text for it');
  if (!isStr(day.location)) warn(label + ' has no "location" — the day header shows blank');
  const acts = Array.isArray(day.activities) ? day.activities : (err(label + ' needs an "activities" array'), []);
  if (!acts.length) warn(label + ' has no activities — the itinerary for that day will be empty');
  acts.forEach((a, ai) => {
    const al = label + '.activities[' + ai + '] ("' + (a.id || a.name || '?') + '")';
    for (const k of ['id', 'name', 'cat', 'desc']) if (!isStr(a[k]) || !a[k]) err(al + ' needs string "' + k + '"');
    if (a.id) { if (actIds.has(a.id)) err(al + ': duplicate activity id "' + a.id + '"'); actIds.add(a.id); }
    if (a.cat && d.categories && !d.categories[a.cat])
      err(al + ': cat "' + a.cat + '" is not a key of categories — it renders as a gray 📍 badge and its filter button won\'t exist');
    if (!Number.isInteger(a.durM)) warn(al + ': "durM" should be integer minutes (sorting by duration breaks without it)');
    if (!(Number.isInteger(a.costN) && a.costN >= 0 && a.costN <= 4)) warn(al + ': "costN" should be an integer 0–4 (cost sorting breaks without it)');
    (Array.isArray(a.who) ? a.who : []).forEach(n => {
      if (!famNames.includes(n)) err(al + ': who lists "' + n + '" who is not in family — spelled differently somewhere?');
    });
    if (a.start != null && !/^\d{2}:\d{2}$/.test(String(a.start))) warn(al + ': "start" should be 24-hour "HH:MM" (got ' + JSON.stringify(a.start) + ')');
    if (a.ll != null && !isLL(a.ll)) warn(al + ': "ll" should be [lat, lng] numbers');
  });
});

// ── dayCoords ────────────────────────────────────────────────────────────────
if (!isObj(d.dayCoords)) err('"dayCoords" must be an object keyed by day id');
else {
  for (const id of dayIds) {
    const dc = d.dayCoords[id];
    if (!dc) { err(id + ' has no dayCoords entry — no weekday label, no weather chip, and "show on map" won\'t exist for that day'); continue; }
    if (!isLL(dc.ll)) err('dayCoords.' + id + '.ll must be [lat, lng] numbers');
    if (!ISO.test(String(dc.date || ''))) err('dayCoords.' + id + '.date must be "YYYY-MM-DD" — weekday labels and calendar export need it');
  }
  for (const id of Object.keys(d.dayCoords)) if (!dayIds.includes(id)) warn('dayCoords has entry "' + id + '" that matches no day id');
  const yrs = new Set(Object.values(d.dayCoords).map(dc => String((dc || {}).date || '').slice(0, 4)).filter(Boolean));
  if ([...yrs].some(y => y !== '2026'))
    warn('trip dates are outside 2026 — a few date features (reservation↔day matching, single-day calendar files) currently assume 2026 and will quietly skip');
  if (!errors) ok('every day has a dayCoords entry');
}

// ── flights ──────────────────────────────────────────────────────────────────
(Array.isArray(d.flights) ? d.flights : (err('"flights" must be an array (use [] if none)'), [])).forEach((f, i) => {
  for (const k of ['id', 'flight', 'route', 'date', 'dep', 'arr']) if (!isStr(f[k])) warn('flights[' + i + '].' + k + ' should be a string');
});

// ── reservationsSeed ─────────────────────────────────────────────────────────
(Array.isArray(d.reservationsSeed) ? d.reservationsSeed : (err('"reservationsSeed" must be an array (use [] if none)'), [])).forEach((r, i) => {
  if (!isStr(r.title) || !r.title) err('reservationsSeed[' + i + '] needs a "title"');
  if (r.date && !/^[A-Z][a-z]{2} \d{1,2}$/.test(r.date)) warn('reservationsSeed[' + i + '].date should look like "Sep 5" — otherwise it can\'t be matched to a day');
});

// ── essentials (the #1 crash trap) ───────────────────────────────────────────
const ess = d.essentials;
if (!Array.isArray(ess)) err('"essentials" must be an array');
else ess.forEach((c, i) => {
  if (!isObj(c)) { err('essentials[' + i + '] is ' + JSON.stringify(c).slice(0, 40) + '… — plain strings CRASH the Essentials tab to a white screen. Each entry must be {country, flag, ports, rows:[{icon,title,detail}]}'); return; }
  if (!Array.isArray(c.rows) || !c.rows.length) err('essentials[' + i + '] ("' + (c.country || '?') + '") needs a non-empty "rows" array — missing rows CRASHES the Essentials tab');
  else c.rows.forEach((r, ri) => {
    if (!isObj(r) || !isStr(r.title) || !isStr(r.detail)) warn('essentials[' + i + '].rows[' + ri + '] should be {icon, title, detail}');
  });
  if (!isStr(c.country)) warn('essentials[' + i + '] should have a "country" heading');
});

// ── embassies ────────────────────────────────────────────────────────────────
(Array.isArray(d.embassies) ? d.embassies : (err('"embassies" must be an array (use [] if none)'), [])).forEach((e, i) => {
  if (!isObj(e)) { err('embassies[' + i + '] must be an object'); return; }
  if (!isStr(e.name)) warn('embassies[' + i + '] should have a "name"');
  if ((e.phone || e.url) && !(e.tel || e.site))
    warn('embassies[' + i + '] ("' + (e.name || '?') + '") uses "phone"/"url" — the app reads "tel", "site" and "mapsq" instead, so the phone and website buttons will be empty');
  if (!isStr(e.mapsq)) warn('embassies[' + i + '] has no "mapsq" (a Google-Maps search string) — its Map button will search for "undefined"');
});

// ── enrichments ──────────────────────────────────────────────────────────────
const en = isObj(d.enrichments) ? d.enrichments : (err('"enrichments" must be an object'), {});
const dayKeyed = (v, name, what) => {
  if (Array.isArray(v)) { warn('enrichments.' + name + ' is an array — the app looks entries up BY DAY ID, so ' + what + '. Use {"day1": …, "day2": …}'); return false; }
  if (!isObj(v)) { warn('enrichments.' + name + ' should be an object keyed by day id'); return false; }
  for (const k of Object.keys(v)) if (!dayIds.includes(k)) warn('enrichments.' + name + '.' + k + ' matches no day id');
  return true;
};
dayKeyed(en.missions, 'missions', 'no mission cards will show');
if (dayKeyed(en.phrases, 'phrases', 'no "Phrase of the day" will show')) {
  for (const [k, p] of Object.entries(en.phrases)) {
    if (!isObj(p) || !isStr(p.gr) || !isStr(p.en)) warn('enrichments.phrases.' + k + ' should be {flag, gr (local phrase), en (English), say (pronunciation)}');
  }
}
if (Array.isArray(en.facts)) warn('enrichments.facts is an array — facts still display, but keying them by day id ("day1": …) pins each fact to its day');

// ── cross-checks against server.js and public/index.html ────────────────────
function findUp(name) {
  for (const base of [path.dirname(path.resolve(file)), process.cwd(), path.join(process.cwd(), '..')]) {
    for (const rel of [name, path.join('..', name)]) {
      const p = path.resolve(base, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
function extractList(src, varName) {
  const m = src.match(new RegExp('const\\s+' + varName + '\\s*=\\s*(\\[[^\\]]*\\])'));
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/'/g, '"')); } catch (e) { return null; }
}
const serverPath = findUp('server.js');
if (serverPath && famNames.length) {
  const src = fs.readFileSync(serverPath, 'utf8');
  for (const listName of ['ALLOWED', 'PLANNERS']) {
    const list = extractList(src, listName);
    if (!list) { warn('Could not read ' + listName + ' from ' + serverPath); continue; }
    const missing = famNames.filter(n => !list.includes(n));
    const extra = list.filter(n => !famNames.includes(n));
    if (missing.length) err(listName + ' in server.js is missing: ' + missing.join(', ') + ' — they CANNOT ' + (listName === 'ALLOWED' ? 'log in' : 'edit the Day Plan'));
    if (extra.length) warn(listName + ' in server.js also lists: ' + extra.join(', ') + ' — not in this trip\'s family (old sample names?)');
    if (!missing.length && !extra.length) ok(listName + ' in server.js matches the family names');
  }
} else if (!serverPath) warn('server.js not found nearby — skipped the ALLOWED/PLANNERS cross-check');

const htmlPath = path.resolve(file).endsWith('index.html') ? path.resolve(file) : findUp(path.join('public', 'index.html'));
if (htmlPath && famNames.length) {
  const src = fs.readFileSync(htmlPath, 'utf8');
  const list = extractList(src, 'PLANNERS');
  if (list) {
    const missing = famNames.filter(n => !list.includes(n));
    if (missing.length) err('PLANNERS in public/index.html (yes, a 4th list!) is missing: ' + missing.join(', ') + ' — the Day Plan edit buttons stay HIDDEN for them even though the server would allow the edit');
    else ok('PLANNERS in public/index.html matches the family names');
  }
}

summary();
process.exit(errors ? 1 : 0);

function summary() {
  console.log('');
  if (!errors && !warnings) console.log('✅ All good — this trip-data should render cleanly.');
  else console.log((errors ? '❌ ' : '✅ ') + errors + ' error(s), ' + warnings + ' warning(s).' +
    (errors ? ' Fix the ✗ lines before pasting into the app (or ask your AI to).' : ' Warnings are cosmetic or minor — read them once, then decide.'));
}
