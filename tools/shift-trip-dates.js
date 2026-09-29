#!/usr/bin/env node
/*
 * tools/shift-trip-dates.js — move every date in a trip by the same number of
 * days, so day 1 lands on the date you choose.
 *
 * Why: the sample trip (and any trip copied from an old one) is dated in the
 * past, so the app shows "welcome home" instead of the countdown, the Now
 * screen, or the weather. Shift it to the coming days to try those screens, or
 * re-date a trip you are reusing.
 *
 *   node tools/shift-trip-dates.js my-trip.json --start 2026-10-05 --out my-trip.shifted.json
 *   node tools/shift-trip-dates.js --sample --start today+3 --out sample-now.json
 *   node tools/shift-trip-dates.js my-trip.json --days 7          (JSON on stdout)
 *
 *   --sample        read the sample trip from public/index.html (never writes it back)
 *   --start DATE    day 1's new date: YYYY-MM-DD, "today", or "today+N"
 *   --days N        or: move everything N days (negative = earlier)
 *   --out PATH      write the result here (default: stdout; never into public/)
 *   --force         write it even if the validator finds errors
 *
 * What moves: trip.startDate / endDate, every dayCoords.<day>.date, and the
 * display dates in flights[].date, reservationsSeed[].date and days[].label
 * when they look like a date ("Sat Sep 5", "Sep 5", "Saturday, September 5",
 * optionally ", 2026") — the weekday is recomputed and the style kept.
 * What does not: a flight/booking date in another form ("5 Sep"), and any
 * date in free text (title, subtitle, notes, descriptions…) — every one found
 * is LISTED at the end so you can fix it by hand. dietary "verified" dates
 * are when something was checked, not trip dates, so they stay.
 *
 * The result is checked with the same validator the server uses. Import it
 * the usual way (admin page, or tools/apply-trip-data.js on a first deploy).
 * Nothing already in a database moves: Day Plan rows keep their saved text.
 */
'use strict';
const fs = require('fs'), path = require('path');
const { validateTripData } = require(path.join(__dirname, 'lib', 'validate.js'));

const MON_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW_S = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_L = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

const isoToUTC = s => { const m = ISO.exec(s); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const utcToISO = t => new Date(t).toISOString().slice(0, 10);
const shiftISO = (s, n) => utcToISO(isoToUTC(s) + n * DAY_MS);

// "Sat Sep 5", "Saturday, September 5", "Sep 5", "Sep 5, 2026" — anchored:
// the whole string must be the date (labels like "Day 1" never match).
const MON_RE = '(' + MON_L.join('|') + '|' + MON_S.join('|') + ')\\.?';
const DOW_RE = '(?:(' + DOW_L.join('|') + '|' + DOW_S.join('|') + ')\\.?,?\\s+)?';
const DISPLAY = new RegExp('^' + DOW_RE + MON_RE + '\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?$');

// A display date has no year: take the one that puts it nearest the trip's
// original start (so "Jan 2" on a trip that starts Dec 28 is next year).
function yearFor(mon, day, anchorUTC) {
  const y0 = new Date(anchorUTC).getUTCFullYear();
  let best = y0, gap = Infinity;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const g = Math.abs(Date.UTC(y, mon, day) - anchorUTC);
    if (g < gap) { gap = g; best = y; }
  }
  return best;
}
function shiftDisplay(s, n, anchorUTC) {
  const str = String(s).trim();
  const m = DISPLAY.exec(str);
  if (!m) return null;
  const [, dow, monTxt, dayTxt, yearTxt] = m;
  const longMon = MON_L.indexOf(monTxt) >= 0;
  const mon = longMon ? MON_L.indexOf(monTxt) : MON_S.indexOf(monTxt);
  const day = +dayTxt;
  const year = yearTxt ? +yearTxt : yearFor(mon, day, anchorUTC);
  if (day < 1 || new Date(Date.UTC(year, mon, day)).getUTCDate() !== day) return null; // "Feb 30" is not a date
  const t = Date.UTC(year, mon, day) + n * DAY_MS;
  const d = new Date(t);
  const monOut = (longMon ? MON_L : MON_S)[d.getUTCMonth()];
  let out = monOut + ' ' + d.getUTCDate();
  if (yearTxt) out += ', ' + d.getUTCFullYear();
  if (dow) {
    const longDow = DOW_L.indexOf(dow) >= 0;
    const comma = /^\.?,/.test(str.slice(dow.length));
    out = (longDow ? DOW_L : DOW_S)[d.getUTCDay()] + (comma ? ', ' : ' ') + out;
  }
  return out;
}

function parseArgs(argv) {
  const o = { file: null, sample: false, start: null, days: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') o.sample = true;
    else if (a === '--start') o.start = argv[++i];
    else if (a === '--days') o.days = argv[++i];
    else if (a === '--out') { o.out = argv[++i]; if (!o.out || o.out.startsWith('--')) throw new Error('--out needs a file path'); }
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else if (!o.file) o.file = a;
    else throw new Error('one trip file only');
  }
  return o;
}
function todayISO(now) {
  const d = now ? new Date(now) : new Date();
  return utcToISO(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); // the local calendar day
}
function resolveStart(spec, now) {
  const m = /^today(?:\+(\d+))?$/.exec(String(spec || ''));
  if (m) return shiftISO(todayISO(now), m[1] ? +m[1] : 0);
  if (ISO.test(String(spec || '')) && utcToISO(isoToUTC(spec)) === spec) return spec; // a real calendar day
  throw new Error('--start wants YYYY-MM-DD, "today" or "today+N" (got ' + JSON.stringify(spec) + ')');
}

// The whole job, as a function the rehearsal can call directly.
function shiftTrip(trip, opts) {
  const t = JSON.parse(JSON.stringify(trip));
  const start0 = t.trip && t.trip.startDate;
  if (!ISO.test(String(start0 || ''))) throw new Error('trip.startDate must be YYYY-MM-DD to shift from');
  let n;
  if (opts.days != null && opts.days !== '') {
    if (!/^-?\d+$/.test(String(opts.days))) throw new Error('--days wants a whole number');
    n = +opts.days;
  } else if (opts.start) {
    n = Math.round((isoToUTC(resolveStart(opts.start, opts.now)) - isoToUTC(start0)) / DAY_MS);
  } else throw new Error('say where to move it: --start DATE or --days N');
  const anchor = isoToUTC(start0);
  const changed = [], leftAlone = [];
  const iso = (obj, key, label) => {
    if (obj && ISO.test(String(obj[key] || ''))) {
      const was = obj[key];
      if (utcToISO(isoToUTC(was)) !== was) throw new Error(label + ' is "' + was + '", which is not a real date — fix it first');
      obj[key] = shiftISO(was, n); changed.push(label + ': ' + was + ' → ' + obj[key]);
    }
  };
  const handled = new Set(); // "<label>" of every field shifted or reported above
  const disp = (obj, key, label, isDateField) => {
    if (!obj || typeof obj[key] !== 'string') return;
    const v = shiftDisplay(obj[key], n, anchor);
    if (v !== null) { changed.push(label + ': ' + obj[key] + ' → ' + v); obj[key] = v; handled.add(label); }
    else if (isDateField && obj[key].trim()) { leftAlone.push(label + ': ' + JSON.stringify(obj[key]) + ' (a date field in a form this tool does not read)'); handled.add(label); }
  };
  iso(t.trip, 'startDate', 'trip.startDate');
  iso(t.trip, 'endDate', 'trip.endDate');
  Object.keys(t.dayCoords || {}).forEach(k => iso(t.dayCoords[k], 'date', 'dayCoords.' + k + '.date'));
  (t.days || []).forEach((d, i) => disp(d, 'label', 'days[' + i + '].label', false));
  (t.flights || []).forEach((f, i) => disp(f, 'date', 'flights[' + i + '].date', true));
  (t.reservationsSeed || []).forEach((r, i) => disp(r, 'date', 'reservationsSeed[' + i + '].date', true));
  // every other string that mentions a date (month + day either way round, or
  // YYYY-MM-DD): list it, don't touch it. Shifted fields and dietary
  // "verified" (when something was checked) are skipped.
  const FREE = new RegExp('\\b' + MON_RE + '\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+' + MON_RE + '\\b|\\d{4}-\\d{2}-\\d{2}');
  const SKIP = /^(trip\.(startDate|endDate)|dayCoords\.[^.]+\.date|.*\.dietary\.verified)$/;
  const walk = (v, label) => {
    if (typeof v === 'string') { if (!handled.has(label) && !SKIP.test(label) && FREE.test(v)) leftAlone.push(label + ': ' + JSON.stringify(v.length > 90 ? v.slice(0, 90) + '…' : v)); return; }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, label + '[' + i + ']'));
    else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], label ? label + '.' + k : k));
  };
  walk(t, '');
  return { trip: t, days: n, changed, leftAlone };
}

// Is `out` inside the repo's public/ folder? Follows symlinks (the real
// folder is compared) and ignores letter case where the file system does
// (Windows, macOS), so "Public\\x.json" or a link into public/ are caught.
function insidePublic(out, opts) {
  const P = (opts && opts.path) || path;
  const real = (opts && opts.realpath) || (p => { try { return fs.realpathSync(p); } catch (e) { return null; } });
  const pub = P.resolve((opts && opts.root) || path.join(__dirname, '..'), 'public');
  let dir = P.dirname(P.resolve(out));
  // walk up to the nearest folder that exists, then take its real path
  let tail = P.basename(P.resolve(out));
  while (real(dir) === null && P.dirname(dir) !== dir) { tail = P.basename(dir) + P.sep + tail; dir = P.dirname(dir); }
  const full = P.join(real(dir) || dir, tail);
  const fold = ((opts && opts.platform) || process.platform) === 'win32' || ((opts && opts.platform) || process.platform) === 'darwin' ? s => s.toLowerCase() : s => s;
  const pubReal = real(pub) || pub;
  return fold(full).startsWith(fold(pubReal) + P.sep) || fold(full) === fold(pubReal);
}

function sampleTrip(root) {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const T = '<script type="application/json" id="trip-data">';
  const i = html.indexOf(T);
  if (i < 0) throw new Error('no trip-data block in public/index.html');
  return JSON.parse(html.slice(i + T.length, html.indexOf('</' + 'script>', i)));
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error('shift-trip-dates: ' + e.message); return 2; }
  if (o.help || (!o.file && !o.sample)) { console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 32).map(l => l.replace(/^ \* ?/, '')).join('\n')); return o.help ? 0 : 2; }
  let trip;
  try { trip = o.sample ? sampleTrip(path.join(__dirname, '..')) : JSON.parse(fs.readFileSync(o.file, 'utf8')); }
  catch (e) { console.error('shift-trip-dates: could not read the trip — ' + e.message); return 2; }
  if (o.days != null && o.start) { console.error('shift-trip-dates: give --start OR --days, not both'); return 2; }
  if (o.out) {
    if (insidePublic(o.out)) { console.error('shift-trip-dates: refusing to write into public/ — everything there is served to anyone, and the app lives there'); return 2; }
    try { if (fs.statSync(o.out).isDirectory()) { console.error('shift-trip-dates: --out ' + o.out + ' is a folder — give a file name'); return 2; } } catch (e) { /* a new file: fine */ }
  }
  let r;
  try { r = shiftTrip(trip, o); } catch (e) { console.error('shift-trip-dates: ' + e.message); return 2; }
  const v = validateTripData(r.trip);
  if (v.errors && !o.force) {
    console.error('shift-trip-dates: the shifted trip has ' + v.errors + ' validator error(s) — nothing written:');
    v.findings.filter(f => f.type === 'err').slice(0, 10).forEach(f => console.error('  ✗ ' + f.msg));
    return 1;
  }
  const json = JSON.stringify(r.trip, null, 1) + '\n';
  if (o.out) fs.writeFileSync(o.out, json); else process.stdout.write(json);
  const log = s => console.error(s);
  log('shift-trip-dates: moved ' + (r.days >= 0 ? '+' : '') + r.days + ' day(s); day 1 is now ' + r.trip.trip.startDate);
  r.changed.forEach(c => log('  ✓ ' + c));
  if (r.leftAlone.length) { log('  not changed (free text — fix by hand if it should move):'); r.leftAlone.forEach(c => log('    · ' + c)); }
  log('  validator: ' + v.errors + ' error(s), ' + v.warnings + ' warning(s)' + (o.out ? ' — written to ' + o.out : ''));
  return v.errors ? 1 : 0;
}

module.exports = { shiftTrip, shiftDisplay, resolveStart, insidePublic };
if (require.main === module) process.exitCode = main();
