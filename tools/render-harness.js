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
  'safeHttpUrl', 'extLink', 'flushOutbox', 'OUTBOX_KEY'];

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
  divIcon: o => ({ html: o.html }),
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
// The app script is evaluated once per process against one trip, so the escaping
// check below runs its poisoned trip in a child and reads the popups back here.
if (require.main === module && process.env.TRIP_EMIT_POPUPS === '1') {
  React.__runEffects = true;
  if (sandbox.__X.TripMap) sandbox.__X.TripMap({ focus: null, interests: {}, user: (sandbox.__X.FAMILY || [])[0], schedule: [] });
  React.__runEffects = false;
  process.stdout.write(JSON.stringify(LOG.popups));
  process.exit(0);
}

if (require.main === module) {
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-harness-'));
  let popups = [];
  try {
    const tripFile = path.join(tmp, 'poisoned.json');
    fs.writeFileSync(tripFile, JSON.stringify(poisoned));
    const r = cp.spawnSync(process.execPath, [__filename, tripFile, ROOT], {
      env: Object.assign({}, process.env, { TRIP_EMIT_POPUPS: '1' }),
      encoding: 'utf8'
    });
    popups = r.status === 0 && r.stdout ? JSON.parse(r.stdout) : [];
  } catch (e) { popups = []; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }

  const joined = popups.join('\n');
  ck('map popups were rendered for the poisoned trip', popups.length > 0);
  // Both halves matter: the value must actually reach the popup (so the check
  // cannot pass by rendering nothing) AND must arrive stripped.
  ck('popup carries the trip-data text', joined.includes(ESCAPED));
  ck("popup contains no unescaped '<' originating from desc/name/label", !joined.includes(PAYLOAD) && !joined.includes('<b>PWNED'));

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

  // H5 — a flush that hits a dead session must put the queue back untouched.
  const runOutbox = () => {
    if (typeof X.flushOutbox !== 'function') { ck('flushOutbox exists', false); return Promise.resolve(); }
    const KEY = X.OUTBOX_KEY || 'tg_outbox';
    sandbox.localStorage.removeItem('tg_token');   // the session is gone
    const queued = [
      { u: '/api/notes', o: { method: 'POST', body: '{"message":"a"}' } },
      { u: '/api/interests', o: { method: 'POST', body: '{"activityId":"x"}' } },
      { u: '/api/packing', o: { method: 'POST', body: '{"item":"y"}' } }
    ];
    sandbox.localStorage.setItem(KEY, JSON.stringify(queued));
    const before = sandbox.localStorage.getItem(KEY);
    sandbox.fetch = () => Promise.resolve({ status: 401, ok: false, json: () => Promise.resolve({}) });
    return X.flushOutbox().then(sent => {
      const after = sandbox.localStorage.getItem(KEY);
      ck('outbox flush with a dead token leaves the queue intact', after === before);
      ck('…all three queued writes survive, none reported sent', JSON.parse(after).length === 3 && sent === 0);
    }, () => ck('outbox flush with a dead token leaves the queue intact', false));
  };

  runOutbox().then(() => {
    console.log('');
    console.log('RESULT: ' + pass + ' PASS, ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0); // the app installs timers the harness never clears
  });
}
