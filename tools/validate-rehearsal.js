#!/usr/bin/env node
/*
 * tools/validate-rehearsal.js — checks for tools/lib/validate.js, the one
 * validator behind both `tools/validate-trip-data.js` and POST /api/trip/validate.
 *
 * WHY THIS EXISTS
 * A trip imported without enrichments.facts passed the validator with zero
 * warnings and then rendered a blank page (fixed in the UI in v0.23.1). The
 * validator must at least say so. The same release lets dietary."verified"
 * carry a month ("2026-09") when that is all that is known.
 *
 * Every check runs against a mutated copy of the synthetic sample trip in
 * public/index.html. Same conventions as the other rehearsals: one PASS/FAIL
 * row per assertion, a RESULT line, non-zero exit on any failure.
 *
 * USAGE
 *   node tools/validate-rehearsal.js            # this checkout
 *   node tools/validate-rehearsal.js <repo>     # another checkout (negative controls)
 */
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const { validateTripData } = require(path.join(ROOT, 'tools', 'lib', 'validate.js'));
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const open = '<script type="application/json" id="trip-data">';
const i = html.indexOf(open) + open.length;
const SAMPLE = JSON.parse(html.slice(i, html.indexOf('</' + 'script>', i)));

let pass = 0, fail = 0;
const ck = (label, ok) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label); };
const clone = () => JSON.parse(JSON.stringify(SAMPLE));
const run = d => validateTripData(d);
const warnsAbout = (r, re) => r.findings.filter(f => f.type === 'warn' && re.test(f.msg));

// the baseline every other check is measured against
const base = run(clone());
ck('sample trip: 0 errors', base.errors === 0);
const baseWarn = base.warnings;

// ── enrichments ────────────────────────────────────────────────────────────
for (const key of ['facts', 'missions', 'phrases']) {
  const d = clone(); delete d.enrichments[key];
  const r = run(d);
  ck('enrichments.' + key + ' removed: still 0 errors (the v0.23.1 UI shows no card instead of crashing)', r.errors === 0);
  const w = warnsAbout(r, new RegExp('enrichments\\.' + key + ' is missing'));
  ck('enrichments.' + key + ' removed: a warning names it as missing', w.length === 1);
  ck('enrichments.' + key + ' removed: the warning carries the v0.23.0 blank-page caveat and the {} fix',
    w.length === 1 && /BLANK PAGE/.test(w[0].msg) && w[0].msg.includes('"' + key + '": {}'));
}
{
  const d = clone(); delete d.enrichments.facts;
  const w = warnsAbout(run(d), /enrichments\.facts is missing/)[0];
  ck('missing-facts warning tells older instances to add "facts": {}', !!w && /BLANK PAGE/.test(w.msg) && /"facts": \{\}/.test(w.msg));
}
{
  const d = clone(); d.enrichments.facts = 'not a map';
  ck('enrichments.facts as a string: warned', warnsAbout(run(d), /enrichments\.facts should be an object/).length === 1);
}
{
  const d = clone(); d.enrichments.facts = ['a fact', 'another'];
  const r = run(d);
  ck('enrichments.facts as an array: still accepted with the existing advice', warnsAbout(r, /enrichments\.facts is an array/).length === 1 && warnsAbout(r, /is missing/).length === 0);
}

// ── dietary."verified" ─────────────────────────────────────────────────────
const foodActs = d => d.days.flatMap(x => x.activities || []).filter(a => a.dietary && typeof a.dietary === 'object');
ck('sample has at least one activity with a dietary block to test on', foodActs(clone()).length > 0);
const withVerified = v => { const d = clone(); foodActs(d)[0].dietary.verified = v; return run(d); };
const verifiedWarns = r => warnsAbout(r, /dietary\."verified"/).length;
for (const v of ['2026-09', '2026-09-15', '2026-12', '2026-01-01']) {
  const r = withVerified(v);
  ck('verified ' + JSON.stringify(v) + ': accepted (no warning, total warnings unchanged)', verifiedWarns(r) === 0 && r.warnings === baseWarn);
}
for (const v of ['2026-13', '2026-00', '2026-9', 'Sep 2026', '2026-09-32', '2026-09-1', '09/2026', '']) {
  ck('verified ' + JSON.stringify(v) + ': warned', verifiedWarns(withVerified(v)) === 1);
}
{
  const w = warnsAbout(withVerified('Sep 2026'), /dietary\."verified"/)[0];
  ck('verified warning names both accepted shapes', !!w && /2026-08-11/.test(w.msg) && /"2026-08"/.test(w.msg));
}

// ── units (v0.24.0) ────────────────────────────────────────────────────────
for (const u of ['C', 'F']) {
  const d = clone(); d.units = u;
  ck('units ' + JSON.stringify(u) + ': accepted', warnsAbout(run(d), /"units"/).length === 0);
}
for (const u of ['celsius', 'c', 1]) {
  const d = clone(); d.units = u;
  ck('units ' + JSON.stringify(u) + ': warned', warnsAbout(run(d), /"units" should be "C" or "F"/).length === 1);
}
ck('no units key: nothing said', warnsAbout(run(clone()), /"units"/).length === 0);

// ── per-day time zone (v0.25.2) ─────────────────────────────────────────────
{
  const d = clone(); d.dayCoords.day3.tz = 'Europe/Rome';
  const r = run(d);
  ck('dayCoords.day3.tz "Europe/Rome": accepted (0 errors, no tz warning)', r.errors === 0 && warnsAbout(r, /\.tz /).length === 0);
}
for (const z of ['Mars/Olympus_Mons', '', 5]) {
  const d = clone(); d.dayCoords.day3.tz = z;
  const r = run(d);
  ck('dayCoords.day3.tz ' + JSON.stringify(z) + ': warned (never an error — the app ignores it)', r.errors === 0 && warnsAbout(r, /dayCoords\.day3\.tz .* is not a time zone name/).length === 1);
}

console.log('');
console.log('RESULT: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
