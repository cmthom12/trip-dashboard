/*
 * tools/render-harness.js — render public/index.html's front end in Node, so UI
 * behaviour can be asserted without a browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * public/index.html is a compiled single-file artifact: no JSX, no bundler, no
 * test runner (see CLAUDE.md). But the whole app lives in one
 * <script type="text/plain" id="trip-main"> block, so it can be lifted out and
 * run in a Node `vm` against stub globals. That is all this is — a loader plus
 * a fake React and a fake Leaflet. It is a development tool: nothing here ships
 * to end users and nothing runs it automatically.
 *
 * USAGE
 * -----
 *   node tools/render-harness.js                  # smoke test, inline sample trip
 *   node tools/render-harness.js my-trip.json     # against another trip
 *
 * As a library, from a test script:
 *
 *   // argv[2] = trip JSON to render ("--" or omitted = the inline sample)
 *   // argv[3] = repo root          (defaults to this file's parent, or $TRIP_REPO)
 *   const { X, React, LOG, text, nodes } = require('<repo>/tools/render-harness.js');
 *
 *   const tree = X.DayPlanCard({ day: X.DAYS[0], schedule: [], user: 'Alex', … });
 *   console.log(text(tree));          // all the strings the component rendered
 *
 * The app script is evaluated ONCE per process against ONE trip, so a suite
 * that needs several trips must spawn a child process per trip.
 *
 * WHAT `X` HOLDS
 * --------------
 * Top-level names lifted out of the app script: components (TripMap,
 * DayPlanCard, MustDoSection, …) and constants (TRIP, DAYS, FAMILY,
 * MUSTDO_ITEMS, …). A name the current index.html does not define comes back
 * `undefined` rather than throwing, so the same test can run against a checkout
 * from before a feature existed. Add names to CAPTURE below as you need them.
 *
 * THE HOOK STUBS ARE DELIBERATELY DUMB
 * ------------------------------------
 * useState returns its initial value and the setter is a no-op, so a "render"
 * is one pass with no re-render. That is enough to assert what a component puts
 * on screen for a given input, and it is why the override knobs below exist: a
 * collapsed section's contents, or a map filtered to one day, are otherwise
 * unreachable with no-op setters.
 *
 *   React.__forceOpen = true          // every useState(false) starts true
 *   React.__forceItem = 'md_x'        // every useState(null) starts at this value
 *   React.__emptyStrQueue = ['a','b'] // consumed by useState('') in call order
 *   React.__stateOverrides = [{ init: 'all', value: 'day2' }]
 *                                     // general form: first useState whose
 *                                     // initial value deep-equals `init` gets
 *                                     // `value` instead. Consumed in call order,
 *                                     // one entry per match.
 *   React.__runEffects = true         // run useEffect bodies (mount effects)
 *   React.__effectErrors              // messages from effects that threw
 *
 * WHAT `LOG` RECORDS (the fake Leaflet)
 * -------------------------------------
 *   LOG.markers   every marker built, with `.ll`, `.icon0` (the icon it was
 *                 BUILT with — this is what carries the pin colour) and `.icon`
 *                 (after any later setIcon, e.g. the interest overlay re-icon).
 *   LOG.hidden    markers the day filter removed from the map, in order.
 *   LOG.polylines how many route lines were drawn.
 * Assert colours against the icon HTML, e.g. /#7C3AED/.test(m.icon0.html).
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = process.argv[3] || process.env.TRIP_REPO || path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Names lifted out of the app script into `X`. Missing ones come back undefined.
const CAPTURE = ['TRIP', 'DAYS', 'FAMILY', 'CAT', 'PLANNERS',
  'MUSTDO_GROUPS', 'MUSTDO_ITEMS', 'MUSTDO_BY_ID', 'HAS_MUSTDOS',
  'App', 'Countdown', 'DayPlanCard', 'DayStrip', 'FlightCard', 'IntChips', 'Login',
  'MissionCard', 'MustDoSection', 'PhraseCard', 'PrintItinerary', 'ReviewTab',
  'StarRow', 'TripMap', 'WeatherChip',
  'DietaryNote', 'dietaryFor', 'myDietary',
  'safeHttpUrl', 'extLink', 'flushOutbox', 'OUTBOX_KEY',
  'safeColor', 'mapEsc', 'linkify', 'obRestampToken', 'qfetch'];

function block(tag, id) {
  const open = '<script type="' + tag + '" id="' + id + '">';
  const i = HTML.indexOf(open) + open.length;
  return HTML.slice(i, HTML.indexOf('</' + 'script>', i));
}
let tripJson = block('application/json', 'trip-data');
const override = process.argv[2];
if (override && override !== '--') tripJson = fs.readFileSync(override, 'utf8');
// Drop the real mount — the harness renders components itself.
const src = block('text/plain', 'trip-main').replace(/ReactDOM\.createRoot\([\s\S]*$/, '');

const el = {
  textContent: tripJson, style: {}, children: [], scrollLeft: 0, scrollWidth: 0, clientWidth: 0,
  addEventListener() {}, removeEventListener() {}, appendChild() {}, scrollIntoView() {}, scrollTo() {},
  querySelector: () => el, querySelectorAll: () => [], focus() {}, blur() {},
  getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 })
};

// ── fake React: createElement records a tree; hooks return their initial value ──
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const React = {
  createElement(type, props, ...kids) {
    return { type, props: props || {}, children: kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false && k !== true) };
  },
  // The app destructures the hooks once at load, so every knob must be consulted
  // at CALL time, not at definition time.
  useState: init => {
    const oi = React.__stateOverrides.findIndex(o => deepEq(o.init, init));
    if (oi >= 0) return [React.__stateOverrides.splice(oi, 1)[0].value, () => {}];
    if (React.__forceOpen && init === false) return [true, () => {}];
    if (React.__forceItem !== null && init === null) return [React.__forceItem, () => {}];
    if (init === '' && React.__emptyStrQueue.length) return [React.__emptyStrQueue.shift(), () => {}];
    return [typeof init === 'function' ? init() : init, () => {}];
  },
  __stateOverrides: [],
  __forceItem: null,
  __emptyStrQueue: [],
  __forceOpen: false,
  useEffect: fn => { if (React.__runEffects) { try { fn(); } catch (e) { React.__effectErrors.push(e.message); } } },
  __runEffects: false,
  __effectErrors: [],
  useCallback: fn => fn,
  // useRef(null) is how the app holds a DOM node it has not attached yet; hand
  // back the fake element so effects that bail on `!ref.current` still run.
  useRef: v => ({ current: v === null ? el : v }),
  Fragment: 'Fragment'
};

const store = {};
const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
const document = {
  getElementById: () => el,
  createElement: () => el, querySelector: () => el, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, body: el, documentElement: el
};
const window = { localStorage, document, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }), location: { href: '', origin: '' }, print() {} };
window.window = window;

// ── minimal Leaflet: records every marker built (with the icon html that carries
// the pin colour) and every marker the day filter hides, so map behaviour is
// observable from Node.
const LOG = { markers: [], hidden: [], polylines: 0, popups: [] };
// bindPopup/setPopupContent record their HTML: popup markup is built by a
// closure inside TripMap's effect and is unreachable from `X`, so the only way
// to assert on it is to capture what the map was handed.
const layerish = () => ({ addTo() { return this; }, bindPopup(h) { this.popup = h; if (typeof h === 'string') LOG.popups.push(h); return this; }, on() { return this; }, setIcon(i) { this.icon = i; return this; }, setPopupContent(h) { this.popup = h; if (typeof h === 'string') LOG.popups.push(h); return this; }, getLatLng: () => ({ distanceTo: () => 0 }), remove() {}, clearLayers() {}, openPopup() {} });
window.L = {
  map: () => Object.assign(layerish(), {
    setView() {}, fitBounds() {}, flyTo() {}, once() {}, invalidateSize() {},
    // hasLayer is always true, so the day filter's setOn() only ever calls
    // removeLayer — which is exactly the signal LOG.hidden wants.
    hasLayer: () => true, addLayer() {}, removeLayer(mk) { LOG.hidden.push(mk); },
    getZoom: () => 10, getCenter: () => ({ distanceTo: () => 0 })
  }),
  tileLayer: () => layerish(),
  divIcon: o => ({ html: o.html, className: o.className }),
  marker: (ll, opt) => { const m = Object.assign(layerish(), { ll, icon: opt && opt.icon, icon0: opt && opt.icon }); LOG.markers.push(m); return m; },
  polyline: () => { LOG.polylines++; return layerish(); },
  layerGroup: () => layerish(),
  latLngBounds: pts => ({ pts })
};

const sandbox = {
  React, ReactDOM: { createRoot: () => ({ render() {} }), createPortal: a => a },
  document, window, localStorage, navigator: { onLine: true, userAgent: 'node', clipboard: { writeText: () => Promise.resolve() } },
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  setTimeout, clearTimeout, setInterval, clearInterval, console, Intl, JSON, Math, Date,
  encodeURIComponent, decodeURIComponent, isFinite, parseInt, parseFloat, URL, Blob: class {}, alert() {}, confirm: () => true
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
const epilogue = ';globalThis.__X = {};' +
  CAPTURE.map(n => 'try { globalThis.__X.' + n + ' = ' + n + '; } catch (e) { globalThis.__X.' + n + ' = undefined; }').join('');
vm.runInContext(src + '\n' + epilogue, sandbox, { filename: 'trip-main.js' });

// ── walk helpers ─────────────────────────────────────────────────────────────
function walk(node, out) {
  out = out || [];
  if (!node || typeof node !== 'object') { if (typeof node === 'string' || typeof node === 'number') out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return out; }
  out.push({ __node: node.type });
  (node.children || []).forEach(k => walk(k, out));
  return out;
}
/** Every string the tree rendered, concatenated — the usual thing to assert on. */
const text = node => walk(node).filter(x => typeof x === 'string').join('');
/** Every element in the tree, as {__node: type}. */
const nodes = node => walk(node).filter(x => x && x.__node);
/** Every value of `props.<key>` in the tree (e.g. props('id') for DOM ids). */
function props(node, key, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => props(n, key, out)); return out; }
  if (node.props && node.props[key] !== undefined) out.push(node.props[key]);
  (node.children || []).forEach(k => props(k, key, out));
  return out;
}

module.exports = { sandbox, X: sandbox.__X, React, LOG, text, nodes, walk, props, ROOT };

// ── child mode: render the map for the given trip and emit the popup HTML ────
// The app script is evaluated once per process against one trip, so the
// escaping check below runs its poisoned trip in a child and reads the popups
// back here. TRIP_LIVE_ROWS (JSON) is served as the /api/locations response so
// the live-location layer draws too; its pin icons come back as `live`.
if (require.main === module && process.env.TRIP_EMIT_POPUPS === '1') {
  const liveRows = process.env.TRIP_LIVE_ROWS ? JSON.parse(process.env.TRIP_LIVE_ROWS) : null;
  if (liveRows) {
    sandbox.localStorage.setItem('tg_token', 'harness-token'); // the live layer only polls when signed in
    sandbox.fetch = url => String(url).includes('/api/locations')
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(liveRows) })
      : Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }
  React.__runEffects = true;
  if (sandbox.__X.TripMap) sandbox.__X.TripMap({ focus: null, interests: {}, user: (sandbox.__X.FAMILY || [])[0], schedule: [] });
  React.__runEffects = false;
  setTimeout(() => { // let the live layer's fetch().then(draw) settle
    const live = LOG.markers.filter(m => m.icon0 && m.icon0.className === 'tm-live').map(m => m.icon0.html);
    process.stdout.write(JSON.stringify({ popups: LOG.popups, live }));
    process.exit(0);
  }, 50);
}

if (require.main === module && process.env.TRIP_EMIT_POPUPS !== '1') {
  const X = sandbox.__X;
  console.log('root      ' + ROOT);
  console.log('trip      ' + (X.TRIP && X.TRIP.trip && X.TRIP.trip.title));
  console.log('days      ' + (X.DAYS || []).length +
    ' (' + (X.DAYS || []).map(d => (d.activities || []).length).join('/') + ' activities)');
  console.log('must-dos  ' + (X.HAS_MUSTDOS ? (X.MUSTDO_ITEMS.length + ' across ' + X.MUSTDO_GROUPS.length + ' group(s)') : 'none'));
  React.__runEffects = true;
  if (X.TripMap) X.TripMap({ focus: null, interests: {}, user: (X.FAMILY || [])[0], schedule: [] });
  React.__runEffects = false;
  console.log('map pins  ' + LOG.markers.length + ' marker(s), ' + LOG.polylines + ' route line(s)');
  console.log(React.__effectErrors.length ? 'effect errors: ' + React.__effectErrors.join(' | ') : 'no effect errors');

  // ── checks ────────────────────────────────────────────────────────────────
  // Regression guards for the write-integrity round: popup escaping (H4),
  // href scheme filtering (M5) and outbox survival on session loss (H5). Each
  // one failed against the code as it stood before those fixes.
  let pass = 0, fail = 0;
  const ck = (label, ok) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label); };
  console.log('');

  // H4 — trip-data text must not reach popup HTML unescaped. Rendered in a
  // child process because one process renders one trip.
  const os = require('os'), cp = require('child_process');
  const poisoned = JSON.parse(JSON.stringify(X.TRIP));
  const PAYLOAD = '<b>PWNED</b>';
  const ESCAPED = 'bPWNED/b';          // what the strip-based esc leaves behind
  let injected = false;
  for (const d of (poisoned.days || [])) {
    d.label = PAYLOAD + ' label';
    d.location = PAYLOAD + ' location';
    for (const a of (d.activities || [])) {
      if (!Array.isArray(a.ll)) continue;
      a.name = PAYLOAD + ' name';
      a.desc = PAYLOAD + ' desc';      // desc is what feeds the popup's note
      injected = true;
    }
  }
  ck('poisoned trip built (an activity with coordinates carries the payload)', injected);

  // H4.1 — the live-location pin is a second raw-HTML sink: family[].color
  // is concatenated into its style attribute and the name's initial into its
  // text. Poison both on family[0] and have that person "share" a location.
  const CSS_PAYLOAD = 'red;background:url(javascript:1)';
  const famZero = (poisoned.family || [])[0];
  if (famZero) { famZero.name = PAYLOAD + ' fam'; famZero.color = ['#fff', CSS_PAYLOAD]; }
  const famOne = (poisoned.family || [])[1] || null;
  const liveRows = famZero ? [{ name: famZero.name, lat: 1, lng: 1, agoS: 5, acc: 5 }] : [];
  if (famOne) liveRows.push({ name: famOne.name, lat: 2, lng: 2, agoS: 5, acc: 5 });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-harness-'));
  let popups = [], live = [];
  try {
    const tripFile = path.join(tmp, 'poisoned.json');
    fs.writeFileSync(tripFile, JSON.stringify(poisoned));
    const r = cp.spawnSync(process.execPath, [__filename, tripFile, ROOT], {
      env: Object.assign({}, process.env, { TRIP_EMIT_POPUPS: '1', TRIP_LIVE_ROWS: JSON.stringify(liveRows) }),
      encoding: 'utf8'
    });
    const out = r.status === 0 && r.stdout ? JSON.parse(r.stdout) : {};
    popups = Array.isArray(out) ? out : (out.popups || []);   // pre-H4.1 children emit a bare array
    live = Array.isArray(out) ? [] : (out.live || []);
  } catch (e) { popups = []; live = []; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }

  const joined = popups.join('\n');
  ck('map popups were rendered for the poisoned trip', popups.length > 0);
  // Both halves matter: the value must actually reach the popup (so the check
  // cannot pass by rendering nothing) AND must arrive stripped.
  ck('popup carries the trip-data text', joined.includes(ESCAPED));
  ck("popup contains no unescaped '<' originating from desc/name/label", !joined.includes(PAYLOAD) && !joined.includes('<b>PWNED'));

  const liveJoined = live.join('\n');
  ck('a live-location pin was rendered for the poisoned traveler', live.length > 0);
  ck('live pin style does not carry the injected colour payload', live.length > 0 && !liveJoined.includes('url(') && !liveJoined.includes(CSS_PAYLOAD));
  ck('live pin falls back to the neutral colour instead', live.length > 0 && liveJoined.includes('#0D2B4E'));
  // The poisoned initial is '<', which the strip-escape removes entirely; the
  // unpoisoned second traveler proves a legitimate initial still renders.
  ck("live pin initial contains no unescaped '<' from the traveler name", live.length > 0 && !liveJoined.includes('<b>') && !liveJoined.includes('><</div>'));
  ck('a legitimate traveler initial still renders on the live pin', famOne ? live.some(h => h.includes('>' + famOne.name.charAt(0) + '</div>')) : true);
  const sc = X.safeColor;
  ck('safeColor exists', typeof sc === 'function');
  if (typeof sc === 'function') {
    ck('safeColor passes #hex6', sc('#047857') === '#047857');
    ck('safeColor passes #hex3 and #hex8', sc('#fff') === '#fff' && sc('#12345678') === '#12345678');
    ck('safeColor passes rgba() with numeric args', sc('rgba(13, 43, 78, .4)') === 'rgba(13, 43, 78, .4)');
    ck('safeColor passes hsl() with percent args', sc('hsl(210 50% 40%)') === 'hsl(210 50% 40%)');
    ck('safeColor rejects a style-breaking value', sc(CSS_PAYLOAD) === '#0D2B4E');
    ck('safeColor rejects rgb() with a non-numeric arg', sc('rgb(1,2,x)') === '#0D2B4E');
    ck('safeColor rejects a named colour (not in the allowlist) and non-strings', sc('red') === '#0D2B4E' && sc(null) === '#0D2B4E');
  }

  // M5 — only http/https/mailto may become a live link.
  const su = X.safeHttpUrl;
  ck('safeHttpUrl exists', typeof su === 'function');
  if (typeof su === 'function') {
    ck('safeHttpUrl passes https', su('https://example.com') === 'https://example.com');
    ck('safeHttpUrl passes mailto', su('mailto:a@b.c') === 'mailto:a@b.c');
    ck('safeHttpUrl rejects javascript:', su('javascript:alert(1)') === null);
    ck('safeHttpUrl rejects data:', su('data:text/html,<b>') === null);
    ck('safeHttpUrl rejects a tab-smuggled scheme ("jav\\tascript:")', su('jav\tascript:alert(1)') === null);
    ck('safeHttpUrl rejects a newline-smuggled scheme', su('jav\nascript:alert(1)') === null);
  }
  // M5.1 — linkify() defers to safeHttpUrl rather than carrying its own scheme
  // rule. Proven by swapping safeHttpUrl for a stub: a linkify that consults it
  // stops linking; one with a private rule keeps linking regardless.
  const lk = X.linkify;
  ck('linkify exists', typeof lk === 'function');
  if (typeof lk === 'function') {
    const anchors = t => nodes(t).filter(n => n.__node === 'a').length;
    const hrefs = t => props(t, 'href');
    ck('linkify links an https URL', anchors(lk('see https://example.com now')) === 1 && hrefs(lk('see https://example.com now'))[0] === 'https://example.com');
    ck('linkify links a www. token as https', hrefs(lk('www.example.com'))[0] === 'https://www.example.com');
    ck('linkify never links a javascript: token', anchors(lk('javascript:alert(1)')) === 0);
    const realSafe = sandbox.safeHttpUrl;
    sandbox.safeHttpUrl = () => null;
    const stubbed = anchors(lk('see https://example.com now'));
    sandbox.safeHttpUrl = realSafe;
    ck('linkify routes its href through safeHttpUrl (stubbed to reject → no anchor)', stubbed === 0);
    ck('…and links again once the real safeHttpUrl is back', anchors(lk('https://example.com')) === 1);
  }
  const xl = X.extLink;
  ck('extLink exists', typeof xl === 'function');
  if (typeof xl === 'function') {
    const good = xl('https://example.com', { style: {} }, 'Book');
    ck('extLink renders a safe URL as an anchor', good.type === 'a' && good.props.href === 'https://example.com');
    const bad = xl('javascript:alert(1)', { style: {} }, 'Book');
    ck('a javascript: link renders as text, not an anchor', bad.type === 'span' && bad.props.href === undefined);
    ck('…and it keeps its label', text(bad).includes('Book'));
    const tabbed = xl('jav\tascript:alert(1)', { style: {} }, 'Book');
    ck('"jav\\tascript:" also renders as text, not an anchor', tabbed.type === 'span' && tabbed.props.href === undefined);
  }

  // H1.b — locked chrome: while the roster is locked the name list shows the
  // same neutral affordance for every name; unlocked keeps has-PIN / set-PIN.
  // The override for `false` lands on Login's first useState(false), which is
  // rosterLocked on this branch (and busy on older code — which then still
  // renders the claimed chrome, so the locked check fails there).
  if (typeof X.Login === 'function') {
    React.__stateOverrides = [{ init: [], value: ['Alex'] }];
    let lt = text(X.Login({ onLogin() {} }));
    ck('unlocked sign-in shows the claimed/unclaimed chrome (has PIN / set PIN)', lt.includes('has PIN') && lt.includes('set PIN'));
    React.__stateOverrides = [{ init: [], value: ['Alex'] }, { init: false, value: true }];
    lt = text(X.Login({ onLogin() {} }));
    ck('locked sign-in shows the same neutral "Enter PIN" for every name', lt.includes('Enter PIN') && !lt.includes('has PIN') && !lt.includes('set PIN'));
    React.__stateOverrides = [];
  } else ck('Login exists', false);

  // H5 / H5.1 — a flush that hits a dead session must put the queue back
  // untouched, whether or not a (stale) token is still stored; a login must
  // restamp every queued item with the new token; the replay then drains once.
  const KEY = X.OUTBOX_KEY || 'tg_outbox';
  const queued = [
    { u: '/api/notes', o: { method: 'POST', headers: { 'X-Op-Id': 'op-1', 'X-Auth-Token': 'stale-token' }, body: '{"message":"a"}' } },
    { u: '/api/interests', o: { method: 'POST', headers: { 'X-Op-Id': 'op-2', 'X-Auth-Token': 'stale-token' }, body: '{"activityId":"x"}' } },
    { u: '/api/packing', o: { method: 'POST', headers: { 'X-Op-Id': 'op-3', 'X-Auth-Token': 'stale-token' }, body: '{"item":"y"}' } }
  ];
  const seed = () => sandbox.localStorage.setItem(KEY, JSON.stringify(queued));
  const queue = () => JSON.parse(sandbox.localStorage.getItem(KEY) || '[]');
  const fail401 = () => { sandbox.fetch = () => Promise.resolve({ status: 401, ok: false, json: () => Promise.resolve({}) }); };
  const findNode = (node, pred) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const n of node) { const r = findNode(n, pred); if (r) return r; } return null; }
    if (pred(node)) return node;
    for (const k of (node.children || [])) { const r = findNode(k, pred); if (r) return r; }
    return null;
  };
  const runOutbox = async () => {
    if (typeof X.flushOutbox !== 'function') { ck('flushOutbox exists', false); return; }
    // (a) no token stored — the v0.21.0 case
    sandbox.localStorage.removeItem('tg_token');
    seed(); let before = sandbox.localStorage.getItem(KEY); fail401();
    let sent = await X.flushOutbox().catch(() => -1);
    ck('outbox flush with NO stored token leaves the queue intact', sandbox.localStorage.getItem(KEY) === before);
    ck('…all three queued writes survive, none reported sent', queue().length === 3 && sent === 0);
    // (a2) a DIRECT write (qfetch, not the outbox) that meets a 401 is queued,
    // not dropped, before the session is cleared.
    if (typeof X.qfetch === 'function') {
      sandbox.localStorage.setItem(KEY, '[]');
      sandbox.localStorage.setItem('tg_token', 'stale-token');
      fail401();
      await X.qfetch('/api/notes', { method: 'POST', body: '{"message":"direct"}' }).catch(() => null);
      const q = queue();
      ck('a direct write answered 401 is queued for replay (and the session cleared)',
        q.length === 1 && q[0].u === '/api/notes' && sandbox.localStorage.getItem('tg_token') === null);
    } else ck('qfetch exists', false);
    // (b) a STALE token is still stored and the server says 401 — the branch
    // the old test missed: the item and its whole tail must survive, byte-stable.
    sandbox.localStorage.setItem('tg_token', 'stale-token');
    seed(); before = sandbox.localStorage.getItem(KEY); fail401();
    sent = await X.flushOutbox().catch(() => -1);
    ck('outbox flush with a STALE stored token and a 401 leaves the queue byte-identical', sandbox.localStorage.getItem(KEY) === before);
    ck('…all three writes survive in order, none reported sent', queue().map(i => i.u).join() === queued.map(i => i.u).join() && sent === 0);
    // (c) re-login restamps every queued item: order and X-Op-Id untouched
    ck('obRestampToken exists', typeof X.obRestampToken === 'function');
    if (typeof X.obRestampToken === 'function') {
      const n = X.obRestampToken('fresh-token');
      const q = queue();
      ck('restamp rewrote every queued item (' + n + ' of 3)', n === 3 && q.every(i => i.o.headers['X-Auth-Token'] === 'fresh-token'));
      ck('…preserving replay order and each X-Op-Id', q.map(i => i.o.headers['X-Op-Id']).join() === 'op-1,op-2,op-3' && q.map(i => i.u).join() === queued.map(i => i.u).join());
    }
    // (d) through the real writers. PIN login: App renders <Login onLogin={doLogin}>.
    seed();
    let loginNode = null;
    try { loginNode = X.App && X.Login ? findNode(X.App(), n => n.type === X.Login) : null; } catch (e) { loginNode = null; }
    ck('App renders the Login screen with an onLogin handler', !!(loginNode && typeof loginNode.props.onLogin === 'function'));
    if (loginNode && typeof loginNode.props.onLogin === 'function') {
      loginNode.props.onLogin('Alex', 'login-token');
      ck('PIN login writes tg_token and restamps the queued items with it',
        sandbox.localStorage.getItem('tg_token') === 'login-token' && queue().every(i => i.o.headers['X-Auth-Token'] === 'login-token'));
    }
    // SSO adoption: no session on this device, /api/sso answers with a token.
    seed();
    sandbox.localStorage.removeItem('tg_name'); sandbox.localStorage.removeItem('tg_token');
    sandbox.fetch = url => String(url).includes('/api/sso')
      ? Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, token: 'sso-token', name: 'Alex' }) })
      : Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    React.__runEffects = true;
    try { if (X.App) X.App(); } catch (e) {}
    React.__runEffects = false;
    await new Promise(r => setTimeout(r, 20));
    ck('SSO adoption writes tg_token and restamps the queued items with it',
      sandbox.localStorage.getItem('tg_token') === 'sso-token' && queue().every(i => i.o.headers['X-Auth-Token'] === 'sso-token'));
    // (e) with a live session the replay drains the queue exactly once
    const seen = [];
    sandbox.fetch = (url, o) => { seen.push((o && o.headers && o.headers['X-Auth-Token']) || ''); return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: true }) }); };
    sent = await X.flushOutbox().catch(() => -1);
    ck('a successful flush sends all three and empties the queue', sent === 3 && queue().length === 0);
    ck('…every replayed request carried the restamped token', seen.length === 3 && seen.every(t => t === 'sso-token'));
    sent = await X.flushOutbox().catch(() => -1);
    ck('a second flush finds nothing to send', sent === 0 && queue().length === 0);
  };

  runOutbox().then(() => {
    console.log('');
    console.log('RESULT: ' + pass + ' PASS, ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0); // the app installs timers the harness never clears
  });
}
