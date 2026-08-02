/*
 * tools/lib/validate.js — the trip-data checks themselves, shared by the CLI
 * (tools/validate-trip-data.js) and the server's import endpoint (POST /api/trip).
 *
 * Pure data-in, findings-out: no filesystem, no printing, no exit codes.
 * validateTripData(d) returns:
 *   {
 *     findings: [{type: 'ok'|'warn'|'err', msg}, …]  // in check order
 *     errors, warnings,                               // counts
 *     earlyExit,      // true when top-level keys were missing (later checks skipped)
 *     summary: { title, startDate, endDate, travelers, days, activities, planners }
 *   }
 *
 * The CLI prints findings with its ✓/⚠/✗ prefixes — its output must stay
 * byte-identical to the pre-refactor script, so DO NOT reword existing messages.
 */
'use strict';

function validateTripData(d) {
  const findings = [];
  let errors = 0, warnings = 0;
  const err  = m => { errors++;   findings.push({ type: 'err',  msg: m }); };
  const warn = m => { warnings++; findings.push({ type: 'warn', msg: m }); };
  const ok   = m => {             findings.push({ type: 'ok',   msg: m }); };

  const isStr = x => typeof x === 'string';
  const isNum = x => typeof x === 'number' && isFinite(x);
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const isLL  = x => Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1]);
  const ISO   = /^\d{4}-\d{2}-\d{2}$/;

  const result = () => ({
    findings, errors, warnings,
    earlyExit: false,
    summary: {
      title: isObj(d.trip) ? d.trip.title : undefined,
      startDate: isObj(d.trip) ? d.trip.startDate : undefined,
      endDate: isObj(d.trip) ? d.trip.endDate : undefined,
      travelers: Array.isArray(d.family) ? d.family.length : 0,
      days: Array.isArray(d.days) ? d.days.length : 0,
      activities: Array.isArray(d.days) ? d.days.reduce((n, x) => n + (Array.isArray(x && x.activities) ? x.activities.length : 0), 0) : 0,
      planners: Array.isArray(d.planners) ? d.planners.slice() : null
    }
  });

  // ── required top-level keys ────────────────────────────────────────────────
  for (const k of ['trip', 'family', 'categories', 'days', 'dayCoords', 'flights',
                   'reservationsSeed', 'essentials', 'embassies', 'enrichments']) {
    if (!(k in d)) err('Missing top-level key "' + k + '" — the app will crash or show a blank section without it');
  }
  if (errors) { const r = result(); r.earlyExit = true; return r; }
  ok('All 10 top-level keys present');

  // ── trip ───────────────────────────────────────────────────────────────────
  const t = d.trip;
  if (!isObj(t)) err('"trip" must be an object');
  else {
    for (const k of ['title', 'brand', 'subtitle']) if (!isStr(t[k]) || !t[k]) err('trip.' + k + ' must be a non-empty string (shown in the header)');
    for (const k of ['startDate', 'endDate']) if (!ISO.test(String(t[k] || ''))) err('trip.' + k + ' must be "YYYY-MM-DD" (got ' + JSON.stringify(t[k]) + ')');
    if (isStr(t.ship) && /^(none|n\/?a|no|null|[-–—]+)$/i.test(t.ship.trim()))
      warn('trip.ship is "' + t.ship + '" — the app will display a boat named "' + t.ship + '". If there is no ship or cruise, use "" (empty string) instead');
    else if (isStr(t.ship) && t.ship && !t.ship.trim())
      warn('trip.ship is whitespace-only — the app treats any non-empty string as a boat name. If there is no ship or cruise, use "" (empty string) instead');
  }

  // ── family ─────────────────────────────────────────────────────────────────
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

  // ── planners (optional top-level key, used by the import flow) ─────────────
  // No output at all when the key is absent, so pre-existing inputs print identically.
  if (d.planners !== undefined) {
    if (!Array.isArray(d.planners) || !d.planners.length || !d.planners.every(isStr))
      err('"planners" must be a non-empty array of traveler names (or leave the key out to make everyone a planner)');
    else {
      const unknown = d.planners.filter(n => !famNames.includes(n));
      if (unknown.length) err('planners lists ' + unknown.join(', ') + ' — not in family. Planner names must match family names exactly');
      else ok('planners: ' + d.planners.join(', '));
    }
  }

  // ── categories ─────────────────────────────────────────────────────────────
  if (!isObj(d.categories) || !Object.keys(d.categories).length) err('"categories" must be a non-empty object');
  else {
    for (const [k, c] of Object.entries(d.categories)) {
      if (!isObj(c) || !isStr(c.label) || !isStr(c.emoji) || !isStr(c.tw))
        warn('categories.' + k + ' should have {label, emoji, tw} — activities in it render with a gray badge');
    }
    ok('categories: ' + Object.keys(d.categories).join(', '));
  }

  // ── days + activities ──────────────────────────────────────────────────────
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

  // ── dayCoords ──────────────────────────────────────────────────────────────
  if (!isObj(d.dayCoords)) err('"dayCoords" must be an object keyed by day id');
  else {
    for (const id of dayIds) {
      const dc = d.dayCoords[id];
      if (!dc) { err(id + ' has no dayCoords entry — no weekday label, no weather chip, and "show on map" won\'t exist for that day'); continue; }
      if (!isLL(dc.ll)) err('dayCoords.' + id + '.ll must be [lat, lng] numbers');
      if (!ISO.test(String(dc.date || ''))) err('dayCoords.' + id + '.date must be "YYYY-MM-DD" — weekday labels and calendar export need it');
    }
    for (const id of Object.keys(d.dayCoords)) if (!dayIds.includes(id)) warn('dayCoords has entry "' + id + '" that matches no day id');
    if (!errors) ok('every day has a dayCoords entry');
  }

  // ── flights ────────────────────────────────────────────────────────────────
  (Array.isArray(d.flights) ? d.flights : (err('"flights" must be an array (use [] if none)'), [])).forEach((f, i) => {
    for (const k of ['id', 'flight', 'route', 'date', 'dep', 'arr']) if (!isStr(f[k])) warn('flights[' + i + '].' + k + ' should be a string');
  });

  // ── reservationsSeed ───────────────────────────────────────────────────────
  const _MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const _tripMonths = (() => {
    const ts = String((d.trip || {}).startDate || ''), te = String((d.trip || {}).endDate || '');
    if (!ISO.test(ts) || !ISO.test(te)) return null;
    const out = new Set();
    let y = +ts.slice(0, 4), m = +ts.slice(5, 7);
    const ey = +te.slice(0, 4), em = +te.slice(5, 7);
    for (let i = 0; i < 24 && (y < ey || (y === ey && m <= em)); i++) {
      out.add(m);
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  })();
  (Array.isArray(d.reservationsSeed) ? d.reservationsSeed : (err('"reservationsSeed" must be an array (use [] if none)'), [])).forEach((r, i) => {
    if (!isStr(r.title) || !r.title) err('reservationsSeed[' + i + '] needs a "title"');
    const dm = r.date && String(r.date).match(/^([A-Z][a-z]{2}) (\d{1,2})$/);
    if (r.date && !dm) warn('reservationsSeed[' + i + '].date should look like "Sep 5" — otherwise it can\'t be matched to a day');
    else if (dm && _tripMonths && _MON[dm[1]] && !_tripMonths.has(_MON[dm[1]]))
      warn('reservationsSeed[' + i + '].date "' + r.date + '" falls outside the trip\'s months (' + (d.trip.startDate || '?') + ' to ' + (d.trip.endDate || '?') + ') — it can\'t be matched to a day');
  });

  // ── essentials (the #1 crash trap) ─────────────────────────────────────────
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

  // ── embassies ──────────────────────────────────────────────────────────────
  (Array.isArray(d.embassies) ? d.embassies : (err('"embassies" must be an array (use [] if none)'), [])).forEach((e, i) => {
    if (!isObj(e)) { err('embassies[' + i + '] must be an object'); return; }
    if (!isStr(e.name)) warn('embassies[' + i + '] should have a "name"');
    if ((e.phone || e.url) && !(e.tel || e.site))
      warn('embassies[' + i + '] ("' + (e.name || '?') + '") uses "phone"/"url" — the app reads "tel", "site" and "mapsq" instead, so the phone and website buttons will be empty');
    if (!isStr(e.mapsq)) warn('embassies[' + i + '] has no "mapsq" (a Google-Maps search string) — its Map button will search for "undefined"');
  });

  // ── enrichments ────────────────────────────────────────────────────────────
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

  return result();
}

module.exports = { validateTripData };
