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
  'safeColor', 'mapEsc', 'linkify', 'obRestampToken', 'qfetch', 'TRIP_IS_SHELL', 'authGet',
  'readDataCache', 'saveDataCache', 'clearDataCache',
  'TEMP_UNIT', 'fmtChecked', 'daysFromToday', 'DEFAULT_TZ',
  'TabBar', 'TAB_LIST', 'PRIMARY_TABS',
  'NowHome', 'tripPhase', 'todayDay', 'initialTab', 'directionsUrl', 'fmt12', 'RETRO_UNLOCKED',
  'favoriteToAdd', 'favoritePlanBody', 'PackRow', 'PACK_PERSON_ORDER', 'ssoNoteFor', 'Countdown', 'mergePendingPlan', 'DayPlanCard'];

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

// ── child mode: render every day's MissionCard + PhraseCard, emit what threw ──
// Used by the enrichments checks below. If the app script itself throws while
// loading (e.g. a trip with no enrichments block at all on old code), the
// require above already failed and this child exits non-zero.
if (require.main === module && process.env.TRIP_EMIT_CARDS === '1') {
  const X = sandbox.__X, errors = [], texts = {};
  let rendered = 0;
  for (const day of (X.DAYS || [])) {
    texts[day.id] = {};
    for (const name of ['MissionCard', 'PhraseCard']) {
      if (typeof X[name] !== 'function') { errors.push(name + ' missing'); continue; }
      try { texts[day.id][name] = text(X[name]({ day })); rendered++; } catch (e) { errors.push(name + ' ' + day.id + ': ' + e.message); }
    }
  }
  process.stdout.write(JSON.stringify({ rendered, errors, texts }));
  process.exit(0);
}

// ── child mode: a sign-in shell (v0.24.0) — does it load, and does the sign-in
// screen list the travelers? The bootstrap builds exactly this shape from the
// anonymous /api/trip summary.
if (require.main === module && process.env.TRIP_EMIT_LOGIN === '1') {
  const X = sandbox.__X;
  let loginText = '', err = '';
  try { loginText = text(X.Login({ onLogin() {} })); } catch (e) { err = e.message; }
  process.stdout.write(JSON.stringify({ shell: X.TRIP_IS_SHELL === true, family: X.FAMILY || [], loginText, err, unit: X.TEMP_UNIT }));
  process.exit(0);
}

if (require.main === module && process.env.TRIP_EMIT_POPUPS !== '1' && process.env.TRIP_EMIT_CARDS !== '1' && process.env.TRIP_EMIT_LOGIN !== '1') {
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
  // The "registered" override names the loaded trip's FIRST traveler (it used
  // to hard-code the sample's 'Alex', so every real roster failed this check).
  const firstName = (X.FAMILY || [])[0] || 'Alex';
  if (typeof X.Login === 'function') {
    React.__stateOverrides = [{ init: [], value: [firstName] }];
    let lt = text(X.Login({ onLogin() {} }));
    ck('unlocked sign-in shows the claimed/unclaimed chrome (has PIN / set PIN)', lt.includes('has PIN') && lt.includes('set PIN'));
    React.__stateOverrides = [{ init: [], value: [firstName] }, { init: false, value: true }];
    lt = text(X.Login({ onLogin() {} }));
    ck('locked sign-in shows the same neutral "Enter PIN" for every name', lt.includes('Enter PIN') && !lt.includes('has PIN') && !lt.includes('set PIN'));
    React.__stateOverrides = [];
  } else ck('Login exists', false);

  // v0.23.1 — enrichments are optional. A trip without enrichments.facts
  // rendered a BLANK page (PhraseCard did Object.keys(undefined)); one with no
  // enrichments block at all failed before the first render. Each variant of
  // the loaded trip is rendered in a child (one process = one trip).
  // Children get a clean copy of the env: a TRIP_* flag exported in the
  // caller's shell must not switch a child into the wrong mode.
  const childEnv = extra => {
    const e = Object.assign({}, process.env);
    delete e.TRIP_EMIT_CARDS; delete e.TRIP_EMIT_POPUPS; delete e.TRIP_EMIT_LOGIN; delete e.TRIP_NESTED; delete e.TRIP_LIVE_ROWS;
    return Object.assign(e, extra);
  };
  const renderCards = trip => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'render-harness-'));
    try {
      const f = path.join(t, 'trip.json');
      fs.writeFileSync(f, JSON.stringify(trip));
      const r = cp.spawnSync(process.execPath, [__filename, f, ROOT], {
        env: childEnv({ TRIP_EMIT_CARDS: '1' }), encoding: 'utf8', timeout: 60000
      });
      if (r.status !== 0) return { loaded: false, rendered: 0, errors: [String(r.stderr || '').split('\n').find(l => /Error/.test(l)) || 'child exited ' + r.status] };
      return Object.assign({ loaded: true }, JSON.parse(r.stdout));
    } catch (e) { return { loaded: false, rendered: 0, errors: [e.message] }; }
    finally { try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {} }
  };
  const dayCount = (X.DAYS || []).length;
  const variants = [
    ['no enrichments.facts', tr => { if (tr.enrichments) delete tr.enrichments.facts; }],
    ['enrichments = {}', tr => { tr.enrichments = {}; }],
    ['no enrichments key at all', tr => { delete tr.enrichments; }]
  ];
  for (const [label, mutate] of variants) {
    const tr = JSON.parse(JSON.stringify(X.TRIP));
    mutate(tr);
    const res = renderCards(tr);
    ck('trip with ' + label + ': app loads and every day\'s Mission + Phrase card renders without throwing' +
      (res.errors.length ? ' [' + res.errors[0] + ']' : ''),
      res.loaded && res.errors.length === 0 && res.rendered === dayCount * 2);
  }

  // …and the cards still SHOW their content (not just "did not throw"): on the
  // loaded trip, each day's mission text, phrase and a fact reach the screen.
  const enr = (X.TRIP && X.TRIP.enrichments) || {};
  const factVals = Object.values(enr.facts || {}).map(String);
  let shown = 0, missing = [];
  for (const day of (X.DAYS || [])) {
    const mt = typeof X.MissionCard === 'function' ? text(X.MissionCard({ day }) || '') : '';
    const pt = typeof X.PhraseCard === 'function' ? text(X.PhraseCard({ day }) || '') : '';
    const m = enr.missions && enr.missions[day.id], ph = enr.phrases && enr.phrases[day.id];
    if (m) { if (mt.includes(String(m))) shown++; else missing.push(day.id + ' mission'); }
    if (ph && ph.gr) { if (pt.includes(String(ph.gr))) shown++; else missing.push(day.id + ' phrase'); }
    if (factVals.length) { if (factVals.some(f => pt.includes(f))) shown++; else missing.push(day.id + ' fact'); }
  }
  ck('loaded trip: every day\'s mission, phrase and a fact are actually shown' + (missing.length ? ' [missing: ' + missing.slice(0, 3).join(', ') + ']' : ''),
    missing.length === 0 && shown > 0);

  // facts as a plain array is validator-approved and must keep rendering.
  if (factVals.length) {
    const tr = JSON.parse(JSON.stringify(X.TRIP));
    tr.enrichments.facts = factVals.slice();
    const res = renderCards(tr);
    const days = Object.values(res.texts || {});
    ck('trip with enrichments.facts as an ARRAY: every day still shows one of those facts',
      res.loaded && res.errors.length === 0 && days.length === dayCount &&
      days.every(t => factVals.some(f => String(t.PhraseCard || '').includes(f))));
  }

  // v0.24.0 — a sign-in shell (anonymous summary + emptied plan sections, the
  // shape the bootstrap builds) loads, flags itself, and lists the travelers.
  {
    const tr = X.TRIP || {};
    const shell = {
      __shell: true, trip: Object.assign({}, tr.trip || {}, { photosUrl: '' }),
      family: (tr.family || []).map(f => ({ name: f.name, color: f.color })),
      categories: tr.categories || {}, days: [], dayCoords: {}, flights: [], reservationsSeed: [],
      essentials: [], embassies: [], enrichments: {}, mustDos: [], tz: tr.tz
    };
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'render-harness-'));
    let out = {};
    try {
      const f = path.join(t, 'shell.json');
      fs.writeFileSync(f, JSON.stringify(shell));
      const r = cp.spawnSync(process.execPath, [__filename, f, ROOT], { env: childEnv({ TRIP_EMIT_LOGIN: '1' }), encoding: 'utf8', timeout: 60000 });
      out = r.status === 0 && r.stdout ? JSON.parse(r.stdout) : { err: 'child exited ' + r.status };
    } catch (e) { out = { err: e.message }; } finally { try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {} }
    const names = (tr.family || []).map(f => f.name);
    ck('sign-in shell: app loads, knows it is a shell, and the sign-in screen lists every traveler' + (out.err ? ' [' + out.err + ']' : ''),
      !out.err && out.shell === true && names.length > 0 && names.every(n => String(out.loginText || '').includes(n)));
  }
  ck('full trip is not flagged as a shell', X.TRIP_IS_SHELL === false);
  {
    const tr = JSON.parse(JSON.stringify(X.TRIP || {}));
    tr.units = 'C';
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'render-harness-'));
    let out = {};
    try {
      const f = path.join(t, 'celsius.json');
      fs.writeFileSync(f, JSON.stringify(tr));
      const r = cp.spawnSync(process.execPath, [__filename, f, ROOT], { env: childEnv({ TRIP_EMIT_LOGIN: '1' }), encoding: 'utf8', timeout: 60000 });
      out = r.status === 0 && r.stdout ? JSON.parse(r.stdout) : {};
    } catch (e) { out = {}; } finally { try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {} }
    ck('weather: a trip with "units": "C" shows °C', out.unit === 'C');
  }
  ck('authGet exists (family-data reads carry the token)', typeof X.authGet === 'function');

  // v0.24.0 weather card: no forecast call outside the service's 16-day window
  // (those only answer 400), none for past days, and the trip's unit.
  if (typeof X.WeatherChip === 'function') {
    const ymd = off => { const d = new Date(); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const realFetch = sandbox.fetch, calls = [];
    sandbox.fetch = url => { calls.push(String(url)); return Promise.resolve({ ok: false, json: () => Promise.resolve({}) }); };
    React.__runEffects = true;
    const callsFor = off => { const n = calls.length; X.WeatherChip({ ll: [40, -90], date: ymd(off) }); return calls.slice(n); };
    const far = callsFor(40), past = callsFor(-3), near = callsFor(2), edge = callsFor(15), over = callsFor(16);
    React.__runEffects = false;
    sandbox.fetch = realFetch;
    ck('weather: no forecast call for a day 40 days out', far.length === 0);
    ck('weather: no forecast call for a past day', past.length === 0);
    ck('weather: a day 2 days out is fetched once', near.length === 1 && /open-meteo/.test(near[0] || ''));
    ck('weather: window edge — day +15 fetched, day +16 not', edge.length === 1 && over.length === 0);
    ck('weather: unit follows the trip (sample has none → fahrenheit)', X.TEMP_UNIT === 'F' && /temperature_unit=fahrenheit/.test(near[0] || ''));
  } else ck('WeatherChip exists', false);
  if (typeof X.fmtChecked === 'function') {
    const iso = '2026-10-17T15:04:00.000Z';
    const shown = X.fmtChecked(iso);
    const want = new Date(iso).toLocaleString('en-US', { timeZone: X.DEFAULT_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    ck('flight "last checked": an ISO stamp is shown in the trip time zone', shown === want && shown !== iso);
    ck('flight "last checked": an older ready-made string is shown as-is', X.fmtChecked('10/17/2026, 10:04:00 AM') === '10/17/2026, 10:04:00 AM');
  } else ck('fmtChecked exists', false);

  // v0.24.0 offline shell: the lists snapshot belongs to one traveler.
  if (typeof X.saveDataCache === 'function' && typeof X.readDataCache === 'function' && typeof X.clearDataCache === 'function') {
    const who = (X.FAMILY || [])[0] || 'Alex', other = (X.FAMILY || [])[1] || 'Sam';
    X.saveDataCache(who, { notes: [{ id: 1, message: 'snapshot probe' }] });
    X.saveDataCache(who, { packing: [{ id: 2, item: 'second part' }] });
    const mine = X.readDataCache(who);
    ck('lists snapshot: saved parts merge and read back for the same traveler',
      !!mine && mine.notes && mine.notes[0].message === 'snapshot probe' && mine.packing && mine.packing[0].item === 'second part');
    ck('lists snapshot: another traveler on the same device never sees it', X.readDataCache(other) === null);
    X.clearDataCache();
    ck('lists snapshot: cleared at sign-out', X.readDataCache(who) === null);
  } else ck('lists snapshot helpers exist', false);

  // v0.23.1 — the whole harness must pass on a real-shaped roster, not only on
  // the sample's names. Rename every traveler (synthetic replacements) and run
  // the full suite on it in a child. TRIP_NESTED stops that child recursing.
  if (process.env.TRIP_NESTED !== '1') {
    const orig = X.FAMILY || [];
    const pool = ['Morgan', 'Taylor', 'Quinn', 'Avery', 'Parker', 'Reese', 'Rowan', 'Emery']
      .filter(n => !orig.includes(n));
    const map = new Map(orig.map((n, i) => [n, (pool[i % pool.length] || 'Traveler') + (i >= pool.length ? String(i) : '')]));
    const esc = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // ONE pass (so a replacement is never renamed again), longest names first,
    // and word edges that understand non-ASCII letters.
    const alt = [...map.keys()].sort((a, b) => b.length - a.length).map(esc).join('|');
    let js = JSON.stringify(X.TRIP);
    if (alt) js = js.replace(new RegExp('(?<![\\p{L}\\p{N}_])(' + alt + ')(?![\\p{L}\\p{N}_])', 'gu'), n => map.get(n));
    const renamedFam = (JSON.parse(js).family || []).map(f => f.name);
    const renameOk = renamedFam.length === orig.length && new Set(renamedFam).size === renamedFam.length &&
      renamedFam.every(n => !orig.includes(n));
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'render-harness-'));
    let nestedOut = '';
    try {
      const f = path.join(t, 'renamed.json');
      fs.writeFileSync(f, js);
      const r = cp.spawnSync(process.execPath, [__filename, f, ROOT], {
        env: childEnv({ TRIP_NESTED: '1' }), encoding: 'utf8', timeout: 180000
      });
      nestedOut = String(r.stdout || '');
    } catch (e) { nestedOut = ''; } finally { try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {} }
    const m = nestedOut.match(/RESULT: (\d+) PASS, (\d+) FAIL/);
    const failed = nestedOut.split('\n').filter(l => l.startsWith('FAIL')).map(l => l.slice(6));
    ck('full harness passes on a renamed roster (every traveler renamed, all names distinct)' +
      (renameOk ? '' : ' [rename did not produce a distinct, fully-renamed roster]') +
      (failed.length ? ' [failed: ' + failed[0] + ']' : ''),
      renameOk && !!m && +m[2] === 0 && +m[1] > 0);
  }

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
