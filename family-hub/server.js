// family-hub/server.js — the family-facing sibling of admin-hub: one public
// launcher page listing every trip on the droplet, so a family member signs in
// once and jumps straight to their trip's dashboard already logged in.
//
// The trip list is still read-only: it consumes each instance's PUBLIC
// GET /api/trip over localhost, and the /api/trips projection below is an
// allowlist, so days, activities, reservations and ports can never leak
// through it.
//
// Since v1.1.0 the portal also owns ONE credential for the family (Phase 2,
// "family SSO"): a name + 4-digit PIN in its own tiny data.db, and on success a
// signed, self-contained fam_sso cookie scoped to the parent domain. Each trip
// instance verifies that cookie itself (GET /api/sso there) and mints its own
// session token — no callback to the portal, no shared session store. The
// portal still holds NO trip data and no ADMIN_KEY.
//
// SSO is OFF unless FAMILY_SSO_SECRET is set: login still works, no cookie is
// issued, and the portal behaves exactly like Phase 1.
//
// HAZARD: like admin-hub, this must NEVER live under TRIPS_DIR (/var/www/trips)
// — it would discover itself and be swept into backup-all.sh's db backups. Its
// droplet home is /var/www/family-hub. See docs/MULTI_INSTANCE.md §ADMIN-HUB
// for the equivalent hazard note on the admin hub.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const sso = require('./lib/sso.js');
const app = express();

const PORT = process.env.PORT || 3011;
const TRIPS_DIR = process.env.TRIPS_DIR || '/var/www/trips';
// Generic default on purpose: the real domain lives only in the gitignored
// .env on the droplet, never in a tracked file (see tools/audit-publish.sh).
const PUBLIC_SUFFIX = process.env.PUBLIC_SUFFIX || 'example.com';
// Who may sign in. Comma-separated in .env so a family never edits code.
const FAMILY_NAMES = String(process.env.FAMILY_NAMES || 'Alex,Sam,Jordan,Riley,Casey')
  .split(',').map(s => s.trim()).filter(Boolean);
// The one shared secret every trip instance also holds (deploy/sync-sso-secret.sh).
// Empty = SSO disabled, portal degrades to the Phase-1 launcher.
const SSO_SECRET = String(process.env.FAMILY_SSO_SECRET || '').trim();
// Empty = host-only cookie (localhost dev). Production sets '.example.com' so
// every <trip>.<domain> receives it. Never hard-code the real domain here.
const COOKIE_DOMAIN = String(process.env.COOKIE_DOMAIN || '').trim();
// Roster claim lock, the portal's counterpart to the trip app's admin toggle.
// The portal has no admin surface at all — no ADMIN_KEY, no /api/admin/* routes,
// no admin page — so an env var is the whole mechanism rather than a settings
// table plus routes plus UI. Unset/'0' = today's behavior: any FAMILY_NAMES name
// may claim itself. Set to 1 once everyone has claimed theirs.
const ROSTER_LOCKED = String(process.env.FAMILY_ROSTER_LOCKED || '').trim() === '1';
const FETCH_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEV_INSTANCES_FILE = path.join(__dirname, 'instances.dev.json');
const APP_VERSION = (() => { try { return require('./package.json').version || ''; } catch (e) { return ''; } })();

app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Same minimal .env reader pattern as admin-hub/server.js and
// deploy/ecosystem.template.config.js: KEY=VALUE lines, # comments, no
// quoting/expansion, CRLF-safe.
function readEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

// Discovery, identical rule to admin-hub (and deploy/backup-all.sh): every
// TRIPS_DIR subdirectory with a .env is an instance — name from the dirname,
// PORT from the .env. Each instance is reached over loopback only.
function discoverInstances() {
  let entries = [];
  try { entries = fs.readdirSync(TRIPS_DIR, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    let env;
    try { env = readEnv(path.join(TRIPS_DIR, d.name, '.env')); } catch (e) { continue; } // no .env = not an instance
    const port = parseInt(env.PORT, 10);
    if (!port) continue;
    out.push({ name: d.name, baseUrl: 'http://127.0.0.1:' + port });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Dev fallback, for working on the portal from a laptop where /var/www/trips
// does not exist: instances.dev.json (gitignored; copy instances.dev.json.example)
// maps instance name -> baseUrl, so the page can run against the live HTTPS
// instances. On the droplet TRIPS_DIR exists, so this is never consulted.
function devInstances() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(DEV_INSTANCES_FILE, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error('instances.dev.json unreadable: ' + e.message);
    return [];
  }
  const map = (cfg && cfg.instances) || {};
  return Object.keys(map)
    .map(name => ({ name, baseUrl: String((map[name] && map[name].baseUrl) || '').replace(/\/+$/, '') }))
    .filter(i => i.baseUrl)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function instances() {
  return fs.existsSync(TRIPS_DIR) ? discoverInstances() : devInstances();
}

// The allowlist that keeps this endpoint safe to serve publicly: whatever the
// instance returns, only these fields ever leave the portal. Family is reduced
// to names — no colors, no interests — and days/activities/reservations/flights
// are simply never read.
function projectTrip(inst, data) {
  const t = (data && data.trip) || {};
  const theme = {};
  if (t.theme && typeof t.theme === 'object') {
    for (const k of ['navy', 'gold', 'emerald']) if (typeof t.theme[k] === 'string') theme[k] = t.theme[k];
  }
  return {
    name: inst.name,
    url: 'https://' + inst.name + '.' + PUBLIC_SUFFIX,
    title: String(t.title || inst.name),
    subtitle: String(t.subtitle || ''),
    brand: String(t.brand || ''),
    startDate: String(t.startDate || ''),
    endDate: String(t.endDate || ''),
    family: Array.isArray(data && data.family)
      ? data.family.map(f => String((f && f.name) || '')).filter(Boolean)
      : [],
    theme,
    reachable: true
  };
}

// A dead, mid-restart or trip-less instance is not an error for the portal:
// it renders as one dimmed, unlinked card. The page never hangs or fails whole.
function unreachable(inst) {
  return {
    name: inst.name,
    url: 'https://' + inst.name + '.' + PUBLIC_SUFFIX,
    title: inst.name, subtitle: '', brand: '', startDate: '', endDate: '',
    family: [], theme: {}, reachable: false
  };
}

async function fetchTrip(inst) {
  try {
    const res = await fetch(inst.baseUrl + '/api/trip', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) return unreachable(inst);
    return projectTrip(inst, await res.json());
  } catch (e) { return unreachable(inst); }
}

// 5-minute in-memory cache: trip config changes rarely (an admin import), while
// the page is opened by every family member on every phone. Nothing here is
// user-specific, so one shared entry serves everyone; a restart clears it.
let _cache = null; // { at: epochMs, rows: [...] }

app.get('/api/trips', async (req, res, next) => {
  try {
    if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return res.json(_cache.rows);
    const rows = await Promise.all(instances().map(fetchTrip));
    _cache = { at: Date.now(), rows };
    res.json(rows);
  } catch (e) { next(e); }
});

// ── PORTAL CREDENTIAL (v1.1.0) ──────────────────────────────────────────────
// One PIN per family member, held here and nowhere else. The schema is
// deliberately smaller than the trip app's: no token column and no sessions
// table, because the fam_sso cookie is self-contained — the only thing this db
// answers is "does this PIN match".
//
// data.db lives next to server.js in /var/www/family-hub and is NEVER shipped
// by family-hub/deploy/deploy-family-hub.sh (code only). Losing it costs the
// family nothing but re-claiming their PINs; tools/portal-reset-pin.js deletes
// one row when someone forgets theirs.
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// Same optional pepper as the trip app (see server.js): PIN_PEPPER keys an
// HMAC so a leaked users table is not a 10,000-entry rainbow table away from
// every PIN. Unset = the original bare sha256, so deploying this alone is a
// no-op; set it later and portal users migrate on their next sign-in.
const PIN_PEPPER = String(process.env.PIN_PEPPER || '');
const hashPinLegacy = pin => crypto.createHash('sha256').update(String(pin)).digest('hex');
const hashPin = pin => PIN_PEPPER
  ? crypto.createHmac('sha256', PIN_PEPPER).update(String(pin)).digest('hex')
  : hashPinLegacy(pin);
// Same in-memory 5-strikes / 30-minute lockout the trip app uses, with the same
// deliberate property: a restart clears it. A portal reboot is rare and an
// operator unsticking a locked-out kid by restarting is a feature, not a hole.
const LOGIN_FAILS = {}; // name -> { count, until }
const LOCK_MS = 30 * 60 * 1000;

const registeredNames = () => db.prepare('SELECT name FROM users').all().map(r => r.name);

// Boot config for the page: names come from .env, so the front end holds no
// family list of its own. `sso` tells the UI whether to promise auto-login.
app.get('/api/config', (req, res) => {
  res.json({ names: FAMILY_NAMES, suffix: PUBLIC_SUFFIX, sso: !!SSO_SECRET, registered: registeredNames() });
});

app.post('/api/portal/login', (req, res) => {
  const { name, pin } = req.body || {};
  if (!FAMILY_NAMES.includes(name)) return res.status(400).json({ error: 'Unknown name' });
  if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4 digits' });
  const now = Date.now();
  const lk = LOGIN_FAILS[name];
  if (lk && lk.until > now) return res.status(429).json({ error: 'Too many attempts', retryMs: lk.until - now });

  const ph = hashPin(pin);
  const row = db.prepare('SELECT pin_hash FROM users WHERE name = ?').get(name);
  let firstTime = false;
  if (!row && ROSTER_LOCKED) {
    // Locked roster: an unclaimed name cannot be claimed. Answered exactly like
    // a wrong PIN — same status, same body, same strike — so the sign-in screen
    // never reveals which names are still unclaimed.
    const r = LOGIN_FAILS[name] || { count: 0, until: 0 };
    r.count += 1;
    if (r.count >= 5) {
      r.until = now + LOCK_MS; r.count = 0; LOGIN_FAILS[name] = r;
      return res.status(429).json({ error: 'Too many attempts', retryMs: LOCK_MS });
    }
    LOGIN_FAILS[name] = r;
    return res.status(401).json({ error: 'Incorrect PIN', attemptsLeft: 5 - r.count });
  }
  if (!row) {
    // First claim, exactly like the trip app: whoever gets there first sets the
    // PIN. The family shares a household, not a threat model.
    db.prepare('INSERT INTO users (name, pin_hash) VALUES (?, ?)').run(name, ph);
    firstTime = true;
  } else if (row.pin_hash !== ph && PIN_PEPPER && row.pin_hash === hashPinLegacy(pin)) {
    // Migrate-on-login: accept the legacy sha256 hash once, rewriting it to the
    // peppered form in the same request.
    db.prepare('UPDATE users SET pin_hash = ? WHERE name = ?').run(ph, name);
  } else if (row.pin_hash !== ph) {
    const r = LOGIN_FAILS[name] || { count: 0, until: 0 };
    r.count += 1;
    if (r.count >= 5) {
      r.until = now + LOCK_MS; r.count = 0; LOGIN_FAILS[name] = r;
      return res.status(429).json({ error: 'Too many attempts', retryMs: LOCK_MS });
    }
    LOGIN_FAILS[name] = r;
    return res.status(401).json({ error: 'Incorrect PIN', attemptsLeft: 5 - r.count });
  }
  delete LOGIN_FAILS[name];

  if (SSO_SECRET) {
    res.setHeader('Set-Cookie',
      sso.cookieHeader(req, sso.sign(SSO_SECRET, name, Date.now()), COOKIE_DOMAIN, sso.MAX_AGE_S));
  }
  res.json({ ok: true, name, firstTime, sso: !!SSO_SECRET });
});

app.post('/api/portal/logout', (req, res) => {
  // Same Domain/Path as the cookie we set, or the browser keeps the original.
  res.setHeader('Set-Cookie', sso.cookieHeader(req, '', COOKIE_DOMAIN, 0));
  res.json({ ok: true });
});

// Who the browser actually is, per the signed cookie — not per localStorage,
// which the page keeps only as a display hint. A name dropped from FAMILY_NAMES
// stops being valid here the moment the .env changes, without touching the db.
app.get('/api/portal/me', (req, res) => {
  if (!SSO_SECRET) return res.status(401).json({ error: 'SSO disabled' });
  const claim = sso.verify(SSO_SECRET, sso.readCookie(req.headers.cookie, sso.COOKIE_NAME));
  if (!claim || !FAMILY_NAMES.includes(claim.name)) return res.status(401).json({ error: 'Not signed in' });
  res.json({ ok: true, name: claim.name });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: APP_VERSION, sso: !!SSO_SECRET, time: new Date().toISOString() }));

app.listen(PORT, () => console.log('family-hub on port ' + PORT + ' (TRIPS_DIR=' + TRIPS_DIR +
  ', suffix=' + PUBLIC_SUFFIX + ', sso=' + (SSO_SECRET ? 'on' : 'OFF') +
  ', cookie-domain=' + (COOKIE_DOMAIN || 'host-only') + ')'));
