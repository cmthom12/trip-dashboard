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
  'StarRow', 'TripMap', 'WeatherChip'];

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
const LOG = { markers: [], hidden: [], polylines: 0 };
const layerish = () => ({ addTo() { return this; }, bindPopup() { return this; }, on() { return this; }, setIcon(i) { this.icon = i; return this; }, setPopupContent() { return this; }, getLatLng: () => ({ distanceTo: () => 0 }), remove() {}, clearLayers() {}, openPopup() {} });
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
  process.exit(0); // the app installs timers the harness never clears
}
