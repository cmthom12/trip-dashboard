#!/usr/bin/env node
/*
 * profile-export.js — rebuild traveler preference profiles from a retired trip.
 *
 * When a trip instance is retired, its votes are the only durable record of what
 * each traveler actually liked. This reads that record and prints one profile
 * block per traveler, ready to paste into the prompt that plans the next trip.
 *
 * Only dependency is better-sqlite3 (already a dependency of the app).
 *
 * Usage:
 *   node tools/profile-export.js --db data.db
 *   node tools/profile-export.js --db data.db --trip my-trip.json --out ~/profiles.txt
 *
 * Since v0.6 the authoritative trip lives IN the database (trip_config), so the
 * default is to read it from there. --trip overrides it with a trip-data JSON
 * file or a public/index.html to pull the trip-data block out of (same loading
 * rule as tools/validate-trip-data.js) — needed for pre-v0.6 databases, useful
 * for what-if runs. A --trip that differs from the stored trip is warned about:
 * a stale file otherwise degrades quietly into '(unmatched id: …)' lines.
 * The database is opened read-only; nothing here ever writes to it.
 *
 * Star rule: interests entries are "Name|stars" strings (see intParse in
 * public/index.html). A bare name with no "|stars" suffix — or one whose suffix
 * isn't 1-3 — counts as 1 star here; the app's own parser defaults those to 2,
 * but for profile weighting an untagged vote is the weakest signal, not a
 * middling one. The name is resolved exactly as intParse resolves it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const fail = m => { console.error('✗ ' + m); process.exit(1); };

// ── arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let dbPath = null, tripPath = null, outPath = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => { const v = args[++i]; if (!v) fail(a + ' needs a value.'); return v; };
  if (a === '--db') dbPath = val();
  else if (a.startsWith('--db=')) dbPath = a.slice(5);
  else if (a === '--trip') tripPath = val();
  else if (a.startsWith('--trip=')) tripPath = a.slice(7);
  else if (a === '--out') outPath = val();
  else if (a.startsWith('--out=')) outPath = a.slice(6);
  else fail('Unknown option "' + a + '". Options are --db, --trip, --out.');
}
if (!dbPath) {
  console.log('Usage: node tools/profile-export.js --db <data.db> [--trip <trip.json>] [--out <file>]');
  console.log('  --db     the retired trip\'s SQLite database (opened read-only)');
  console.log('  --trip   OPTIONAL override: trip-data JSON, or a public/index.html holding the');
  console.log('           trip-data block. Default is the trip stored in the database (trip_config).');
  console.log('  --out    write to this file instead of stdout');
  process.exit(1);
}

// Profiles quote real traveler names and preferences; the repo is a public
// template, so an --out inside it is almost certainly a mistake.
if (outPath && !path.relative(ROOT, path.resolve(outPath)).startsWith('..')) {
  console.error('⚠ --out points inside the repo working tree. Profile output should never be');
  console.error('  committed — write it somewhere outside the repo instead.');
}

// ── open the database (read-only; also the default trip source) ──────────────
let db;
try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
catch (e) { fail('Cannot open ' + dbPath + ': ' + e.message); }

// ── load the trip ────────────────────────────────────────────────────────────
// Default: the trip stored in the database — same row activeTrip() serves in
// server.js. Absent table = pre-v0.6 database (only --trip can help there).
function storedTripRow() {
  try { return db.prepare('SELECT json, version FROM trip_config ORDER BY version DESC, id DESC LIMIT 1').get() || null; }
  catch (e) { return null; }
}
let trip;
if (tripPath) {
  let raw;
  try { raw = fs.readFileSync(tripPath, 'utf8'); }
  catch (e) { fail('Cannot read ' + tripPath + ': ' + e.message); }
  const TAG = '<script type="application/json" id="trip-data">';
  if (raw.includes(TAG)) {
    const i = raw.indexOf(TAG) + TAG.length;
    raw = raw.slice(i, raw.indexOf('</' + 'script>', i));
  }
  try { trip = JSON.parse(raw); }
  catch (e) { fail('Not valid JSON: ' + e.message); }
  const stored = storedTripRow();
  if (stored && stored.json !== JSON.stringify(trip)) {
    console.error('⚠ --trip differs from the trip stored in the database (trip_config v' + stored.version + ').');
    console.error('  A stale file quietly turns activities into "(unmatched id: …)" lines —');
    console.error('  omit --trip to use the database copy.');
  }
} else {
  const stored = storedTripRow();
  if (!stored) fail('No trip_config in ' + dbPath + ' (pre-v0.6 database?) — pass --trip <trip.json or index.html>.');
  try { trip = JSON.parse(stored.json); }
  catch (e) { fail('The trip stored in the database is not valid JSON: ' + e.message); }
  console.error('Using the trip stored in the database (trip_config v' + stored.version + ').');
}

const family = Array.isArray(trip.family) ? trip.family : [];
if (!family.length) fail('No family[] in the trip data — nothing to build profiles for.');

// activity id -> { title, category }; category falls back to the raw cat key
// when the trip has no categories entry for it.
const catLabel = k => {
  const c = trip.categories && trip.categories[k];
  return (c && c.label) || k || 'Uncategorized';
};
const ACTS = {};
(trip.days || []).forEach(d => (d.activities || []).forEach(a => {
  if (!a || !a.id) return;
  ACTS[a.id] = { title: a.name || a.title || a.id, category: catLabel(a.cat), tags: a.tags || [] };
}));

// ── read the votes ───────────────────────────────────────────────────────────
// Mirrors intParse in public/index.html, except bare entries score 1 (see header).
function parseVote(entry) {
  const s = String(entry);
  const i = s.lastIndexOf('|');
  if (i < 0) return { name: s, stars: 1 };
  const st = parseInt(s.slice(i + 1), 10);
  // A junk suffix ("Sam|9") must still resolve to Sam — keeping the raw string
  // would invent a traveler and strand their votes outside every profile.
  return st >= 1 && st <= 3 ? { name: s.slice(0, i), stars: st } : { name: s.slice(0, i) || s, stars: 1 };
}

// votes[name] = [{ activityId, title, category, stars, tags }]
const votes = {};
family.forEach(f => { votes[f.name] = []; });
const activityVoters = {};   // activityId -> Set(name)
const activityStars = {};    // activityId -> total stars
const titleOf = id => (ACTS[id] ? ACTS[id].title : '(unmatched id: ' + id + ')');

db.prepare('SELECT activity_id, names FROM interests').all().forEach(r => {
  let list;
  try { list = JSON.parse(r.names || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  list.forEach(entry => {
    const v = parseVote(entry);
    const act = ACTS[r.activity_id];
    const vote = {
      activityId: r.activity_id,
      title: titleOf(r.activity_id),
      category: act ? act.category : 'Uncategorized',
      tags: act ? act.tags : [],
      stars: v.stars
    };
    if (!votes[v.name]) votes[v.name] = [];   // voter no longer in family[]
    votes[v.name].push(vote);
    (activityVoters[r.activity_id] = activityVoters[r.activity_id] || new Set()).add(v.name);
    activityStars[r.activity_id] = (activityStars[r.activity_id] || 0) + v.stars;
  });
});

// Renamed/removed travelers still have votes in the table but get no block below.
const strays = Object.keys(votes).filter(n => !family.some(f => f.name === n) && votes[n].length);
if (strays.length) {
  console.error('⚠ Votes from names not in family[]: ' + strays.join(', ') +
    ' — counted in the family-level notes, but they get no profile block.');
}

let suggestions = [];
try { suggestions = db.prepare('SELECT author, label, url FROM suggestions').all(); }
catch (e) { suggestions = []; }   // table absent on very old databases

// Post-trip retro tables (absent on pre-retro databases — that's fine, and the
// output must then stay byte-identical to what this tool printed before them).
let reviews = [], reviewAdds = [], schedRows = [];
try { reviews = db.prepare('SELECT * FROM reviews').all(); } catch (e) { reviews = []; }
try { reviewAdds = db.prepare('SELECT * FROM review_additions').all(); } catch (e) { reviewAdds = []; }
// Deliberately NOT filtered by moved_to: schedRows only feeds the title map below,
// and reviews saved before an item was moved still carry the old 'sched:<id>' key —
// dropping tombstones would print "(unmatched id)" for those.
try { schedRows = db.prepare('SELECT id, activity_id, title FROM day_schedule').all(); } catch (e) { schedRows = []; }
db.close();

// Custom/booking plan rows carry no trip-data id; the review API keys them as
// 'sched:<row id>' — resolve their titles from the schedule itself.
const schedTitle = {};
schedRows.forEach(r => { schedTitle[(r.activity_id && String(r.activity_id)) || ('sched:' + r.id)] = r.title; });
const retroTitle = id => (ACTS[id] ? ACTS[id].title : (schedTitle[id] || '(unmatched id: ' + id + ')'));
const retroCat = id => (ACTS[id] ? ACTS[id].category : 'Uncategorized');
const RATING_WORD = { 3: 'loved', 2: 'good', 1: 'meh', '-1': 'disliked' };
const REASON_PHRASE = {
  service: 'poor service', crowds: 'crowds', weather: 'weather', timing: 'timing',
  logistics: 'logistics', mood: 'off day (personal)', cost: 'not worth the price'
};
// 'other' reasons carry their free-text note; everything else shows the code phrase.
const reasonText = r => (r.reason_code === 'other'
  ? (r.reason_note || 'other')
  : (REASON_PHRASE[r.reason_code] || r.reason_code) + (r.reason_note ? ' (' + r.reason_note + ')' : ''));

// ── render ───────────────────────────────────────────────────────────────────
const RULE = '='.repeat(80);
const LOW_ENGAGEMENT = 3;   // fewer votes than this and the traveler can't anchor a plan
const out = [];
const say = line => out.push(line);

// Collapse repeated titles into "Title (x2)", keeping first-seen order.
function collapse(titles) {
  const seen = new Map();
  titles.forEach(t => seen.set(t, (seen.get(t) || 0) + 1));
  return [...seen].map(([t, n]) => (n > 1 ? t + ' (x' + n + ')' : t));
}

function weightsOf(list) {
  const w = {};
  list.forEach(v => { w[v.category] = (w[v.category] || 0) + v.stars; });
  return Object.entries(w).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Actual (post-trip) category weights. CORE RULE: a low rating whose reason is
// circumstantial (weather, service, mood, …) must NOT down-weight the category —
// only reason_code 'activity' is evidence against the activity TYPE. Ratings of
// 2/3 always count; 1/-1 count only with reason 'activity'. Self-added items
// count when they carry a category (they were attended by definition).
function actualWeightsOf(revs, adds) {
  const w = {};
  revs.forEach(r => {
    if (r.rating >= 2 || r.reason_code === 'activity') {
      const c = retroCat(r.activity_id);
      w[c] = (w[c] || 0) + r.rating;
    }
  });
  adds.forEach(a => {
    if (!a.category) return;
    if (a.rating >= 2 || a.reason_code === 'activity') {
      const c = catLabel(a.category);
      w[c] = (w[c] || 0) + a.rating;
    }
  });
  return Object.entries(w).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

family.forEach(f => {
  const mine = votes[f.name] || [];
  const weights = weightsOf(mine);
  const must = mine.filter(v => v.stars === 3);
  const strong = mine.filter(v => v.stars === 2);
  const declared = (f.interests || []).join(', ') || '(none declared)';
  const myRev = reviews.filter(r => r.name === f.name && r.attended === 1 && r.rating !== null);
  const myAdds = reviewAdds.filter(a => a.name === f.name);
  const aWeights = actualWeightsOf(myRev, myAdds);

  say(RULE);
  say(f.name.toUpperCase());
  say(RULE);
  say('PROMPT LINE (copy-paste):');
  // Unmatched ids still count in the weights, but "Uncategorized" is no use in a prompt.
  const top = weights.filter(([c]) => c !== 'Uncategorized').slice(0, 3).map(([c]) => c);
  // Where post-trip ratings exist, ACTUAL outranks predicted in the prompt line.
  const topActual = aWeights.filter(([c, n]) => c !== 'Uncategorized' && n > 0).slice(0, 3).map(([c]) => c);
  const lead = topActual.length ? topActual.join(', ')
    : (top.length ? top.join(', ') : 'no votes recorded');
  const tail = mine.length < LOW_ENGAGEMENT ? '; plan around anchor events' : '';
  say(f.name + ' — ' + lead + tail + '.');
  say('');
  say('DECLARED (family JSON):');
  say(declared);
  say('');
  // Dietary is COPIED, verbatim, from family[].dietary — never inferred, never
  // derived from voting behavior (somebody skipping the pasta bar is not
  // evidence of anything). This is the piece that makes a restriction survive
  // into every future trip build instead of being rediscovered each time.
  // Absent key = no section at all, so pre-dietary trips print byte-identically.
  const diet = Array.isArray(f.dietary) ? f.dietary.filter(e => e && e.tag) : [];
  if (diet.length) {
    say('DIETARY (copied from the trip data — carry this into the next trip verbatim):');
    diet.forEach(e => say('- ' + e.tag + ' — ' + (e.level || 'level not stated') +
      (e.note ? ' (' + e.note + ')' : '')));
    say('These are food sensitivities, not allergies: they annotate options, never rule them out.');
    say('');
  }
  say('VOTED — ' + mine.length + ' votes; ' + must.length + ' must-do (3-star), ' +
      strong.length + ' strong (2-star)');
  say('Category weights: ' +
      (weights.length ? weights.map(([c, n]) => c + ' ' + n).join(' · ') : '(none)'));
  say('(weight = sum of stars per category, all votes counted)');
  say('');
  say('Must-do (3-star):');
  const mustTitles = collapse(must.map(v => v.title));
  (mustTitles.length ? mustTitles : ['(none)']).forEach(t => say('- ' + t));
  say('');
  say('Strong (2-star):');
  const strongTitles = collapse(strong.map(v => v.title));
  (strongTitles.length ? strongTitles : ['(none)']).forEach(t => say('- ' + t));
  say('');
  // Post-trip retro, only for travelers who reviewed or self-added something.
  // Not-attended items never appear here — they carry no preference signal.
  if (myRev.length || myAdds.length) {
    const preOf = id => { const v = mine.find(x => x.activityId === id); return v ? v.stars : null; };
    const cnt = r => myRev.filter(x => x.rating === r).length;
    say('ACTUAL (post-trip) — ' + myRev.length + ' rated; ' + cnt(3) + ' loved, ' +
        cnt(2) + ' good, ' + cnt(1) + ' meh, ' + cnt(-1) + ' disliked');
    say('Category weights (actual): ' +
        (aWeights.length ? aWeights.map(([c, n]) => c + ' ' + n).join(' · ') : '(none)'));
    say('(weight = sum of ratings; meh/disliked count only when the reason is the activity itself)');
    say('');
    say('Loved:');
    const loved = collapse(myRev.filter(r => r.rating === 3).map(r => retroTitle(r.activity_id)));
    (loved.length ? loved : ['(none)']).forEach(t => say('- ' + t));
    say('');
    say('Disliked (activity itself):');
    const dAct = myRev.filter(r => r.rating === -1 && r.reason_code === 'activity')
      .map(r => retroTitle(r.activity_id));
    (dAct.length ? dAct : ['(none)']).forEach(t => say('- ' + t));
    say('');
    say('Disliked for circumstance (not the activity):');
    const dCirc = myRev.filter(r => r.rating === -1 && r.reason_code && r.reason_code !== 'activity')
      .map(r => retroTitle(r.activity_id) + ' — ' + reasonText(r));
    (dCirc.length ? dCirc : ['(none)']).forEach(t => say('- ' + t));
    say('');
    say('Worth retrying (downgraded for circumstance):');
    const retry = myRev.filter(r => r.rating >= 1 && preOf(r.activity_id) !== null &&
        r.rating < preOf(r.activity_id) && r.reason_code && r.reason_code !== 'activity')
      .map(r => retroTitle(r.activity_id) + ' — ' + reasonText(r));
    (retry.length ? retry : ['(none)']).forEach(t => say('- ' + t));
    say('');
    say('Self-added (did it anyway, unplanned):');
    (myAdds.length ? myAdds.map(a => a.title + ' (' + (RATING_WORD[a.rating] || a.rating) + ')') : ['(none)'])
      .forEach(t => say('- ' + t));
    say('');
    const over = myRev.filter(r => preOf(r.activity_id) === 3 && r.rating <= 1 && r.reason_code === 'activity')
      .map(r => retroTitle(r.activity_id));
    const under = myRev.filter(r => { const p = preOf(r.activity_id); return (p === null || p <= 1) && r.rating === 3; })
      .map(r => retroTitle(r.activity_id));
    say('Predicted vs actual:');
    say('- Overrated (voted 3, the activity itself missed): ' + (over.length ? over.join(', ') : '(none)'));
    say('- Underrated (little or no pre-trip interest, loved it): ' + (under.length ? under.join(', ') : '(none)'));
    say('');
  }
  const authored = suggestions.filter(s => s.author === f.name);
  if (authored.length) {
    say('Suggestions authored:');
    authored.forEach(s => say('- ' + (s.label || '(untitled)') + (s.url ? ' — ' + s.url : '')));
    say('');
  }
  say('Pattern (inferred from votes):');
  say('- [MANUAL: fill in after review — script emits this placeholder only]');
  say('');
});

// ── family-level notes ───────────────────────────────────────────────────────
say(RULE);
say('FAMILY-LEVEL NOTES (auto-computed)');
say(RULE);
say('');

const names = family.map(f => f.name);
const unanimous = Object.keys(activityVoters)
  .filter(id => names.length && names.every(n => activityVoters[id].has(n)))
  .map(titleOf)
  .sort();
say('Unanimous tags (activities every traveler voted on):');
(unanimous.length ? unanimous : ['(none)']).forEach(t => say('- ' + t));
say('');

const consensus = Object.entries(activityStars)
  .sort((a, b) => b[1] - a[1] || titleOf(a[0]).localeCompare(titleOf(b[0])))
  .slice(0, 10);
say('Top consensus activities by total stars (top 10):');
(consensus.length
  ? consensus.map(([id, n]) => titleOf(id) + ' — ' + n + ' star' + (n === 1 ? '' : 's'))
  : ['(none)'])
  .forEach(t => say('- ' + t));
say('');

// An interest counts as alive if a voted-on category label or activity tag
// matches it (either direction, so "food" matches "Food & Wine").
const norm = s => String(s).toLowerCase().trim();
const votedTerms = new Set();
// Empty terms are dropped: "".includes() matches every interest, which would
// silently empty the dead list — the opposite of what it reports.
Object.values(votes).flat().forEach(v => {
  if (norm(v.category)) votedTerms.add(norm(v.category));
  (v.tags || []).forEach(t => { if (norm(t)) votedTerms.add(norm(t)); });
});
const declaredAll = [...new Set(family.flatMap(f => f.interests || []))];
const dead = declaredAll.filter(int => {
  const n = norm(int);
  return ![...votedTerms].some(t => t.includes(n) || n.includes(t));
}).sort();
say('Declared-but-dead interests (declared by anyone, zero votes family-wide):');
(dead.length ? dead : ['(none)']).forEach(t => say('- ' + t));

// Post-trip retro at family level. Every section is labeled with the responder
// count so partial participation (say 3 of 5 reviewed) can't read as consensus.
const responders = names.filter(n => reviews.some(r => r.name === n) || reviewAdds.some(a => a.name === n));
if (responders.length) {
  say('');
  say('Post-trip reviews — ' + responders.length + ' of ' + names.length + ' travelers responded (' +
      responders.join(', ') + '):');
  const lovedBy = {};
  reviews.forEach(r => {
    if (r.attended === 1 && r.rating === 3 && names.includes(r.name)) {
      (lovedBy[r.activity_id] = lovedBy[r.activity_id] || []).push(r.name);
    }
  });
  const lovedList = Object.entries(lovedBy)
    .sort((a, b) => b[1].length - a[1].length || retroTitle(a[0]).localeCompare(retroTitle(b[0])))
    .map(([id, who]) => retroTitle(id) + ' — loved by ' + who.join(', '));
  say('Actually loved (rated "loved" post-trip):');
  (lovedList.length ? lovedList : ['(none)']).forEach(t => say('- ' + t));
  say('Missed for circumstance, worth retrying under better conditions:');
  const retryAll = reviews
    .filter(r => names.includes(r.name) && r.attended === 1 && (r.rating === -1 || r.rating === 1) &&
        r.reason_code && r.reason_code !== 'activity')
    .map(r => retroTitle(r.activity_id) + ' — ' + reasonText(r) + ' (' + r.name + ')');
  (retryAll.length ? retryAll : ['(none)']).forEach(t => say('- ' + t));
}

const text = out.join('\n') + '\n';
if (outPath) {
  fs.writeFileSync(outPath, text);
  console.error('Wrote ' + outPath);
} else {
  process.stdout.write(text);
}
