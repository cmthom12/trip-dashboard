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
 * The one exception is the content-bar block at the bottom: it encodes a
 * standard that changes as the trips do, and its wording moves with it. When it
 * does, update the sample output quoted in BUILD_WITH_AI.md in the same commit.
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

  // ── dietary (optional, additive; WARNINGS only) ────────────────────────────
  // IgG-style food SENSITIVITIES, not allergies — delayed, comfort-level
  // consequences, no anaphylaxis risk. Two rules follow from that and neither
  // is negotiable:
  //   1. Nothing here is ever an error. A malformed dietary block degrades to
  //      "we know less than we thought", which is survivable; refusing the
  //      whole trip import over it is not.
  //   2. NEVER warn merely because a food activity has no "dietary" key.
  //      Absent means UNKNOWN, unknown is a legitimate and common answer, and
  //      nagging for the key is precisely what would make someone guess. A
  //      guessed venue claim is the worst outcome this feature can produce.
  const DIET_TAGS = ['gluten', 'dairy', 'eggs', 'peanut', 'almond', 'oat', 'soy',
                     'shellfish', 'vegetarian', 'vegan', 'pescatarian', 'other'];
  const DIET_LEVELS = ['avoids', 'limits'];
  const DIET_SOURCES = ['menu', 'site', 'call', 'review', 'unverified'];
  const tagList = 'one of: ' + DIET_TAGS.join(', ');

  // family[i].dietary — [{tag, level, note?}]
  const checkPersonDietary = (f, label) => {
    if (f.dietary === undefined) return;
    if (!Array.isArray(f.dietary)) {
      warn(label + ': "dietary" should be an array of {tag, level, note?} — leave the key out if there is nothing to record');
      return;
    }
    f.dietary.forEach((e, i) => {
      const el = label + '.dietary[' + i + ']';
      if (!isObj(e)) { warn(el + ' should be an object {tag, level, note?}'); return; }
      if (!isStr(e.tag) || !DIET_TAGS.includes(e.tag))
        warn(el + ': "tag" should be ' + tagList + ' (got ' + JSON.stringify(e.tag) + ') — an unknown tag never matches a venue, so it shows up nowhere');
      if (!isStr(e.level) || !DIET_LEVELS.includes(e.level))
        warn(el + ': "level" is required and should be "avoids" (actively avoids it, feels better without) or "limits" (cuts back, not strict) — got ' + JSON.stringify(e.level));
      if (e.note !== undefined && !isStr(e.note)) warn(el + ': "note" should be a string (or leave it out)');
    });
  };

  // ACTIVITY.dietary / mustDos item .dietary — about the VENUE, not a person.
  const checkVenueDietary = (v, label) => {
    if (v === undefined) return;
    if (!isObj(v)) {
      warn(label + ': "dietary" should be an object {accommodates?, unsuitable?, verified?, source?, note?} — leave the key out for anything that does not serve food');
      return;
    }
    ['accommodates', 'unsuitable'].forEach(k => {
      if (v[k] === undefined) return;
      if (!Array.isArray(v[k])) { warn(label + ': dietary."' + k + '" should be an array of tags (' + tagList + ')'); return; }
      v[k].forEach(t => {
        if (!isStr(t) || !DIET_TAGS.includes(t))
          warn(label + ': dietary."' + k + '" has ' + JSON.stringify(t) + ' — should be ' + tagList);
      });
    });
    const acc = Array.isArray(v.accommodates) ? v.accommodates : [];
    const uns = Array.isArray(v.unsuitable) ? v.unsuitable : [];
    const both = acc.filter(t => uns.includes(t));
    if (both.length)
      warn(label + ': dietary lists ' + both.join(', ') + ' as BOTH accommodates and unsuitable. The app reads "unsuitable" first, so the accommodates entry is ignored — delete whichever one is wrong');
    if (v.source !== undefined && (!isStr(v.source) || !DIET_SOURCES.includes(v.source)))
      warn(label + ': dietary."source" should be one of: ' + DIET_SOURCES.join(', ') + ' (got ' + JSON.stringify(v.source) + ')');
    if (v.verified !== undefined && !ISO.test(String(v.verified)))
      warn(label + ': dietary."verified" should be a date like "2026-08-11" (got ' + JSON.stringify(v.verified) + ')');
    if (v.note !== undefined && !isStr(v.note)) warn(label + ': dietary."note" should be a one-line string (or leave it out)');
    if ((acc.length || uns.length) && v.source === undefined)
      warn(label + ': dietary makes a claim about the venue with no "source". Say where it came from (' + DIET_SOURCES.join(', ') + ') — a claim nobody can trace is one nobody should act on');
  };

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
    checkPersonDietary(f, 'family[' + i + '] ("' + (f.name || '?') + '")');
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
      checkVenueDietary(a.dietary, al);
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

  // ── packing (optional quick-start template override) ───────────────────────
  if ('packing' in d) {
    const packOk = tp => isObj(tp) && isStr(tp.label) && tp.label.trim() &&
      Array.isArray(tp.items) && tp.items.length > 0 && tp.items.every(x => isStr(x) && x.trim());
    if (Array.isArray(d.packing) && d.packing.length && d.packing.every(packOk))
      ok('packing: ' + d.packing.length + ' custom quick-start template(s) — these replace the built-in packing templates');
    else
      warn('"packing" is present but not a non-empty array of {label, items[], emoji?} templates — the app falls back to the built-in quick-start templates');
  }

  // ── mustDos (optional trip-level "Must see & do" block) ────────────────────
  // Shape: [{location, emoji?, items:[{id, name, cat, desc?, ll?, link?, note?}]}]
  // One group per stopping location. Silent when the key is absent, so trips
  // written before this feature print exactly as they always did.
  if ('mustDos' in d) {
    if (!Array.isArray(d.mustDos) || !d.mustDos.length) {
      err('"mustDos" is present but not a non-empty array — it must look like [{"location": "Rome", "items": [ … ]}]. Remove the key entirely if this trip has no must-do list');
    } else {
      const seenLoc = [], mdIds = new Set();
      let mdCount = 0, unprefixed = 0;
      d.mustDos.forEach((g, gi) => {
        const gl = 'mustDos[' + gi + '] ("' + ((g && g.location) || '?') + '")';
        if (!isObj(g)) { err(gl + ' must be an object {location, emoji?, items:[…]}'); return; }
        if (!isStr(g.location) || !g.location.trim()) err(gl + ' needs a "location" — the name of the place this group is for (one group per stopping location)');
        else { if (seenLoc.includes(g.location)) warn(gl + ': two groups share the location "' + g.location + '" — the app shows them as separate headings. Merge them into one group'); seenLoc.push(g.location); }
        if (g.emoji !== undefined && !isStr(g.emoji)) warn(gl + ': "emoji" should be a string (or leave it out)');
        if (!Array.isArray(g.items) || !g.items.length) { err(gl + ' needs a non-empty "items" array — a group with nothing in it is not shown at all'); return; }
        g.items.forEach((it, ii) => {
          const il = gl + '.items[' + ii + '] ("' + ((it && (it.id || it.name)) || '?') + '")';
          if (!isObj(it)) { err(il + ' must be an object {id, name, cat, desc?, ll?, link?, note?}'); return; }
          mdCount++;
          for (const k of ['id', 'name', 'cat']) if (!isStr(it[k]) || !it[k]) err(il + ' needs string "' + k + '"');
          if (it.id) {
            if (actIds.has(it.id)) err(il + ': id "' + it.id + '" is already an activity id — votes and day-plan rows are stored per id, so the two would share each other\'s stars. Rename it (must-do ids are usually "md_something")');
            else if (mdIds.has(it.id)) err(il + ': duplicate must-do id "' + it.id + '"');
            mdIds.add(it.id);
            if (it.id.slice(0, 3) !== 'md_') unprefixed++;
          }
          if (it.cat && d.categories && !d.categories[it.cat])
            err(il + ': cat "' + it.cat + '" is not a key of categories — it renders as a gray 📍 badge');
          checkVenueDietary(it.dietary, il);
          if (it.ll != null && !isLL(it.ll)) warn(il + ': "ll" should be [lat, lng] numbers — without it there is no map pin for this must-do');
          for (const k of ['desc', 'link', 'note']) if (it[k] !== undefined && !isStr(it[k])) warn(il + ': "' + k + '" should be a string (or leave it out)');
        });
      });
      if (unprefixed) warn('mustDos: ' + unprefixed + ' item id(s) do not start with "md_" — that is only a convention, but the prefix is what keeps must-do ids from ever colliding with activity ids');
      if (mdCount) ok('mustDos: ' + mdCount + ' must-do item(s) across ' + d.mustDos.length + ' location group(s)');
    }
  }

  // ── the content bar (WARNINGS only) ────────────────────────────────────────
  // Falling under the bar breaks nothing, so none of this is ever an error —
  // errors stay reserved for structural breakage. These are lines a family
  // pastes straight back into an AI chat, so each one names the miss AND the
  // fix, in words a non-technical reader can act on without knowing the schema.
  //
  // THE STANDARD CHANGED (2026-08-09). The old bar asked for >=10 activities a
  // day and >=3 per traveler per day. Every trip in the fleet is now built to a
  // different shape, so those lines fired on healthy trips — and a warning that
  // is simply wrong is worse than no warning, because it teaches people to stop
  // reading them. What replaced it:
  //
  //   * Too MANY options is the failure mode now, not too few. Past roughly
  //     fifty, browsing the trip becomes a chore and the good ideas get buried.
  //   * Per-day floors are GONE. Planners drag activities between days, so a
  //     light day is a plan, not a defect. Day counts are never warned on.
  //   * The "who" arrays are the signal worth checking. An even-ish split means
  //     everyone has something of their own to vote for. It is a RATIO test on
  //     purpose: anchor-tagging a low-engagement traveler with fewer, stronger
  //     options is CORRECT, and must never warn.
  //
  // On the soft cap's arithmetic: the standard is quoted as "~50 per 7 trip
  // days", but its own worked examples put a 4-day trip at 45-50 — which the
  // per-day rate alone would not allow (it would cap a 4-day trip near 29 and
  // fire on every real one). The examples win: ~50 is a whole-trip figure for
  // anything up to about a week, and only trips longer than that scale up.
  const SOFT_CAP = Math.max(50, Math.round(50 * days.length / 7));
  const OVER  = Math.round(SOFT_CAP * 1.3);   // "a meaningful margin" over
  const UNDER = Math.round(SOFT_CAP * 0.4);   // far enough under to be thin
  const MD_MIN = 6, MD_MAX = 10;              // items in one must-do group
  const STARVED = 0.45;                       // share of an even split
  // "A", "A and B", "A, B and C" — five names joined by " and " is unreadable,
  // and these lines get pasted into a chat window as-is.
  const listOf = xs => xs.length < 2 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  let barMisses = 0;

  // ── how much is there, trip-wide ──────────────────────────────────────────
  const totalActs = days.reduce((n, day) => n + (Array.isArray(day.activities) ? day.activities.length : 0), 0);
  const actWord = n => n + ' ' + (n === 1 ? 'activity' : 'activities');
  const spread = ' across ' + days.length + ' ' + (days.length === 1 ? 'day' : 'days');
  if (days.length && totalActs > OVER) {
    barMisses++;
    warn('This trip has ' + actWord(totalActs) + spread + ' — aim for around ' + SOFT_CAP + '. ' +
      'Past roughly that many the app stops being a shortlist and becomes a chore to scroll, and the ' +
      'best ideas get buried among the merely fine ones. Ask your AI to CUT the weakest options rather ' +
      'than spread them over more days — keep what someone would actually be disappointed to miss.');
  } else if (days.length && totalActs < UNDER) {
    barMisses++;
    warn('This trip has only ' + actWord(totalActs) + spread + ' — aim for around ' + SOFT_CAP + '. ' +
      'There is not enough here for the family to have a real choice to vote on. Ask your AI for more ' +
      'options, spread across the different things the different people enjoy.');
  }

  // ── is anyone left out ────────────────────────────────────────────────────
  // Counted through the "who" arrays: ONE activity serves everyone listed in
  // it, so these are TAGS, not activities-per-person. Each traveler is compared
  // to the even share, never to a fixed number — a traveler who votes on less
  // and gets fewer, better-aimed options should sail through this.
  const tagged = {};
  famNames.forEach(n => { tagged[n] = 0; });
  days.forEach(day => (Array.isArray(day.activities) ? day.activities : []).forEach(a => {
    if (a && Array.isArray(a.who)) a.who.forEach(n => { if (n in tagged) tagged[n] += 1; });
  }));
  const totalTags = famNames.reduce((n, x) => n + tagged[x], 0);
  const evenShare = famNames.length ? totalTags / famNames.length : 0;
  // Below ~4 apiece there is nothing to be uneven about, and the ratio gets
  // jumpy: the "far under" warning above is the honest complaint at that size.
  if (famNames.length > 1 && evenShare >= 4) {
    const starved = famNames.filter(n => tagged[n] < evenShare * STARVED);
    if (starved.length) {
      barMisses++;
      warn(listOf(starved.map(n => n + ' (' + tagged[n] + ')')) +
        ' ' + (starved.length === 1 ? 'has' : 'have') +
        ' far fewer activities tagged for them than the rest of the family, which averages ' +
        Math.round(evenShare) + ' each. An activity counts for everyone listed in its "who", so ask your ' +
        'AI to add options that genuinely suit ' + listOf(starved) + ' — not to paste ' +
        (starved.length === 1 ? 'that name' : 'those names') + ' onto activities they would not enjoy. ' +
        'Fewer but stronger options for someone who votes on less is fine; this line only fires when ' +
        'someone is far below everyone else.');
    }
  }

  // ── the Must see & do list ────────────────────────────────────────────────
  if (!('mustDos' in d)) {
    barMisses++;
    warn('This trip has no "Must see & do" list (the "mustDos" block) — that is the trip-wide list of ' +
      'landmarks and experiences everyone can star, separate from the day-by-day plans. Ask your AI to add ' +
      'one group per place you stop in, with ' + MD_MIN + '-' + MD_MAX + ' items in each.');
  } else if (Array.isArray(d.mustDos)) {
    // Day locations are what the app groups must-dos under, so a group whose
    // location does not match one EXACTLY renders as an orphan heading. The
    // structural block above checks shape and duplicate locations; it does not
    // check this, so it is not a duplicate of anything.
    const dayLocs = [...new Set(days.map(day => (isStr(day.location) ? day.location : '')).filter(Boolean))];
    d.mustDos.forEach((g, gi) => {
      if (!isObj(g)) return;
      const gl = 'mustDos[' + gi + '] ("' + ((g && g.location) || '?') + '")';
      // n === 0 is already an error from the structural block — don't pile on.
      const n = Array.isArray(g.items) ? g.items.length : 0;
      if (n && (n < MD_MIN || n > MD_MAX)) {
        barMisses++;
        warn(gl + ' has ' + n + ' item' + (n === 1 ? '' : 's') + ' — a group reads best with ' +
          MD_MIN + '-' + MD_MAX + '. ' + (n < MD_MIN
            ? 'Ask your AI for the rest of what that place genuinely earns.'
            : 'Ask your AI to cut it back to the ones that place is actually known for.'));
      }
      if (isStr(g.location) && g.location && dayLocs.length && !dayLocs.includes(g.location)) {
        barMisses++;
        warn(gl + ': no day has that exact "location". The app files must-dos under the day location ' +
          'text, so this group never appears beside the days it belongs to. The day locations are ' +
          listOf(dayLocs.map(s => '"' + s + '"')) + ' — correct the spelling on whichever side is wrong.');
      }
    });
  }

  if (!barMisses && days.length) ok('content: ' + actWord(totalActs) + spread + ' (soft cap around ' +
    SOFT_CAP + '), no traveler left short, and a Must see & do list');

  return result();
}

module.exports = { validateTripData };
