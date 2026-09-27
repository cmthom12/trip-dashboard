#!/usr/bin/env node
/*
 * boot-rehearsal.js — the v0.24 paths the render harness can't reach.
 *
 * The render harness evaluates the app script against a trip it hands in, so
 * it never runs the REAL page bootstrap (the inline <script> that fetches
 * /api/trip and picks the full trip, the sign-in shell, the saved copy or the
 * sample), nor the service worker. Review of v0.24 found the risky behaviour
 * lives exactly there. This runs both, for real, against stubbed browsers:
 *
 *   boot  : summary → shell; full trip → cached; slow/failed/not-a-trip
 *           answers → saved copy, one patient retry, else "Try again" (never
 *           the built-in sample); a plain file still shows the sample.
 *   login : sign-in reloads once per token; a browser that blocks storage
 *           gets a message, not a reload (PIN and portal paths); the forgot-
 *           PIN line shows during a lockout; after a sign-out the portal
 *           doesn't sign the same person back in.
 *   logout: clears the session, the saved trip and lists, asks before
 *           discarding this traveler's unsent changes, revokes the token.
 *   outbox: queued writes carry their author; another traveler signing in
 *           drops them instead of sending them as that person; writes the
 *           server refuses for good are dropped, not retried forever.
 *   sw    : /api/*, admin.html and other pages untouched; the page is
 *           network-first, saved only when HTML, and a slow network yields
 *           the saved copy after 4 s — and still refreshes it afterwards.
 *
 * Usage: node tools/boot-rehearsal.js [repo-root]   (default: this repo)
 * Exit 0 = every check passed.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (label, ok) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label); };
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const TAG = '<script type="application/json" id="trip-data">';
const ti = HTML.indexOf(TAG) + TAG.length;
const SAMPLE = HTML.slice(ti, HTML.indexOf('</' + 'script>', ti));
const SAMPLE_TRIP = JSON.parse(SAMPLE);
const BOOT = (() => { // the inline <script> right after the trip-data block
  const k = HTML.indexOf("var CACHE_KEY = 'tg_trip_cache'");
  const a = HTML.lastIndexOf('<script>', k) + '<script>'.length;
  return HTML.slice(a, HTML.indexOf('</' + 'script>', k));
})();

// ── boot: run the real bootstrap against a stubbed page ─────────────────────
function boot({ answers, store = {}, protocol = 'https:', onLine = true, parsing = false }) {
  const ls = Object.assign({}, store);
  const localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  const tripData = { textContent: SAMPLE }, tripMain = { textContent: 'MAIN' };
  const body = [];
  const mk = tag => ({ tag, style: {}, kids: [], textContent: '', setAttribute(k, v) { this[k] = v; }, appendChild(c) { this.kids.push(c); } });
  const bodyEl = { appendChild: c => { c.parentNode = bodyEl; body.push(c); }, removeChild: c => { const i = body.indexOf(c); if (i >= 0) body.splice(i, 1); c.parentNode = null; } };
  // parsing: the page is still being read — the app script (after the
  // bootstrap in the page) doesn't exist yet until DOMContentLoaded.
  const ready = [];
  const document = { readyState: parsing ? 'loading' : 'complete', addEventListener: (t, fn) => { if (t === 'DOMContentLoaded') ready.push(fn); },
    getElementById: id => (id === 'trip-data' ? tripData : id === 'trip-main' ? (document.readyState === 'loading' ? null : tripMain) : null), createElement: mk, body: bodyEl };
  const calls = [], timers = [];
  const fetch = (url, opts) => {
    const kind = answers[calls.length] || 'fail';
    calls.push({ url, opts: opts || {} });
    if (kind === 'fail') return Promise.reject(new Error('offline'));
    if (kind === '404') return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('{"error":"No trip configured"}') });
    const txt = kind === 'summary' ? JSON.stringify({ summary: true, trip: { title: 'Summary Title', startDate: '2030-01-01', endDate: '2030-01-05' }, family: [{ name: 'Pat', color: ['#fff', '#000'] }], tz: 'America/Chicago' })
      : kind === 'full' ? JSON.stringify(Object.assign({}, SAMPLE_TRIP, { trip: Object.assign({}, SAMPLE_TRIP.trip, { title: 'Full Title' }) }))
      : '<html>hotel wi-fi sign-in</html>';
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(txt) });
  };
  class AbortController { constructor() { this.signal = {}; } abort() {} }
  const window = { AbortController, location: { protocol, reload() {} } };
  const ctx = { window, document, localStorage, fetch, AbortController, location: window.location, JSON, Error, navigator: { onLine },
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {} };
  vm.createContext(ctx);
  vm.runInContext(BOOT, ctx, { filename: 'bootstrap.js' });
  return {
    ls, calls, timers, body,
    trip: () => { try { return JSON.parse(tripData.textContent); } catch (e) { return null; } },
    started: () => body.some(n => n.tag === 'script' && n.textContent === 'MAIN'),
    alert: () => body.find(n => n.role === 'alert'),
    waiting: () => body.find(n => n.id === 'boot-wait'),
    parsed: () => { document.readyState = 'interactive'; ready.splice(0).forEach(fn => fn()); }
  };
}
const alertText = n => (n ? n.kids.map(k => k.textContent).join(' | ') : '');

async function bootChecks() {
  console.log('==> bootstrap');
  {
    // v0.24.1: a weak signal can hold the first answer for seconds — the page
    // must say it is opening, not sit blank.
    const w = boot({ answers: ['full'], store: { tg_token: 'tok-1' } });
    const shownAtOnce = w.waiting();
    await ticks();
    ck('while the trip loads the page says "Opening the trip…" (never a blank page), and it goes away once the app starts',
      !!shownAtOnce && /Opening the trip/.test(shownAtOnce.textContent) && w.started() && !w.waiting());
    const u = boot({ answers: ['fail', 'fail'] });
    await ticks();
    ck('…and when the trip can\'t be reached, "Try again" replaces it', !!u.alert() && !u.waiting());
  }
  let o = boot({ answers: ['full'], onLine: false, store: { tg_token: 'tok-1', tg_trip_cache: JSON.stringify({ trip: { title: 'Saved Title' }, family: [], days: [] }) } });
  ck('phone knows it is offline + saved copy: opens the saved trip at once, no network wait', o.calls.length === 0 && o.started() && (o.trip() || {}).trip.title === 'Saved Title' && !o.waiting());
  let threw = '';
  try {
    o = boot({ answers: ['full'], onLine: false, parsing: true, store: { tg_token: 'tok-1', tg_trip_cache: JSON.stringify({ trip: { title: 'Saved Title' }, family: [], days: [] }) } });
  } catch (e) { threw = e.message; }
  const early = !threw && o.started();
  if (!threw) o.parsed();
  ck('…even while the page is still being read: the app starts once parsing finishes, not before (no crash)' + (threw ? ' [' + threw + ']' : ''),
    !threw && !early && o.started());
  o = boot({ answers: ['full'], onLine: false, store: { tg_token: 'tok-1' } });
  ck('phone knows it is offline, nothing saved: says "No signal" at once, no network wait, no sample', o.calls.length === 0 && !o.started() && /No signal/.test(alertText(o.alert())));
  o = boot({ answers: ['full'], onLine: false, store: { tg_signed_out: '1' } });
  ck('signed out and offline: says you are signed out, at once', o.calls.length === 0 && !o.started() && /signed out/.test(alertText(o.alert())));
  let b = boot({ answers: ['summary'], store: { tg_trip_cache: '{"trip":{}}', tg_data_cache: '{}' } });
  await ticks();
  const sh = b.trip() || {};
  ck('anonymous: summary becomes a shell (flagged, plan emptied, names from the summary)',
    sh.__shell === true && Array.isArray(sh.days) && sh.days.length === 0 && (sh.family || []).map(f => f.name).join() === 'Pat' && sh.trip.title === 'Summary Title');
  ck('anonymous: no token header sent; saved trip and lists removed; app started',
    !(b.calls[0].opts.headers || {})['X-Auth-Token'] && !('tg_trip_cache' in b.ls) && !('tg_data_cache' in b.ls) && b.started());

  b = boot({ answers: ['full'], store: { tg_token: 'tok-1' } });
  await ticks();
  ck('signed in: token sent, full trip adopted and saved for offline, app started',
    (b.calls[0].opts.headers || {})['X-Auth-Token'] === 'tok-1' && (b.trip() || {}).trip.title === 'Full Title' &&
    JSON.parse(b.ls.tg_trip_cache || '{}').trip.title === 'Full Title' && b.started());

  b = boot({ answers: ['fail'], store: { tg_token: 'tok-1', tg_trip_cache: JSON.stringify({ trip: { title: 'Saved Title' }, family: [], days: [] }) } });
  await ticks();
  ck('no signal, saved copy: the saved trip opens after one try (3 s cap)',
    (b.trip() || {}).trip.title === 'Saved Title' && b.started() && b.calls.length === 1 && b.timers[0] === 3000);

  b = boot({ answers: ['fail', 'full'], store: { tg_token: 'tok-1' } });
  await ticks();
  ck('slow signal right after sign-in (nothing saved): a patient 12 s retry, then the real trip — not the sample',
    b.calls.length === 2 && b.timers.join() === '3000,12000' && (b.trip() || {}).trip.title === 'Full Title' && b.started());

  b = boot({ answers: ['fail', 'fail'], store: { tg_token: 'tok-1' } });
  await ticks();
  ck('signed in, trip unreachable twice: "taking too long" + Try again, and the app (with the sample) does NOT start',
    !b.started() && /taking too long/.test(alertText(b.alert())) && /Try again/.test(alertText(b.alert())));

  b = boot({ answers: ['fail', 'fail'] });
  await ticks();
  ck('anonymous, unreachable twice: "Can\'t reach the trip" + Try again, no sample',
    !b.started() && /Can't reach the trip/.test(alertText(b.alert())));

  b = boot({ answers: ['html', 'html'], store: { tg_token: 'tok-1' } });
  await ticks();
  ck('a 200 that is not a trip (hotel wi-fi page) counts as unreachable — no sample, nothing saved',
    !b.started() && !!b.alert() && !('tg_trip_cache' in b.ls));

  b = boot({ answers: ['404'], store: { tg_token: 'tok-1' } });
  await ticks();
  ck('no trip on the server (404): "isn\'t set up yet — ask the trip organizer", no retry, no sample',
    !b.started() && /isn't set up yet/.test(alertText(b.alert())) && b.calls.length === 1);

  b = boot({ answers: ['fail', 'fail'], store: { tg_signed_out: '1' } });
  await ticks();
  ck('signed out, then no signal: the screen says you are signed out', !b.started() && /signed out/.test(alertText(b.alert())));

  b = boot({ answers: ['fail'], protocol: 'file:' });
  await ticks();
  ck('opened as a plain file: the built-in sample still shows', b.started() && (b.trip() || {}).trip.title === SAMPLE_TRIP.trip.title && b.calls.length === 1);
}

// ── login + outbox: the real app script, loaded by the render harness as a shell ──
async function loginChecks() {
  console.log('==> sign-in (app loaded as a sign-in shell)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-rehearsal-'));
  const shellFile = path.join(tmp, 'shell.json');
  fs.writeFileSync(shellFile, JSON.stringify({
    __shell: true, trip: Object.assign({}, SAMPLE_TRIP.trip, { photosUrl: '' }),
    family: SAMPLE_TRIP.family.map(f => ({ name: f.name, color: f.color })), categories: SAMPLE_TRIP.categories || {},
    days: [], dayCoords: {}, flights: [], reservationsSeed: [], essentials: [], embassies: [], enrichments: {}, mustDos: []
  }));
  const argv = process.argv;
  process.argv = [argv[0], path.join(__dirname, 'render-harness.js'), shellFile, ROOT];
  let H;
  try { H = require('./render-harness.js'); } finally { process.argv = argv; fs.rmSync(tmp, { recursive: true, force: true }); }
  const { sandbox, X, React, text } = H;
  const ls = sandbox.localStorage;
  let reloads = 0;
  sandbox.window.location.reload = () => { reloads++; };
  const ss = {};
  sandbox.sessionStorage = { getItem: k => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); }, removeItem: k => { delete ss[k]; } };
  const realSet = ls.setItem, realGet = ls.getItem;
  const block = on => { if (on) { ls.setItem = () => { throw new Error('SecurityError'); }; ls.getItem = () => null; } else { ls.setItem = realSet; ls.getItem = realGet; } };
  const reset = () => { ['tg_name', 'tg_token', 'tg_outbox'].forEach(k => ls.removeItem(k)); };

  ck('app loads as a shell', X.TRIP_IS_SHELL === true);
  const loginNode = typeof X.App === 'function' ? X.App() : null;
  const onLogin = loginNode && loginNode.props && loginNode.props.onLogin;
  ck('the shell renders the sign-in screen with an onLogin handler', typeof onLogin === 'function');
  if (typeof onLogin === 'function') {
    reset(); reloads = 0;
    onLogin('Alex', 'tok-a');
    ck('PIN sign-in (storage works): token saved and the page reloads once for the full trip', ls.getItem('tg_token') === 'tok-a' && reloads === 1);
    ck('…the one-reload mark is a fingerprint, not the token', !!ss.tg_signin_reload && ss.tg_signin_reload.indexOf('tok-a') < 0);
    onLogin('Alex', 'tok-a');
    ck('…a second sign-in with the same token does not reload again', reloads === 1);
    reset(); reloads = 0; block(true);
    try { onLogin('Alex', 'tok-b'); } catch (e) {}
    block(false);
    ck('PIN sign-in with storage blocked: no reload (it would lose the sign-in)', reloads === 0);
  }
  if (typeof X.Login === 'function') {
    const on = text(X.Login({ onLogin() {}, storageBlocked: true }));
    const off = text(X.Login({ onLogin() {} }));
    ck('storage blocked: the sign-in screen says so; otherwise it does not', /blocking site storage/.test(on) && !/blocking site storage/.test(off));
    React.__stateOverrides = [{ init: 'name', value: 'pin' }, { init: null, value: 'Alex' }, { init: [], value: ['Alex'] }, { init: 0, value: Date.now() + 600000 }];
    const lk = text(X.Login({ onLogin() {} }));
    React.__stateOverrides = [];
    ck('forgot-PIN line names the trip organizer and shows during a lockout', /Ask the trip organizer/.test(lk) && /Forgot your PIN/.test(lk));
  }

  // portal (SSO) sign-in: the mount effect adopts a token from /api/sso
  const sso = async blocked => {
    reset(); reloads = 0;
    sandbox.fetch = url => String(url).includes('/api/sso')
      ? Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, token: 'sso-' + (blocked ? 'b' : 'ok'), name: 'Alex' }) })
      : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    block(blocked);
    React.__runEffects = true;
    try { X.App(); } catch (e) {}
    React.__runEffects = false;
    await ticks();
    block(false);
    return reloads;
  };
  ck('portal sign-in (storage works): reloads once', (await sso(false)) === 1);
  ck('portal sign-in with storage blocked: no reload — the old endless loop', (await sso(true)) === 0);
  {
    reset(); reloads = 0; ls.setItem('tg_signed_out', '1');
    let ssoCalls = 0;
    sandbox.fetch = url => { if (String(url).includes('/api/sso')) ssoCalls++; return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, token: 'sso-again', name: 'Alex' }) }); };
    React.__runEffects = true;
    let node = null;
    try { node = X.App(); } catch (e) {}
    React.__runEffects = false;
    await ticks();
    ck('after a sign-out here, the portal is not asked to sign anyone in (no /api/sso, no reload)', ssoCalls === 0 && reloads === 0 && ls.getItem('tg_token') === null);
    const onPortal = node && node.props && node.props.onPortal;
    const lt = typeof X.Login === 'function' ? text(X.Login({ onLogin() {}, onPortal: () => {} })) : '';
    ck('…the sign-in screen offers "Continue with the family portal"', typeof onPortal === 'function' && /Continue with the family portal/.test(lt));
    if (typeof onPortal === 'function') onPortal();
    ck('…which clears the pause and reloads', ls.getItem('tg_signed_out') === null && reloads === 1);
    ls.setItem('tg_signed_out', '1');
    if (typeof onLogin === 'function') onLogin('Sam', 'tok-pin');
    ck('a PIN sign-in also clears the pause', ls.getItem('tg_signed_out') === null);
  }

  if (typeof X.WeatherChip === 'function') {
    const d = new Date(); d.setDate(d.getDate() + 2);
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let wx = 0;
    sandbox.fetch = url => { if (/open-meteo/.test(String(url))) wx++; return Promise.resolve({ ok: false, json: () => Promise.resolve({}) }); };
    sandbox.navigator.onLine = false;
    React.__runEffects = true;
    try { X.WeatherChip({ ll: [40, -90], date: ymd }); } catch (e) {}
    React.__runEffects = false;
    sandbox.navigator.onLine = true;
    React.__stateOverrides = [{ init: { loading: true }, value: { offline: true } }];
    let wt = '';
    try { wt = text(X.WeatherChip({ ll: [40, -90], date: ymd })); } catch (e) {}
    React.__stateOverrides = [];
    ck('offline: the weather card makes no forecast call and says "Forecast needs signal."', wx === 0 && /Forecast needs signal/.test(wt));
  } else ck('WeatherChip exists', false);

  console.log('==> outbox');
  const seed = items => ls.setItem('tg_outbox', JSON.stringify(items));
  const q = () => JSON.parse(ls.getItem('tg_outbox') || '[]');
  const item = (n, id) => Object.assign({ u: '/api/notes', o: { method: 'POST', headers: { 'X-Op-Id': id, 'X-Auth-Token': 'old' } } }, n ? { n } : {});
  if (typeof X.obRestampToken === 'function') {
    seed([item('Alex', 'op-1'), item('Sam', 'op-2'), item(null, 'op-3')]);
    X.obRestampToken('new-tok', 'Sam');
    const left = q();
    ck('another traveler signing in drops the first one\'s queued writes; theirs and untagged are restamped',
      left.map(i => i.o.headers['X-Op-Id']).join() === 'op-2,op-3' && left.every(i => i.o.headers['X-Auth-Token'] === 'new-tok'));
    seed([item('Alex', 'op-1')]);
    X.obRestampToken('new-tok', 'Alex');
    ck('the same traveler signing back in keeps and restamps their writes', q().length === 1 && q()[0].o.headers['X-Auth-Token'] === 'new-tok');
  } else ck('obRestampToken exists', false);
  if (typeof X.flushOutbox === 'function') {
    seed([{ u: '/gone', o: { method: 'POST', headers: {} } }, { u: '/ok', o: { method: 'POST', headers: {} } }, { u: '/busy', o: { method: 'POST', headers: {} } }]);
    sandbox.fetch = url => Promise.resolve({ ok: url === '/ok', status: url === '/gone' ? 404 : url === '/ok' ? 200 : 503 });
    const sent = await X.flushOutbox();
    ck('flush: a write refused for good (404) is dropped, a server hiccup (503) is kept for later', sent === 1 && q().map(i => i.u).join() === '/busy');
  } else ck('flushOutbox exists', false);
  if (typeof X.qfetch === 'function') {
    reset(); ls.setItem('tg_name', 'Sam'); ls.setItem('tg_token', 'tok-s');
    sandbox.fetch = () => Promise.reject(new Error('offline'));
    await X.qfetch('/api/notes', { method: 'POST', body: '{}' });
    const last = q()[q().length - 1] || {};
    ck('a write queued offline records who made it', last.n === 'Sam');
  } else ck('qfetch exists', false);
  reset();
}

// ── logout: the real app script with the full (non-shell) trip, in a child ────
// One process loads the app against one trip, so the signed-in checks run in a
// child (BOOT_CHILD=logout) and report back as JSON.
async function logoutChild() {
  const argv = process.argv;
  process.argv = [argv[0], path.join(__dirname, 'render-harness.js'), '--', ROOT];
  const { sandbox, X, React } = require('./render-harness.js');
  process.argv = argv;
  const ls = sandbox.localStorage, out = {};
  let reloads = 0, asked = '';
  sandbox.window.location.reload = () => { reloads++; };
  const ss = { tg_signin_reload: 'x' };
  sandbox.sessionStorage = { getItem: k => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); }, removeItem: k => { delete ss[k]; } };
  const calls = [];
  sandbox.fetch = (url, o) => { calls.push({ url: String(url), o: o || {} }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); };
  const setup = () => {
    ls.setItem('tg_name', 'Alex'); ls.setItem('tg_token', 'tok-l'); ls.setItem('tg_trip_cache', '{"trip":{}}');
    ls.setItem('tg_data_cache', '{"user":"Alex"}'); ls.removeItem('tg_signed_out');
    ls.setItem('tg_outbox', JSON.stringify([{ u: '/api/notes', o: {}, n: 'Alex' }, { u: '/api/notes', o: {}, n: 'Sam' }]));
  };
  const findLogout = () => {
    React.__forceOpen = true; React.__stateOverrides = [{ init: null, value: 'Alex' }];
    let app = null; try { app = X.App(); } catch (e) { out.err = e.message; }
    React.__forceOpen = false; React.__stateOverrides = [];
    let fn = null;
    (function w(n) { if (!n || typeof n !== 'object' || fn) return; if (Array.isArray(n)) return n.forEach(w);
      if (n.props && typeof n.props.onClick === 'function' && /logout/.test(JSON.stringify(n.children || []))) fn = n.props.onClick;
      (n.children || []).forEach(w); })(app);
    return fn;
  };
  setup();
  const logout = findLogout();
  out.found = typeof logout === 'function';
  if (out.found) {
    sandbox.window.confirm = m => { asked = m; return false; };
    logout();
    out.cancelKeeps = ls.getItem('tg_token') === 'tok-l' && JSON.parse(ls.getItem('tg_outbox')).length === 2 && reloads === 0;
    out.askedOne = /^1 change/.test(asked);
    sandbox.window.confirm = () => true;
    logout();
    await new Promise(r => setImmediate(r));
    out.cleared = ['tg_name', 'tg_token', 'tg_trip_cache', 'tg_data_cache'].every(k => ls.getItem(k) === null) && !('tg_signin_reload' in ss);
    out.outboxEmpty = JSON.parse(ls.getItem('tg_outbox') || '[]').length === 0;
    out.paused = ls.getItem('tg_signed_out') === '1';
    out.reloaded = reloads === 1;
    const rv = calls.find(c => c.url.endsWith('/api/logout'));
    out.revoked = !!rv && rv.o.method === 'POST' && (rv.o.headers || {})['X-Auth-Token'] === 'tok-l';
  }
  process.stdout.write(JSON.stringify(out));
}
function logoutChecks() {
  console.log('==> sign-out (app loaded with the full trip)');
  const r = require('child_process').spawnSync(process.execPath, [__filename, ROOT], { env: Object.assign({}, process.env, { BOOT_CHILD: 'logout' }), encoding: 'utf8', timeout: 60000 });
  let o = {};
  try { o = JSON.parse(r.stdout); } catch (e) { o = { err: 'child: ' + (r.stderr || r.stdout || '').slice(0, 200) }; }
  ck('the Sign-out button is found' + (o.err ? ' [' + o.err + ']' : ''), o.found === true);
  ck('sign-out with an unsent change asks first (counting only this traveler\'s), and "Cancel" keeps everything', o.askedOne === true && o.cancelKeeps === true);
  ck('confirmed sign-out removes the session, the saved trip, the lists and the reload mark', o.cleared === true);
  ck('…discards the queued changes, pauses portal sign-in, and reloads into the sign-in shell', o.outboxEmpty === true && o.paused === true && o.reloaded === true);
  ck('…and revokes the token on the server (POST /api/logout with it)', o.revoked === true);
}

// ── service worker ───────────────────────────────────────────────────────────
async function swChecks() {
  console.log('==> service worker');
  const SW = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const ORIGIN = 'https://trip.test';
  const store = {}; // cacheName -> { path: response }
  const keyOf = k => (typeof k === 'string' ? new URL(k, ORIGIN).pathname : new URL(k.url, ORIGIN).pathname);
  const caches = {
    open: async n => {
      store[n] = store[n] || {};
      const c = store[n];
      return { put: async (k, r) => { c[keyOf(k)] = r; }, match: async k => c[keyOf(k)], addAll: async () => {} };
    },
    match: async k => { for (const n of Object.keys(store)) if (store[n][keyOf(k)]) return store[n][keyOf(k)]; return undefined; },
    keys: async () => Object.keys(store), delete: async n => { delete store[n]; }
  };
  const res = (body, type = 'text/html') => ({ ok: true, status: 200, body, headers: { get: k => (k.toLowerCase() === 'content-type' ? type : null) }, clone() { return this; } });
  const ERR = { error: true };
  const handlers = {};
  let net = () => Promise.reject(new Error('offline'));
  const timers = [];
  const ctx = {
    self: { addEventListener: (t, fn) => { handlers[t] = fn; }, location: { origin: ORIGIN }, skipWaiting() {}, clients: { claim() {} } },
    caches, fetch: r => net(r), Response: { error: () => ERR }, URL, Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = () => {}; }
  };
  vm.createContext(ctx);
  vm.runInContext(SW, ctx, { filename: 'sw.js' });
  // waitUntil is only legal while the event is being dispatched (or while an
  // earlier extension is pending) — like a real worker, throw otherwise.
  const fire = (p, mode = 'no-cors', method = 'GET') => {
    const e = { request: { method, url: ORIGIN + p, mode }, answered: null, live: true, extended: [], respondWith(x) { this.answered = x; },
      waitUntil(x) { if (!this.live) throw new Error('InvalidStateError'); this.extended.push(x); } };
    handlers.fetch(e);
    e.live = false;
    return e;
  };
  const SHELL = Object.keys(store)[0];
  ck('sw: GET /api/notes is left to the network', fire('/api/notes').answered === null);
  ck('sw: admin.html is left to the network', fire('/admin.html', 'navigate').answered === null);
  ck('sw: any other page (/other) is left to the network', fire('/other', 'navigate').answered === null);

  net = () => Promise.resolve(res('PAGE-V2'));
  let r = await fire('/', 'navigate').answered; await ticks();
  const saved = await caches.match('/');
  ck('sw: online, the page comes from the network and a copy is saved', r && r.body === 'PAGE-V2' && saved && saved.body === 'PAGE-V2');

  net = () => Promise.resolve(res('{"not":"html"}', 'application/json'));
  r = await fire('/', 'navigate').answered; await ticks();
  ck('sw: a non-HTML answer for the page is passed on but never saved', r.body === '{"not":"html"}' && (await caches.match('/')).body === 'PAGE-V2');

  net = () => Promise.reject(new Error('offline'));
  r = await fire('/', 'navigate').answered;
  ck('sw: offline, the saved page answers', r && r.body === 'PAGE-V2');

  net = () => new Promise(() => {}); // a signal too weak to ever answer
  timers.length = 0;
  let settled = null;
  fire('/', 'navigate').answered.then(x => { settled = x; });
  await ticks();
  const early = settled;
  const cap = timers.find(t => t.ms === 4000);
  if (cap) cap.fn();
  await ticks();
  ck('sw: a hanging network is capped at 4 s — then the saved page answers', early === null && !!cap && settled && settled.body === 'PAGE-V2');

  let late;
  net = () => new Promise(r => { late = r; }); // answers only after the cap
  timers.length = 0;
  const ev = fire('/', 'navigate');
  const cap2 = timers.find(t => t.ms === 4000);
  if (cap2) cap2.fn();
  const first = await Promise.race([ev.answered, new Promise(r => setTimeout(() => r(null), 500))]) || {};
  late(res('PAGE-V3'));
  await Promise.all(ev.extended).catch(() => {});
  await ticks();
  ck('sw: …and when the network answers after the cap, the saved page is still refreshed', first.body === 'PAGE-V2' && (await caches.match('/')).body === 'PAGE-V3' && ev.extended.length > 0);

  for (const n of Object.keys(store)) delete store[n];
  net = () => Promise.reject(new Error('offline'));
  r = await fire('/', 'navigate').answered;
  ck('sw: offline with nothing saved → a network error (the browser\'s own offline page)', r === ERR);
  void SHELL;
}

(async () => {
  if (process.env.BOOT_CHILD === 'logout') { await logoutChild(); process.exit(0); }
  console.log('root      ' + ROOT);
  try { await bootChecks(); } catch (e) { ck('bootstrap checks ran without an exception (' + e.message + ')', false); }
  try { await loginChecks(); } catch (e) { ck('sign-in checks ran without an exception (' + e.message + ')', false); }
  try { logoutChecks(); } catch (e) { ck('sign-out checks ran without an exception (' + e.message + ')', false); }
  try { await swChecks(); } catch (e) { ck('service-worker checks ran without an exception (' + e.message + ')', false); }
  console.log('RESULT: ' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
