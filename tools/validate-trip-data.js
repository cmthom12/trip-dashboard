#!/usr/bin/env node
/*
 * validate-trip-data.js — sanity-check a trip-data JSON file before pasting it
 * into the app (or after pasting: point it at public/index.html directly).
 *
 * Zero dependencies. Usage:
 *   node tools/validate-trip-data.js my-trip.json
 *   node tools/validate-trip-data.js public/index.html
 *   node tools/validate-trip-data.js my-trip.json --data-only   # skip the name cross-checks
 *
 * Checks the shapes the app ACTUALLY reads (see BUILD_WITH_AI.md), the
 * day <-> dayCoords pairing, category keys, traveler-name consistency, and —
 * when server.js / public/index.html are findable — that the same names appear
 * in ALLOWED, PLANNERS (server.js) and PLANNERS (public/index.html).
 *
 * The data checks themselves live in tools/lib/validate.js, shared with the
 * server's import endpoint (POST /api/trip) so both agree on what "valid" means.
 * This file adds: file/HTML loading, the cross-checks, printing, exit codes.
 *
 * Exit code 0 = no errors (warnings allowed), 1 = errors found.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { validateTripData } = require('./lib/validate.js');

const args = process.argv.slice(2);
const dataOnly = args.includes('--data-only'); // JSON shape only; skip the ALLOWED/PLANNERS cross-checks
const file = args.find(a => a !== '--data-only');
if (!file) {
  console.log('Usage: node tools/validate-trip-data.js <trip-data.json | public/index.html> [--data-only]');
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

// ── the shared data checks ───────────────────────────────────────────────────
const res = validateTripData(d);
for (const f of res.findings) (f.type === 'err' ? err : f.type === 'warn' ? warn : ok)(f.msg);
// counters were incremented per finding by err/warn above, so summary + exit code stay right
if (res.earlyExit) { summary(); process.exit(1); }

const famNames = (Array.isArray(d.family) ? d.family : [])
  .filter(f => typeof f.name === 'string' && f.name.trim()).map(f => f.name);

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
const serverPath = dataOnly ? null : findUp('server.js');
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
} else if (!dataOnly && !serverPath) warn('server.js not found nearby — skipped the ALLOWED/PLANNERS cross-check');

const htmlPath = dataOnly ? null :
  (path.resolve(file).endsWith('index.html') ? path.resolve(file) : findUp(path.join('public', 'index.html')));
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
