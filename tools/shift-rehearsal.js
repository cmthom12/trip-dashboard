#!/usr/bin/env node
/*
 * tools/shift-rehearsal.js — checks for tools/shift-trip-dates.js.
 *
 * Runs the shift on the sample trip (read from public/index.html) and on
 * small hand-made trips, and checks what moves, what doesn't, and that the
 * result still validates. Also runs the CLI once end to end.
 *
 * Usage: node tools/shift-rehearsal.js        Exit 0 = every check passed.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const { shiftTrip, shiftDisplay, resolveStart, insidePublic } = require('./shift-trip-dates.js');
const { validateTripData } = require('./lib/validate.js');
let pass = 0, fail = 0;
const ck = (label, ok) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label); };
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const T = '<script type="application/json" id="trip-data">';
const i0 = html.indexOf(T) + T.length;
const SAMPLE = JSON.parse(html.slice(i0, html.indexOf('</' + 'script>', i0)));
const clone = o => JSON.parse(JSON.stringify(o));

console.log('==> the sample trip, +30 days');
const r = shiftTrip(SAMPLE, { days: 30 });
const s = r.trip;
ck('start and end move 30 days (Sep 5–8 → Oct 5–8)', s.trip.startDate === '2026-10-05' && s.trip.endDate === '2026-10-08');
ck('every dayCoords date moves', ['day1', 'day2', 'day3', 'day4'].map(k => s.dayCoords[k].date).join() === '2026-10-05,2026-10-06,2026-10-07,2026-10-08');
ck('flight dates move and get the right weekday ("Sat Sep 5" → "Mon Oct 5")', s.flights[0].date === 'Mon Oct 5' && s.flights[1].date === 'Thu Oct 8');
ck('booking dates move ("Sep 5" → "Oct 5")', s.reservationsSeed.map(x => x.date).join() === 'Oct 5,Oct 5,Oct 7');
ck('labels that are not dates stay ("Day 1")', s.days.map(d => d.label).join() === SAMPLE.days.map(d => d.label).join());
ck('dietary "verified" (when it was checked) does not move', JSON.stringify(s.days[0].activities[1].dietary) === JSON.stringify(SAMPLE.days[0].activities[1].dietary));
const strip = t => { const c = clone(t); delete c.trip.startDate; delete c.trip.endDate; Object.values(c.dayCoords).forEach(x => delete x.date); c.flights.forEach(f => delete f.date); c.reservationsSeed.forEach(x => delete x.date); return JSON.stringify(c); };
ck('nothing else in the trip changes', strip(s) === strip(SAMPLE));
ck('the result validates with 0 errors', validateTripData(s).errors === 0);
const back = shiftTrip(s, { days: -30 }).trip;
ck('shifting back −30 gives the original trip exactly', JSON.stringify(back) === JSON.stringify(SAMPLE));

console.log('==> --start');
const now = new Date(2026, 8, 27, 21, 0); // Sep 27 2026, 9 pm local
ck('"today" is the local calendar day; "today+3" three days later', resolveStart('today', now) === '2026-09-27' && resolveStart('today+3', now) === '2026-09-30');
ck('a YYYY-MM-DD start is taken as is', resolveStart('2026-12-24', now) === '2026-12-24');
let threw = 0;
for (const bad of ['tomorrow', '2026-13-40', '', 'today-2']) { try { resolveStart(bad, now); } catch (e) { threw++; } }
ck('anything else is refused', threw === 4);
const st = shiftTrip(SAMPLE, { start: 'today+3', now }).trip;
ck('--start today+3 puts day 1 on Sep 30 and the rest follow', st.trip.startDate === '2026-09-30' && st.dayCoords.day4.date === '2026-10-03' && st.trip.endDate === '2026-10-03');

console.log('==> display dates');
const A = Date.UTC(2026, 11, 28); // anchor: a trip starting Dec 28
ck('year rollover: "Wed Dec 30" +5 → "Mon Jan 4"', shiftDisplay('Wed Dec 30', 5, A) === 'Mon Jan 4');
ck('a date early in the next year is read as next year ("Sat Jan 2" on a Dec 28 trip, +1 → "Sun Jan 3" — 2027\'s weekday)', shiftDisplay('Sat Jan 2', 1, A) === 'Sun Jan 3');
ck('long names and commas keep their style ("Saturday, September 5" +2 → "Monday, September 7")', shiftDisplay('Saturday, September 5', 2, Date.UTC(2026, 8, 5)) === 'Monday, September 7');
ck('an explicit year moves too ("Sep 5, 2026" +120 → "Jan 3, 2027")', shiftDisplay('Sep 5, 2026', 120, Date.UTC(2026, 8, 5)) === 'Jan 3, 2027');
ck('not a date: left alone ("Day 1", "Arrival", "5 Sep")', shiftDisplay('Day 1', 3, A) === null && shiftDisplay('Arrival', 3, A) === null && shiftDisplay('5 Sep', 3, A) === null);
const lab = clone(SAMPLE); lab.days[0].label = 'Sat Sep 5';
ck('a day label written as a date moves with the trip ("Sat Sep 5" +60 → "Wed Nov 4")', shiftTrip(lab, { days: 60 }).trip.days[0].label === 'Wed Nov 4');

console.log('==> free text');
const ft = clone(SAMPLE); ft.trip.subtitle = 'A long weekend — Sep 5–8, 2026';
const rf = shiftTrip(ft, { days: 7 });
ck('a date inside the subtitle is NOT rewritten, but is listed for a hand fix', rf.trip.trip.subtitle === ft.trip.subtitle && rf.leftAlone.some(x => /trip\.subtitle/.test(x)));
const nostart = clone(SAMPLE); delete nostart.trip.startDate;
let e1 = ''; try { shiftTrip(nostart, { days: 1 }); } catch (e) { e1 = e.message; }
ck('a trip without trip.startDate is refused (nothing to shift from)', /startDate/.test(e1));

console.log('==> what it cannot read is listed, not skipped');
const eu = clone(SAMPLE); eu.flights[0].date = '5 Sep'; eu.days[1].activities[0].desc = 'Tickets for Sep 6 only'; eu.essentials[0].rows[0].detail = 'Banks close 7 Sep';
const re = shiftTrip(eu, { days: 7 });
ck('a flight date written "5 Sep" is not moved, and is listed as a date field it could not read', re.trip.flights[0].date === '5 Sep' && re.leftAlone.some(x => /^flights\[0\]\.date: "5 Sep" \(a date field/.test(x)));
ck('dates anywhere in free text are listed — an activity description, an essentials row ("7 Sep" too)', re.leftAlone.some(x => /^days\[1\]\.activities\[0\]\.desc/.test(x)) && re.leftAlone.some(x => /^essentials\[0\]\.rows\[0\]\.detail/.test(x)));
ck('…but not the fields it moved, nor dietary "verified"', !re.leftAlone.some(x => /^(flights\[1\]\.date|reservationsSeed|dayCoords|trip\.startDate)|verified/.test(x)));
ck('an impossible date ("Feb 30") is not a date — nothing is invented', shiftDisplay('Feb 30', 1, Date.UTC(2026, 1, 1)) === null);
const badIso = clone(SAMPLE); badIso.dayCoords.day2.date = '2026-02-30';
let e2 = ''; try { shiftTrip(badIso, { days: 1 }); } catch (e) { e2 = e.message; }
ck('an impossible YYYY-MM-DD ("2026-02-30") stops the run instead of turning into another date', /dayCoords\.day2\.date.*not a real date/.test(e2));

console.log('==> the command line');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-'));
try {
  const out = path.join(d, 'sample-now.json');
  const run = cp.spawnSync(process.execPath, [path.join(__dirname, 'shift-trip-dates.js'), '--sample', '--days', '30', '--out', out], { encoding: 'utf8' });
  const j = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  ck('--sample --days 30 --out FILE: exit 0, writes the shifted trip, reports the validator result', run.status === 0 && !!j && j.trip.startDate === '2026-10-05' && /validator: 0 error/.test(run.stderr));
  ck('…and never touches public/index.html', fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8') === html);
  const bad = cp.spawnSync(process.execPath, [path.join(__dirname, 'shift-trip-dates.js'), '--sample', '--start', 'someday'], { encoding: 'utf8' });
  ck('a bad --start exits 2 with a plain message', bad.status === 2 && /--start wants/.test(bad.stderr));
  const both = cp.spawnSync(process.execPath, [path.join(__dirname, 'shift-trip-dates.js'), '--sample', '--start', 'today', '--days', '3'], { encoding: 'utf8' });
  ck('--start and --days together: refused (exit 2)', both.status === 2 && /not both/.test(both.stderr));
  // a probe file name that does not exist — so a broken guard can't damage the app
  const probe = path.join(ROOT, 'public', 'shift-rehearsal-probe-' + process.pid + '.json');
  const pub = cp.spawnSync(process.execPath, [path.join(__dirname, 'shift-trip-dates.js'), '--sample', '--days', '3', '--out', probe], { encoding: 'utf8' });
  const wrote = fs.existsSync(probe); if (wrote) fs.rmSync(probe);
  ck('--out into public/: refused (exit 2), nothing written there', pub.status === 2 && /public\//.test(pub.stderr) && !wrote);
  // a link that points into public/ is still public/
  const link = path.join(d, 'pub-link');
  let linked = true; try { fs.symlinkSync(path.join(ROOT, 'public'), link, 'dir'); } catch (e) { linked = false; }
  if (linked) {
    const lp = path.join(link, 'shift-rehearsal-probe-' + process.pid + '.json');
    const lr = cp.spawnSync(process.execPath, [path.join(__dirname, 'shift-trip-dates.js'), '--sample', '--days', '3', '--out', lp], { encoding: 'utf8' });
    const w2 = fs.existsSync(lp); if (w2) fs.rmSync(lp);
    ck('--out through a link into public/: refused too, nothing written', lr.status === 2 && !w2);
  } else ck('--out through a link into public/ (symlinks unavailable here — checked via insidePublic)', insidePublic(path.join(ROOT, 'public', 'x.json')));
  const W = { path: path.win32, platform: 'win32', root: 'C:\\Users\\u\\repo', realpath: () => null };
  ck('Windows: "Public\\x.json" and "PUBLIC/x.json" count as public/ (letter case ignored); a file beside it does not',
    insidePublic('C:\\Users\\u\\repo\\Public\\x.json', W) && insidePublic('C:\\Users\\u\\repo\\PUBLIC/x.json', W) && !insidePublic('C:\\Users\\u\\repo\\publicity.json', W));
  const dirOut = cp.spawnSync(process.execPath, [path.join(__dirname, 'shift-trip-dates.js'), '--sample', '--days', '3', '--out', d], { encoding: 'utf8' });
  const noVal = cp.spawnSync(process.execPath, [path.join(__dirname, 'shift-trip-dates.js'), '--sample', '--days', '3', '--out'], { encoding: 'utf8' });
  ck('--out naming a folder, or with no value: refused with a plain message (exit 2)', dirOut.status === 2 && /is a folder/.test(dirOut.stderr) && noVal.status === 2 && /needs a file path/.test(noVal.stderr));
  const broken = clone(SAMPLE); delete broken.family; const bf = path.join(d, 'broken.json'), bo = path.join(d, 'broken-out.json');
  fs.writeFileSync(bf, JSON.stringify(broken));
  const br = cp.spawnSync(process.execPath, [path.join(__dirname, 'shift-trip-dates.js'), bf, '--days', '3', '--out', bo], { encoding: 'utf8' });
  ck('a trip the validator rejects: nothing written, exit 1, the errors are shown', br.status === 1 && !fs.existsSync(bo) && /nothing written/.test(br.stderr));
} finally { fs.rmSync(d, { recursive: true, force: true }); }

console.log('RESULT: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
