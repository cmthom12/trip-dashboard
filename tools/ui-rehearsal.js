#!/usr/bin/env node
/*
 * ui-rehearsal.js — v0.25 screen checks, against the real app script.
 *
 * Loads public/index.html's app script through the render harness (fake
 * React: components return element trees) and checks what each new screen
 * SHOWS and what its controls DO:
 *   tabs : on a phone the bar holds the main tabs + "More"; the rest open
 *          from More as a menu; the current hidden tab shows on the More
 *          button; a wide screen shows every tab; every tab has a screen.
 *   now  : during the trip the app opens on "Now": today's day, the next
 *          timed Day Plan item with ONE directions link, today's plan in
 *          time order (past items struck through), the family's favorites
 *          when there is no plan yet; a countdown before, "welcome home"
 *          after. Checked at fixed moments of the sample trip.
 *   fav  : Decide offers planners one button per day to put that day's
 *          favorite (most stars, then most voters) on its Day Plan, skipping
 *          what is already planned; it asks first and sends the same entry
 *          the Day Plan form would.
 *   pack : a per-person packing row shows YOUR check and who has packed it;
 *          a shared row has one check; rows are checkboxes for screen
 *          readers and keyboards; groups follow the trip's own travelers.
 *   chips: a day chip shows the whole day label ("Sat Sep 5" keeps 5).
 *   portal: when the family portal's hand-off fails, the sign-in screen says
 *          why (expired, or not on this trip) — and nothing for a visitor.
 *   a11y : every button on every tab has a name a screen reader can read
 *          (no bare ☆ ▼ ×); no low-contrast gray text; a visible focus ring;
 *          a "Skip to the trip" link.
 *
 * Usage: node tools/ui-rehearsal.js [repo-root]    Exit 0 = every check passed.
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const argv = process.argv;
process.argv = [argv[0], path.join(__dirname, 'render-harness.js'), process.env.UI_TRIP || '--', ROOT];
const H = require('./render-harness.js');
process.argv = argv;
const { sandbox, X, React, text } = H;
const fs = require('fs');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (label, ok) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label); };
const all = (node, pred, out) => { // every element in the tree matching pred
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => all(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  (node.children || []).forEach(k => all(k, pred, out));
  return out;
};
const buttons = node => all(node, n => n.type === 'button');
const labelOf = n => text(n).replace(/\s+/g, ' ').trim();
const word = l => String(l).slice(String(l).indexOf(' ') + 1); // "🗺 Itinerary" → "Itinerary"
const shows = (node, label) => text(node).includes(word(label));

function tabChecks() {
  console.log('==> tabs');
  if (typeof X.TabBar !== 'function' || !Array.isArray(X.TAB_LIST)) { ck('TabBar and TAB_LIST exist', false); return; }
  const tabs = X.TAB_LIST;
  const primary = tabs.filter(t => X.PRIMARY_TABS.indexOf(t.id) >= 0);
  const rest = tabs.filter(t => X.PRIMARY_TABS.indexOf(t.id) < 0);
  ck('a phone keeps at most 4 main tabs in the bar (' + primary.length + ') and puts ' + rest.length + ' under More', primary.length >= 3 && primary.length <= 4 && rest.length >= 5);
  const picks = [];
  const bar = X.TabBar({ tabs, tab: 'itinerary', onPick: id => picks.push(id), wide: false, moreOpen: false, setMoreOpen() {} });
  const bl = buttons(bar).map(labelOf);
  ck('phone bar shows the main tabs and a "More" button, and nothing else',
    bl.length === primary.length + 1 && primary.every(t => buttons(bar).some(b => shows(b, t.label))) && bl.some(l => /More/.test(l)));
  ck('…the other tabs are not in the bar until More is opened', rest.every(t => !shows(bar, t.label)) && all(bar, n => n.props.id === 'more-tabs').length === 0);
  const stacked = buttons(bar).filter(b => all(b, n => n.props['aria-hidden'] === 'true').length === 1);
  ck('on a phone each tab shows its icon above its name (fits a 360px screen), the icon hidden from screen readers', stacked.length === bl.length);
  let opened = null;
  const closed = X.TabBar({ tabs, tab: 'itinerary', onPick() {}, wide: false, moreOpen: false, setMoreOpen: v => { opened = v; } });
  const moreBtn = buttons(closed).find(b => /More/.test(labelOf(b)));
  if (moreBtn) moreBtn.props.onClick();
  ck('tapping More asks to open the list, and says so to screen readers (aria-expanded, aria-controls)',
    opened === true && moreBtn.props['aria-controls'] === 'more-tabs' && moreBtn.props['aria-expanded'] === 'false' && !('aria-haspopup' in moreBtn.props));
  const open = X.TabBar({ tabs, tab: 'itinerary', onPick: id => picks.push(id), wide: false, moreOpen: true, setMoreOpen() {} });
  const menu = all(open, n => n.props.id === 'more-tabs')[0];
  const items = menu ? buttons(menu) : [];
  ck('the open list shows every other tab as a plain button (no menu role it cannot keep)', items.length === rest.length && rest.every(t => items.some(i => labelOf(i) === t.label)) && all(open, n => n.props.role === 'menu' || n.props.role === 'menuitem').length === 0);
  ck('…tabbing out of the list closes it', !!menu && typeof menu.props.onBlur === 'function');
  const notes = items.find(i => /Notes/.test(labelOf(i)));
  if (notes) notes.props.onClick();
  ck('…and picking one switches to that tab', picks[picks.length - 1] === 'notes');
  const onPacking = X.TabBar({ tabs, tab: 'packing', onPick() {}, wide: false, moreOpen: false, setMoreOpen() {} });
  const mb = buttons(onPacking).find(b => b.props['aria-controls'] === 'more-tabs');
  ck('while on a tab under More, the More button shows that tab and is marked current', !!mb && /Packing/.test(labelOf(mb)) && mb.props['aria-current'] === 'page');
  const onMap = X.TabBar({ tabs, tab: 'map', onPick() {}, wide: false, moreOpen: false, setMoreOpen() {} });
  const cur = buttons(onMap).filter(b => b.props['aria-current'] === 'page').map(labelOf);
  ck('the current main tab is marked for screen readers (aria-current)', cur.length === 1 && /Map/.test(cur[0]));
  const wide = X.TabBar({ tabs, tab: 'itinerary', onPick() {}, wide: true, moreOpen: false, setMoreOpen() {} });
  const wl = buttons(wide).map(labelOf);
  const arrows = all(onPacking, n => typeof n.type === 'string').filter(n => (n.children || []).some(k => typeof k === 'string' && k.includes('\u25BE')));
  ck('the ▾ on More is hidden from screen readers (it would be read as "down-pointing triangle")', arrows.length > 0 && arrows.every(n => n.props['aria-hidden'] === 'true'));
  ck('a wide screen shows every tab inline and no More', wl.length === tabs.length && tabs.every(t => wl.includes(t.label)) && !wl.some(l => /More/.test(l)));
  const small = buttons(bar).filter(b => (parseFloat(b.props.style && b.props.style.fontSize) || 0) < 13);
  ck('tab labels are at least 13px (were 12px)', small.length === 0);
  const main = (() => { const T = '<script type="text/plain" id="trip-main">'; const i = HTML.indexOf(T) + T.length; return HTML.slice(i, HTML.indexOf('</' + 'script>', i)); })();
  const missing = tabs.map(t => t.id).filter(id => main.indexOf('tab === "' + id + '"') < 0);
  ck('every tab in the list has a screen' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''), missing.length === 0);
  React.__forceOpen = true;
  let app = null;
  try { app = X.App(); } catch (e) { app = null; }
  React.__forceOpen = false;
  const tb = app ? all(app, n => n.type === X.TabBar)[0] : null;
  ck('the app uses TabBar with the phone layout by default (no wide screen) and every tab', !!tb && tb.props.wide === false && tabs.every(t => tb.props.tabs.some(x => x.id === t.id)));
}

function nowChecks() {
  console.log('==> now');
  const need = ['NowHome', 'tripPhase', 'initialTab', 'directionsUrl'];
  const miss = need.filter(n => typeof X[n] !== 'function');
  if (miss.length) { ck('Now screen helpers exist (' + miss.join(', ') + ' missing)', false); return; }
  ck('"Now" is the first tab and a main (phone) tab', X.TAB_LIST[0].id === 'now' && X.PRIMARY_TABS.indexOf('now') >= 0);
  // The sample trip: 2026-09-05..08, day2 = 2026-09-06, times in America/New_York (UTC-4).
  const at = (d, h, m) => Date.UTC(2026, 8, d, h + 4, m || 0);
  const sched = [
    { id: 1, day_id: 'day2', activity_id: 'd2_museum', title: 'City Museum', time_text: '09:00' },
    { id: 2, day_id: 'day2', activity_id: 'd2_lunch', title: 'Market Lunch', time_text: '13:00' },
    { id: 3, day_id: 'day2', activity_id: '', title: 'Gelato walk', time_text: '' },
    { id: 4, day_id: 'day3', activity_id: 'd3_x', title: 'Not today', time_text: '10:00' }
  ];
  ck('trip phase: before / during / after', X.tripPhase(at(1, 12)) === 'before' && X.tripPhase(at(6, 12)) === 'during' && X.tripPhase(at(20, 12)) === 'after');
  const valid = X.TAB_LIST.map(t => t.id);
  ck('during the trip the app opens on Now, even if the last tab was Map', X.initialTab('map', at(6, 12), valid) === 'now');
  ck('…before or after the trip it opens on the last tab (or Itinerary if that is unknown)',
    X.initialTab('map', at(1, 12), valid) === 'map' && X.initialTab('nonsense', at(20, 12), valid) === 'itinerary' && X.initialTab(null, at(1, 12), valid) === 'itinerary');
  let opened = null, tabbed = null;
  const props = (ms, schedule, interests) => ({ schedule, reservations: [], interests: interests || {}, nowMs: ms, onOpenDay: id => { opened = id; }, onTab: id => { tabbed = id; } });
  const mid = X.NowHome(props(at(6, 11, 30), sched));
  const t1 = text(mid);
  ck('the header says which day of the trip it is (DAY 2 OF 4)', t1.includes('DAY 2 OF 4'));
  ck('11:30 on day 2: shows today (Day 2 — Old City) and "Next up" = 1:00 PM · Market Lunch', t1.includes('Day 2') && t1.includes('Old City') && /Next up/.test(t1) && t1.includes('1:00 PM') && t1.indexOf('Market Lunch') >= 0 && !t1.includes('Not today'));
  const links = all(mid, n => n.type === 'a' && /google\.com\/maps\/dir/.test(n.props.href || ''));
  ck('…exactly one directions link, to the lunch spot\'s coordinates', links.length === 1 && links[0].props.href.endsWith('destination=41.8986,12.4768') && links[0].props.rel === 'noopener');
  const lis = all(mid, n => n.type === 'li').map(n => text(n));
  ck("…today's plan lists 9:00 AM, 1:00 PM, then the untimed item", lis.length === 3 && /9:00 AM/.test(lis[0]) && /1:00 PM/.test(lis[1]) && /Any time/.test(lis[2]));
  const past = all(mid, n => n.type === 'li')[0];
  ck('…the 9:00 AM item that already happened is struck through', JSON.stringify(past).includes('line-through'));
  const btn = all(mid, n => n.type === 'button' && /Open Day 2/.test(text(n)))[0];
  if (btn) btn.props.onClick();
  ck('…"Open Day 2 in the Itinerary" opens that day', opened === 'day2');
  const eve = text(X.NowHome(props(at(6, 18), sched)));
  ck('6:00 PM on day 2: the timed items are done, so Next up is the untimed one', eve.includes('Today · Gelato walk'));
  const favs = text(X.NowHome(props(at(6, 11), [], { d2_tower: ['Alex|3', 'Sam|2'], d2_museum: ['Alex|1'], d2_bike: ['Riley|3', 'Sam|3', 'Casey|1'] })));
  ck('no plan yet: shows the family\'s top favorites for today, best first', favs.indexOf('Old Walls Bike Loop') >= 0 && favs.indexOf('Old Walls Bike Loop') < favs.indexOf('Bell Tower Climb') && favs.indexOf('Bell Tower Climb') < favs.indexOf('City Museum') && favs.includes("Nothing is on today's Day Plan yet"));
  const empty = text(X.NowHome(props(at(6, 11), [], {})));
  ck('no plan, no votes: says so plainly', empty.includes("Nothing is on today's Day Plan yet") && empty.includes('Nothing planned yet'));
  const before = text(X.NowHome(props(at(1, 12), sched)));
  ck('before the trip: countdown (4 days) and what is first', before.includes('4 days until the trip') && before.includes('Day 1'));
  tabbed = null;
  const after = X.NowHome(props(at(20, 12), sched));
  const ab = all(after, n => n.type === 'button')[0];
  if (ab) ab.props.onClick();
  ck('after the trip: "welcome home" and a button to the Review', text(after).includes('welcome home') && tabbed === (X.RETRO_UNLOCKED ? 'review' : 'itinerary'));
  ck('directions fall back to a search when an item has no coordinates', X.directionsUrl(null, 'Gelato walk Old City') === 'https://www.google.com/maps/dir/?api=1&destination=Gelato%20walk%20Old%20City' && X.directionsUrl(null, '') === '');
  sandbox.localStorage.setItem('tg_tab', 'now');
  React.__forceOpen = true;
  let app = null;
  try { app = X.App(); } catch (e) { app = null; }
  React.__forceOpen = false;
  sandbox.localStorage.removeItem('tg_tab');
  const nh = app ? all(app, n => n.type === X.NowHome)[0] : null;
  ck('the app shows the Now screen on the Now tab, with the live plan and clock', !!nh && Array.isArray(nh.props.schedule) && typeof nh.props.nowMs === 'number');
  ck('…without the countdown banner above it (Now has its own)', !!app && all(app, n => n.type === X.Countdown).length === 0);
}

async function favChecks() {
  console.log('==> favorite to plan');
  if (typeof X.favoriteToAdd !== 'function' || typeof X.favoritePlanBody !== 'function') { ck('favoriteToAdd / favoritePlanBody exist', false); return; }
  const day2 = X.DAYS.find(d => d.id === 'day2');
  const ints = { d2_tower: ['Alex|3', 'Sam|2'], d2_bike: ['Riley|3', 'Casey|2'], d2_museum: ['Alex|3', 'Sam|1', 'Jordan|1'], d2_lunch: ['Sam|1'] };
  // tower 5 (2 voters), bike 5 (2 voters), museum 5 (3 voters) → museum first (more voters)
  let f = X.favoriteToAdd(day2, ints, []);
  ck('the favorite is the most stars, then the most voters (City Museum: 5 stars, 3 voters)', !!f && f.a.id === 'd2_museum');
  f = X.favoriteToAdd(day2, ints, [{ id: 9, day_id: 'day2', activity_id: 'd2_museum' }]);
  ck('…already on the plan → the next one (tie on stars and voters broken by name: Bell Tower before Old Walls)', !!f && f.a.id === 'd2_tower');
  f = X.favoriteToAdd(day2, ints, [{ id: 9, day_id: 'day3', activity_id: 'd2_museum' }]);
  ck('…a favorite a planner MOVED to another day counts as planned (not offered again; v0.25.1)', !!f && f.a.id === 'd2_tower');
  ck('…no stars on the day → nothing to add', X.favoriteToAdd(day2, {}, []) === null);
  const lunch = day2.activities.find(a => a.id === 'd2_lunch');
  const b = X.favoritePlanBody(day2, Object.assign({}, lunch, { start: '13:00' }));
  ck('the plan entry: that day, the activity, everyone, its start time, a readable when',
    b.dayId === 'day2' && b.activityId === 'd2_lunch' && b.title === lunch.name && b.time === '13:00' && b.who.join() === X.FAMILY.join() && b.whenText === 'Sep 6, 1:00 PM');
  ck('…no start time → untimed entry', X.favoritePlanBody(day2, Object.assign({}, lunch, { start: undefined })).time === '');
  // Decide, rendered by the app for a planner with votes on day 2
  const posts = [];
  const realFetch = sandbox.fetch;
  sandbox.fetch = (url, o) => { if (o && o.method === 'POST') posts.push({ url: String(url), body: JSON.parse(o.body || '{}') }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('') }); };
  sandbox.localStorage.setItem('tg_token', 'tok-fav'); sandbox.localStorage.setItem('tg_name', 'Alex');
  const render = (who, confirmAns) => {
    sandbox.window.confirm = () => confirmAns;
    sandbox.localStorage.setItem('tg_tab', 'decide');
    React.__forceOpen = true;
    React.__stateOverrides = [{ init: null, value: who }, { init: {}, value: ints }];
    let app = null;
    try { app = X.App(); } catch (e) { app = null; }
    React.__forceOpen = false; React.__stateOverrides = [];
    return app;
  };
  let app = render('Alex', false);
  let favBtns = app ? all(app, n => n.type === 'button' && /Put the favorite on/.test(text(n))) : [];
  const d2btn = favBtns.find(n => /Day 2/.test(text(n)));
  ck('Decide shows a planner "Put the favorite on Day 2\'s plan: City Museum"', !!d2btn && text(d2btn).includes('City Museum'));
  if (d2btn) d2btn.props.onClick();
  await new Promise(r => setImmediate(r));
  ck('…answering Cancel sends nothing', posts.length === 0);
  app = render('Alex', true);
  favBtns = app ? all(app, n => n.type === 'button' && /Put the favorite on/.test(text(n))) : [];
  const again = favBtns.find(n => /Day 2/.test(text(n)));
  if (again) again.props.onClick();
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  const p = posts[0];
  ck('…answering OK adds it to the Day Plan (POST /api/schedule, day2, City Museum, everyone)', !!p && /\/api\/schedule$/.test(p.url) && p.body.dayId === 'day2' && p.body.activityId === 'd2_museum' && p.body.who.length === X.FAMILY.length);
  app = render('Nobody', true);
  favBtns = app ? all(app, n => n.type === 'button' && /Put the favorite on/.test(text(n))) : [];
  ck('someone who is not a planner does not get the button', app !== null && favBtns.length === 0);
  sandbox.fetch = realFetch;
  ['tg_tab', 'tg_token', 'tg_name'].forEach(k => sandbox.localStorage.removeItem(k));
  // a favorite added while offline shows as a "saving…" row until the server has it
  if (typeof X.mergePendingPlan === 'function') {
    const pend = { id: 'pending-1', day_id: 'day2', activity_id: 'd2_tower', title: 'Bell Tower Climb', time_text: '', pending: true };
    const q = [{ u: '/api/schedule', o: { method: 'POST', body: JSON.stringify({ dayId: 'day2', activityId: 'd2_tower' }) } }];
    const srv = [{ id: 5, day_id: 'day1', activity_id: 'd1_flight', title: 'Arrival Flight' }];
    ck('a reload keeps a saving row while its add waits in the offline queue', X.mergePendingPlan(srv, [pend], q).map(r => r.id).join() === '5,pending-1');
    ck('…and drops it once the server has the real row (no duplicate)', X.mergePendingPlan(srv.concat([{ id: 6, day_id: 'day2', activity_id: 'd2_tower' }]), [pend], q).map(r => r.id).join() === '5,6');
    ck('…or when nothing is queued for it any more', X.mergePendingPlan(srv, [pend], []).map(r => r.id).join() === '5');
  } else ck('mergePendingPlan exists', false);
  if (typeof X.DayPlanCard === 'function') {
    const pend = { id: 'pending-1', day_id: 'day2', activity_id: 'd2_tower', title: 'Bell Tower Climb', time_text: '', who: '[]', pending: true };
    const real = { id: 7, day_id: 'day2', activity_id: 'd2_lunch', title: 'Market Lunch', time_text: '13:00', who: '[]' };
    const noop = () => {};
    const card = X.DayPlanCard({ day: X.DAYS.find(d => d.id === 'day2'), schedule: [pend, real], user: X.FAMILY[0], onAdd: noop, onDelete: noop, onJump: noop, onEdit: noop, onMove: noop, reservations: [], prefill: null, interests: {} });
    const labels = all(card, n => n.type === 'button').map(n => n.props['aria-label']).filter(Boolean);
    const ct = text(card);
    ck('a saving row says "saving…" and has no edit / move / remove buttons yet; a saved row has them', ct.includes('saving') && labels.filter(l => l === 'Edit this plan item').length === 1 && labels.filter(l => l === 'Remove from the plan').length === 1);
    // v0.25.1: the remove-confirm strip must fit a phone. DayPlanCard's
    // useState(null) order is editId, confirmId, moveId, mDay — override the
    // second so the confirm is open on the booking-linked row.
    const res = { id: 3, day_id: 'day2', kind: 'hotel', name: 'Check in Harbor Inn Old Town Riverside Suites', confirmation: 'ABC123' };
    const linked = { id: 8, day_id: 'day2', activity_id: 'res:3', res_id: 3, title: res.name, time_text: '12:45', who: '[]' };
    React.__stateOverrides = [{ init: null, value: null }, { init: null, value: 8 }];
    let open = null;
    try { open = X.DayPlanCard({ day: X.DAYS.find(d => d.id === 'day2'), schedule: [linked], user: X.FAMILY[0], onAdd: noop, onDelete: noop, onJump: noop, onEdit: noop, onMove: noop, reservations: [res], prefill: null, interests: {} }); } catch (e) { open = null; }
    React.__stateOverrides = [];
    const strip = open ? all(open, n => n.props['aria-label'] === 'Confirm removal')[0] : null;
    const row = strip ? all(open, n => (n.children || []).indexOf(strip) >= 0)[0] : null;
    const st = strip ? strip.props.style || {} : {};
    ck('the remove confirm ("… also deletes its booking") sits on a full-width line of its own, so the row wraps and Delete / Keep stay on a 360px phone',
      !!strip && text(strip).includes('deletes its booking') && st.flex === '1 1 100%' && !('flexShrink' in st) && !!row && row.props.style.flexWrap === 'wrap');
    const dk = strip ? all(strip, n => n.type === 'button').map(n => text(n).trim()) : [];
    ck('…with Delete and Keep buttons big enough to tap (12px, 6px padding)', dk.join() === 'Delete,Keep' && all(strip, n => n.type === 'button').every(n => parseFloat(n.props.style.fontSize) >= 12));
    const pk = strip ? all(strip, n => n.type === 'button' && text(n).trim() === 'Keep')[0] : null;
    const closed = X.DayPlanCard({ day: X.DAYS.find(d => d.id === 'day2'), schedule: [linked], user: X.FAMILY[0], onAdd: noop, onDelete: noop, onJump: noop, onEdit: noop, onMove: noop, reservations: [res], prefill: null, interests: {} });
    const rmBtn = all(closed, n => n.props['aria-label'] === 'Remove from the plan')[0];
    ck('…keyboard: focus lands on Keep when the confirm opens, and Keep hands it back to that row\'s ×', !!pk && pk.props.autoFocus === true && !!rmBtn && rmBtn.props['data-rm'] === 'plan-8');
  } else ck('DayPlanCard exists', false);
}


function packChecks() {
  console.log('==> packing');
  if (typeof X.PackRow !== 'function') { ck('PackRow exists', false); return; }
  const tog = [], del = [];
  const row = p => X.PackRow({ p, onToggle: id => tog.push(id), onDelete: id => del.push(id) });
  const cb = r => all(r, n => n.props.role === 'checkbox')[0];
  const mine = row({ id: 7, item: 'Passports', who: '', perPerson: true, done: 1, doneBy: ['Alex', 'Sam'] });
  ck('a per-person item you packed: checked, and says who has packed it', !!cb(mine) && cb(mine).props['aria-checked'] === 'true' && text(mine).includes('Packed: Alex, Sam') && /packed by Alex, Sam/.test(cb(mine).props['aria-label']));
  const notYet = row({ id: 8, item: 'Charger', who: '', perPerson: true, done: 0, doneBy: [] });
  ck('…nobody yet: unchecked, "Each person checks their own"', cb(notYet).props['aria-checked'] === 'false' && text(notYet).includes('Each person checks their own'));
  const shared = row({ id: 9, item: 'Sunscreen', who: 'Everyone', perPerson: false, done: 1 });
  ck('a shared item: one check, no per-person line', cb(shared).props['aria-checked'] === 'true' && !/Packed:|Each person/.test(text(shared)));
  cb(shared).props.onClick();
  let prevented = false;
  cb(notYet).props.onKeyDown({ key: ' ', preventDefault() { prevented = true; } });
  cb(notYet).props.onKeyDown({ key: 'a', preventDefault() {} });
  ck('tap or Space/Enter toggles; other keys do not', tog.join() === '9,8' && prevented && cb(notYet).props.tabIndex === 0);
  // v0.25.1: × asks first. The harness's useState setter is a no-op, so check
  // what the tap asks for, then render the asking state (useState(false) → true).
  let asked = null;
  React.__setSpy = (init, v) => { if (init === false) asked = v; };
  const x = all(mine, n => n.type === 'button')[0];
  try { if (x) x.props.onClick({ stopPropagation() {} }); } finally { React.__setSpy = null; }
  ck('the remove button sits beside the checkbox (not inside it), says what it removes, and does not toggle', !!x && all(cb(mine), n => n.type === 'button').length === 0 && x.props['aria-label'] === 'Remove Passports' && tog.length === 2);
  ck('…tapping × asks first ("Remove it?") and removes nothing yet', asked === true && del.length === 0);
  React.__stateOverrides = [{ init: false, value: true }];
  let ask = null;
  try { ask = row({ id: 7, item: 'Passports', who: '', perPerson: true, done: 1, doneBy: ['Alex', 'Sam'] }); } finally { React.__stateOverrides = []; }
  const grp = ask ? all(ask, n => n.props['aria-label'] === 'Confirm removal')[0] : null;
  const gb = grp ? all(grp, n => n.type === 'button') : [];
  const keep = gb.find(b => text(b).trim() === 'Keep'), delBtn = gb.find(b => text(b).trim() === 'Delete');
  if (keep) keep.props.onClick();
  const afterKeep = del.length;
  if (delBtn) delBtn.props.onClick();
  ck('…the confirm offers Delete and Keep: Keep removes nothing, Delete removes that item', !!grp && text(grp).includes('Remove it?') && afterKeep === 0 && del.join() === '7' && all(ask, n => n.props['aria-label'] === 'Remove Passports').length === 0);
  const gs = grp ? grp.props.style || {} : {};
  const rowBox = ask ? ask.props.style || {} : {};
  ck('…the confirm takes a full-width line of its own under the item (the item name keeps its width on a phone)', gs.flex === '1 1 100%' && !('flexShrink' in gs) && rowBox.flexWrap === 'wrap');
  ck('…keyboard: focus lands on Keep when it opens, and Keep hands focus back to this row\'s ×', !!keep && keep.props.autoFocus === true && x.props['data-rm'] === 'pack-7');
  if (typeof X.focusAfterDelete === 'function') {
    // a fake page: packing ×s #1 (before the Delete button) and #3 (after it);
    // row #2's own × is hidden behind its confirm
    const mk = v => ({ getAttribute: () => v });
    const r1 = mk('pack-1'), r3 = mk('pack-3');
    const btn = { compareDocumentPosition: el => (el === r1 ? 2 : 4) }; // 2 = el precedes, 4 = el follows
    const realQ = sandbox.document.querySelectorAll;
    const picks = [];
    try {
      sandbox.document.querySelectorAll = () => [r1, r3]; picks.push(X.focusAfterDelete(btn, 'pack-', '.pack-group-head'));
      sandbox.document.querySelectorAll = () => [r1]; picks.push(X.focusAfterDelete(btn, 'pack-', '.pack-group-head'));
      sandbox.document.querySelectorAll = () => []; picks.push(X.focusAfterDelete(btn, 'pack-', '.pack-group-head'));
    } finally { sandbox.document.querySelectorAll = realQ; }
    ck('…Delete sends keyboard focus to the next row\'s ×, else the previous one, else the group header (not to the top of the page)',
      picks.join(' | ') === '[data-rm="pack-3"] | [data-rm="pack-1"] | .pack-group-head');
  } else ck('focusAfterDelete exists', false);
  const box = all(cb(mine), n => n.props['aria-hidden'] === 'true')[0];
  ck('the check box is at least 26px (was 21px)', !!box && parseFloat(box.props.style.width) >= 26);
  ck("packing groups follow the trip's own travelers, then Everyone and Day Bag", Array.isArray(X.PACK_PERSON_ORDER) && X.PACK_PERSON_ORDER.join() === X.FAMILY.concat(['Everyone', 'Day Bag']).join());
  // v0.25.1: each group header is a real button that says Hide / Show and
  // which list it opens (the app's Packing tab, with two groups of items)
  const items = [{ id: 1, item: 'Hat', who: X.FAMILY[0], done: 0 }, { id: 2, item: 'Snacks', who: 'Day Bag', done: 0, perPerson: true, doneBy: [] }];
  sandbox.localStorage.setItem('tg_tab', 'packing');
  const renderPack = collapsedMap => {
    // packing is the app's 4th useState([]) (notes, suggestions, bookings, packing)
    React.__stateOverrides = [{ init: null, value: X.FAMILY[0] }, { init: [], value: [] }, { init: [], value: [] }, { init: [], value: [] }, { init: [], value: items }].concat(collapsedMap ? [{ init: {}, value: collapsedMap }] : []);
    React.__forceOpen = true;
    let app = null;
    try { app = X.App(); } catch (e) { app = null; }
    React.__forceOpen = false; React.__stateOverrides = [];
    return app;
  };
  const shown = app => all(app, n => n.type === X.PackRow).map(n => n.props.p.item); // rows are components: read their props
  const openApp = renderPack(null);
  const heads = openApp ? all(openApp, n => n.props.className === 'pack-group-head') : [];
  ck('packing group headers are buttons that say "Hide" and point at their list (aria-expanded, aria-controls)',
    heads.length === 2 && heads.every(h => h.type === 'button' && h.props['aria-expanded'] === 'true' && /Hide/.test(text(h)) && all(openApp, n => n.props.id === h.props['aria-controls']).length === 1));
  // the App has several useState({}) — find the one that is packCollapsed by
  // trying each position until a header reports collapsed
  let folded = null;
  for (let k = 0; k < 12 && !folded; k++) {
    const pre = Array.from({ length: k }, () => ({ init: {}, value: {} }));
    React.__stateOverrides = [{ init: null, value: X.FAMILY[0] }, { init: [], value: [] }, { init: [], value: [] }, { init: [], value: [] }, { init: [], value: items }].concat(pre, [{ init: {}, value: { 'Day Bag': true } }]);
    React.__forceOpen = true;
    let app = null;
    try { app = X.App(); } catch (e) { app = null; }
    React.__forceOpen = false; React.__stateOverrides = [];
    const h = app ? all(app, n => n.props.className === 'pack-group-head' && n.props['aria-expanded'] === 'false')[0] : null;
    if (h) folded = { app, h };
  }
  ck('…a folded group says "Show", its items are hidden, and the other group stays open',
    !!folded && /Show/.test(text(folded.h)) && shown(folded.app).join() === 'Hat' && shown(openApp).join() === 'Hat,Snacks');
  const note = folded ? all(folded.app, n => n.props.className === 'pack-folded-note')[0] : null;
  ck('…a folded group says how many items it is hiding and which sections ("1 item folded away … Tap Show"); an open one says nothing',
    !!note && /^1 item folded away/.test(text(note)) && /Tap Show/.test(text(note)) && all(openApp, n => n.props.className === 'pack-folded-note').length === 0);
  ck('…a folded header points at no list (its list is not on the page); open lists have distinct ids',
    !!folded && folded.h.props['aria-controls'] === undefined && new Set(heads.map(h => h.props['aria-controls'])).size === heads.length);
  ck('…its focus ring is drawn inside the header (the card would clip one outside it)', /\.pack-group-head:focus-visible\{outline-offset:-3px/.test(HTML));
  sandbox.localStorage.removeItem('tg_tab');
}

function chipChecks() {
  console.log('==> day chips');
  if (typeof X.DayStrip !== 'function') { ck('DayStrip exists', false); return; }
  const L = (l, w) => typeof X.dayChipLines === 'function' ? X.dayChipLines(l, w).join(' / ') : '(no dayChipLines)';
  ck('a label like "Sat Sep 5" keeps its day number (was "Sat / Sep"); the weekday printed above is not repeated', L('Sat Sep 5', 'Sat') === 'Sep / 5' && L('Sat. Sep 5', 'Sat') === 'Sep / 5');
  ck('…"Saturday Sep 5" drops the weekday too, but "Sunset cruise" on a Sunday keeps its first word; the result says whether it dropped one',
    L('Saturday Sep 5', 'Sat') === 'Sep / 5' && L('Sunset cruise', 'Sun') === 'Sunset / cruise' && X.dayChipLines('Sat Sep 5', 'Sat').stripped === true && X.dayChipLines('Day  1', 'Sat').stripped === false);
  ck('…"Day 1" stays "Day / 1"; a long label keeps every word on the second line; one word stays one line', L('Day 1', 'Sat') === 'Day / 1' && L('Arrival day in Rome', '') === 'Arrival / day in Rome' && L('Arrival', 'Sat') === 'Arrival / ' && L('', '') === ' / ');
  const days = [{ id: 'day1', label: 'Sat Sep 5', emoji: 'x', location: 'Harbor Town' }, { id: 'day2', label: 'Day 2', emoji: 'y' }];
  const strip = X.DayStrip({ days, day: 'day1', onPick() {} });
  const chips = all(strip, n => n.type === 'button' && 'data-active' in n.props);
  ck('each day chip shows the whole label and has a spoken name (weekday once, label, place) and marks the current day',
    chips.length === 2 && text(chips[0]).includes('5') && chips[0].props['aria-label'] === 'Sat Sep 5, Harbor Town' && /^Sun — Day 2$/.test(chips[1].props['aria-label']) && chips[0].props['aria-current'] === 'true' && chips[1].props['aria-current'] === undefined);
}

function moreKeyChecks() {
  console.log('==> More list keyboard (offline)');
  // The list's keyboard handling lives in a mount effect + onBlur. Run the
  // effect with fake DOM nodes: useRef is called moreRef, then listRef.
  const focused = [];
  const firstBtn = { focus() { focused.push('first'); } };
  const inside = { id: 'inside' }, outside = { id: 'outside' };
  const moreEl = { focus() { focused.push('more'); } };
  const listEl = { querySelector: s => (s === 'button' ? firstBtn : null), contains: n => n === inside || n === firstBtn };
  const refs = [{ current: moreEl }, { current: listEl }];
  const realRef = React.useRef, realAdd = sandbox.document.addEventListener, realRm = sandbox.document.removeEventListener;
  const listeners = [], removed = [];
  let k = 0, sets = [];
  React.useRef = () => refs[k++ % 2];
  sandbox.document.addEventListener = (type, fn) => listeners.push({ type, fn });
  sandbox.document.removeEventListener = (type, fn) => removed.push({ type, fn });
  React.__runEffects = true;
  let bar = null;
  try { bar = X.TabBar({ tabs: X.TAB_LIST, tab: 'itinerary', onPick() {}, wide: false, moreOpen: true, setMoreOpen: v => sets.push(v) }); } finally {
    React.__runEffects = false; React.useRef = realRef;
    sandbox.document.addEventListener = realAdd; sandbox.document.removeEventListener = realRm;
  }
  ck('opening More moves focus to the first entry in the list', focused[0] === 'first');
  const key = listeners.find(l => l.type === 'keydown');
  if (key) key.fn({ key: 'a' });
  ck('…a key other than Escape does nothing', !!key && sets.length === 0);
  if (key) key.fn({ key: 'Escape' });
  ck('…Escape closes the list and puts focus back on More', sets.join() === 'false' && focused[focused.length - 1] === 'more');
  const menu = bar ? all(bar, n => n.props.id === 'more-tabs')[0] : null;
  sets = [];
  if (menu) { menu.props.onBlur({ relatedTarget: inside }); menu.props.onBlur({ relatedTarget: moreEl }); menu.props.onBlur({ relatedTarget: null }); }
  const kept = sets.length;
  if (menu) menu.props.onBlur({ relatedTarget: outside });
  ck('…moving focus inside the list, back to More, or nowhere keeps it open; tabbing out of it closes it', !!menu && kept === 0 && sets.join() === 'false');
}

function portalChecks() {
  console.log('==> portal sign-in message');
  if (typeof X.ssoNoteFor !== 'function') { ck('ssoNoteFor exists', false); return; }
  ck('no portal cookie (an ordinary visitor): no message', X.ssoNoteFor({ ok: false, reason: 'none' }) === '' && X.ssoNoteFor(null) === '');
  ck('expired portal sign-in: says so and offers the PIN', /run out/.test(X.ssoNoteFor({ reason: 'expired' })) && /PIN/.test(X.ssoNoteFor({ reason: 'expired' })));
  const n = X.ssoNoteFor({ reason: 'not-on-trip', name: 'Morgan' });
  ck("not on this trip: names who the portal signed in and says they aren't on this trip's list", n.includes('as Morgan') && n.includes("isn't on this trip's list") && /organizer/.test(n));
  const lt = text(X.Login({ onLogin() {}, notice: 'NOTICE-TEXT' }));
  const none = text(X.Login({ onLogin() {} }));
  ck('the sign-in screen shows the message above the names, and nothing when there is none', lt.includes('NOTICE-TEXT') && lt.indexOf('NOTICE-TEXT') < lt.indexOf('Who are you?') && !none.includes('NOTICE-TEXT'));
}

// Render a tree all the way down: the harness's fake React records component
// elements without calling them, so call each component with its props.
const deep = (node, depth) => {
  if (!node || typeof node !== 'object' || depth > 40) return node;
  if (Array.isArray(node)) return node.map(n => deep(n, depth));
  if (typeof node.type === 'function') {
    let out = null;
    try { out = node.type(Object.assign({}, node.props, { children: node.children })); } catch (e) { out = null; }
    return deep(out, depth + 1);
  }
  return Object.assign({}, node, { children: (node.children || []).map(k => deep(k, depth + 1)) });
};
function a11yChecks() {
  console.log('==> accessibility');
  const T = '<script type="text/plain" id="trip-main">';
  const i0 = HTML.indexOf(T) + T.length;
  const main = HTML.slice(i0, HTML.indexOf('</' + 'script>', i0));
  // every tab, fully rendered, as a signed-in planner with menus open
  const unnamed = {};
  let rendered = 0;
  for (const t of X.TAB_LIST.map(x => x.id).concat(X.RETRO_UNLOCKED ? ['review'] : [])) {
    sandbox.localStorage.setItem('tg_tab', t);
    React.__forceOpen = true; React.__stateOverrides = [{ init: null, value: X.FAMILY[0] }];
    let app = null;
    try { app = deep(X.App(), 0); rendered++; } catch (e) { app = null; }
    React.__forceOpen = false; React.__stateOverrides = [];
    all(app, n => n.type === 'button' || n.props.role === 'button' || n.props.role === 'checkbox' || n.props.role === 'menuitem')
      .filter(n => !/[A-Za-z0-9]/.test(text(n)) && !n.props['aria-label'])
      .forEach(n => { const k = t + ':' + JSON.stringify(text(n)); unnamed[k] = (unnamed[k] || 0) + 1; });
  }
  sandbox.localStorage.removeItem('tg_tab');
  const un = Object.keys(unnamed);
  ck('every button on every tab has a name a screen reader can read (' + rendered + ' tabs)' + (un.length ? ' — unnamed: ' + un.slice(0, 5).join(', ') : ''), rendered >= X.TAB_LIST.length && un.length === 0);
  // symbol-only buttons anywhere in the source (covers rows the render above doesn't reach)
  const bad = [];
  const re = /React\.createElement\("button", \{/g;
  let m;
  while ((m = re.exec(main))) {
    let j = m.index + m[0].length, depth = 1;
    while (depth && j < main.length) { const c = main[j]; if (c === '{') depth++; else if (c === '}') depth--; j++; }
    const props = main.slice(m.index + m[0].length, j - 1);
    const lit = /^\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(main.slice(j, j + 80));
    if (!lit) continue;
    const txt = JSON.parse('"' + lit[1].replace(/\\x([0-9A-Fa-f]{2})/g, '\\u00$1') + '"');
    if (!/[A-Za-z0-9]/.test(txt) && props.indexOf('aria-label') < 0) bad.push(txt);
  }
  ck('no symbol-only button (☆ ✎ ⇄ × ✕) without a label anywhere in the app' + (bad.length ? ' — ' + bad.join(' ') : ''), bad.length === 0);
  const stars = /"aria-label": "Rate " \+ k/.test(main) && /"aria-pressed": ms === k/.test(main);
  ck('star buttons say "Rate N stars" and whether they are pressed', stars);
  // text grays that fall under 4.5:1 on white (#9CA3AF…) or on the gray page
  // background #F0F2F5 (#6B7280, #64748B ≈ 4.3:1) — anywhere in a color value,
  // ternaries included
  // (a disabled control or a decorative glyph is exempt — marked "exempt" in the source)
  const grays = main.split('\n').filter(l => !/exempt/.test(l)).join('\n').match(/(?<![a-zA-Z])color: [^,}\n]*"#(9CA3AF|94A3B8|C1C7D0|CBD5E1|D1D5DB|6B7280|64748B)"/g);
  const exempt = main.split('\n').filter(l => /(?<![a-zA-Z])color: .*exempt/.test(l)).length;
  ck('no low-contrast gray text (fails WCAG AA on white or on the gray page) — ' + (grays ? grays.length : 0) + ' left; ' + exempt + ' marked exempt (disabled / decorative)', !grays && exempt <= 12);
  ck('a visible keyboard focus ring overrides inline outline:none', /\*:focus-visible\{outline:3px solid [^}]*!important/.test(HTML));
  ck('the map is its own layer, so its tiles and zoom buttons stay under the More list and the header', /ref: elRef,\s*style: \{\s*position: "relative",\s*zIndex: 0,\s*isolation: "isolate"/.test(main));
  React.__forceOpen = true; React.__stateOverrides = [{ init: null, value: X.FAMILY[0] }];
  let app = null;
  try { app = X.App(); } catch (e) { app = null; }
  React.__forceOpen = false; React.__stateOverrides = [];
  const skip = app ? all(app, n => n.type === 'a' && n.props.className === 'skip-link')[0] : null;
  const target = app ? all(app, n => n.props.id === 'main')[0] : null;
  ck('"Skip to the trip" link jumps to the content (#main, focusable)', !!skip && skip.props.href === '#main' && !!target && target.props.tabIndex === -1 && /\.skip-link:focus\{top:/.test(HTML));
}

function todayChecks() {
  console.log('==> today without dates');
  const os = require('os'), cp = require('child_process');
  const T = '<script type="application/json" id="trip-data">';
  const i = HTML.indexOf(T) + T.length;
  const trip = JSON.parse(HTML.slice(i, HTML.indexOf('</' + 'script>', i)));
  const run = t => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-today-'));
    try {
      const f = path.join(d, 'trip.json');
      fs.writeFileSync(f, JSON.stringify(t));
      const r = cp.spawnSync(process.execPath, [__filename, ROOT], { env: Object.assign({}, process.env, { UI_CHILD: 'today', UI_TRIP: f }), encoding: 'utf8', timeout: 60000 });
      return JSON.parse(r.stdout || '{}');
    } catch (e) { return { err: e.message }; } finally { fs.rmSync(d, { recursive: true, force: true }); }
  };
  const undated = JSON.parse(JSON.stringify(trip));
  Object.keys(undated.dayCoords).forEach(k => { delete undated.dayCoords[k].date; });
  let o = run(undated);
  ck('days without dates: today = the trip day counted from the start (Sep 7 → day3)', o.d7 === 'day3' && o.d5 === 'day1');
  const mixed = JSON.parse(JSON.stringify(trip));
  delete mixed.dayCoords.day2.date; delete mixed.dayCoords.day3.date;
  mixed.dayCoords.day4.date = '2026-09-07'; // day4 claims Sep 7 by date
  o = run(mixed);
  ck('…a dated day wins, and counting never lands on a day that has a different date of its own', o.d7 === 'day4' && o.d8 === null);
  ck('…an undated day between two dated days is found by counting (Sep 6 → day2), not by the earlier dated day', o.d6 === 'day2');
  // v0.25.2: per-day time zones. Day 3 (Sep 7) is in Rome; the trip's zone is
  // New York. At 22:30 UTC on Sep 6 it is 18:30 Sep 6 in New York but already
  // 00:30 Sep 7 in Rome — the family has arrived in day 3.
  const zoned = JSON.parse(JSON.stringify(trip));
  zoned.dayCoords.day3.tz = 'Europe/Rome'; zoned.dayCoords.day4.tz = 'Europe/Rome';
  o = run(zoned);
  ck('a day with its own time zone: just after midnight in Rome it is already day 3 there (New York still says Sep 6)', o.tzDay === 'day3' && o.tzMap && o.tzMap.day3 === 'Europe/Rome' && !o.tzMap.day1);
  ck('…the Now screen reads the clock in that day\'s zone: at 00:30 Rome the 9:00 AM item is Next up (read in New York, 18:30, nothing would be)', o.tzNext === 'next=9:00' && o.tzPhase === 'during');
  // westward: day 3 (Sep 7) in Rome, day 4 (Sep 8) back in New York. At 01:00
  // Rome on Sep 8 (19:00 Sep 7 in New York) neither date matches its own
  // zone; day 3 must stay "today" until day 4 begins.
  const west = JSON.parse(JSON.stringify(trip));
  west.dayCoords.day3.tz = 'Europe/Rome';
  o = run(west);
  ck('…westward: between Rome\'s midnight and New York\'s, day 3 stays today (not "nothing today")', o.westDay === 'day3' && o.westPhase === 'during');
  // the ends of a zoned trip: day 1 in Honolulu (UTC−10), the last day in Rome
  const ends = JSON.parse(JSON.stringify(trip));
  ends.dayCoords.day1.tz = 'Pacific/Honolulu'; ends.dayCoords.day4.tz = 'Europe/Rome';
  o = run(ends);
  ck('…before day 1 starts in ITS zone (still Sep 4 in Honolulu, Sep 5 in New York) the trip is "before", not "during" with no today', o.eStartPhase === 'before' && o.eStartDay === null);
  ck('…after the last day ends in ITS zone (Sep 9 in Rome, Sep 8 in New York) the trip is "after"', o.eEndPhase === 'after' && o.eEndDay === null);
  const badz = JSON.parse(JSON.stringify(trip));
  badz.dayCoords.day3.tz = 'Mars/Olympus_Mons';
  o = run(badz);
  ck('…an unknown zone name is ignored (that day uses the trip\'s zone)', o.tzDay === 'day2' && o.tzMap && Object.keys(o.tzMap).length === 0);
}

if (process.env.UI_CHILD === 'today') {
  const at = d => Date.UTC(2026, 8, d, 16, 0);
  const zms = Date.UTC(2026, 8, 6, 22, 30);
  // day 3 plan: 00:15 (already past at 00:30 Rome) and 09:00 (next up). With
  // the clock read in New York (18:30) both would be past and nothing is next.
  let tzNext = null;
  try {
    const nh = X.NowHome({ schedule: [{ id: 1, day_id: 'day3', title: 'Late snack', time_text: '00:15' }, { id: 2, day_id: 'day3', title: 'Morning walk', time_text: '09:00' }], reservations: [], interests: {}, nowMs: zms, onOpenDay() {}, onTab() {} });
    const s = text(nh); tzNext = s.includes('9:00 AM \u00B7 Morning walk') ? 'next=9:00' : 'no-next';
  } catch (e) { tzNext = 'ERR ' + e.message; }
  process.stdout.write(JSON.stringify({ d5: (X.todayDay(at(5)) || {}).id || null, d7: (X.todayDay(at(7)) || {}).id || null, d8: (X.todayDay(at(8)) || {}).id || null,
    tzDay: (X.todayDay(zms) || {}).id || null, tzMap: X.DAY_TZ || null, tzPhase: X.tripPhase(zms), tzNext,
    westDay: (X.todayDay(Date.UTC(2026, 8, 7, 23, 0)) || {}).id || null, westPhase: X.tripPhase(Date.UTC(2026, 8, 7, 23, 0)),
    d6: (X.todayDay(at(6)) || {}).id || null,
    eStartPhase: X.tripPhase(Date.UTC(2026, 8, 5, 6, 0)), eStartDay: (X.todayDay(Date.UTC(2026, 8, 5, 6, 0)) || {}).id || null,
    eEndPhase: X.tripPhase(Date.UTC(2026, 8, 8, 23, 0)), eEndDay: (X.todayDay(Date.UTC(2026, 8, 8, 23, 0)) || {}).id || null }));
  process.exit(0);
}

(async () => {
  try { tabChecks(); } catch (e) { ck('tab checks ran without an exception (' + e.message + ')', false); }
  try { nowChecks(); } catch (e) { ck('now checks ran without an exception (' + e.message + ')', false); }
  try { todayChecks(); } catch (e) { ck('today checks ran without an exception (' + e.message + ')', false); }
  try { moreKeyChecks(); } catch (e) { ck('More keyboard checks ran without an exception (' + e.message + ')', false); }
  try { chipChecks(); } catch (e) { ck('day chip checks ran without an exception (' + e.message + ')', false); }
  try { portalChecks(); } catch (e) { ck('portal checks ran without an exception (' + e.message + ')', false); }
  try { a11yChecks(); } catch (e) { ck('accessibility checks ran without an exception (' + e.message + ')', false); }
  try { packChecks(); } catch (e) { ck('packing checks ran without an exception (' + e.message + ')', false); }
  try { await favChecks(); } catch (e) { ck('favorite checks ran without an exception (' + e.message + ')', false); }
  console.log('RESULT: ' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
