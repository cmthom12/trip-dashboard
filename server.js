const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const app = express();

app.use(express.json({ limit: '2mb' })); // trip-data imports can exceed the 100kb default
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY, pin_hash TEXT, token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS interests (
    activity_id TEXT PRIMARY KEY, names TEXT DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS flight_status (
    flight_id TEXT PRIMARY KEY, status TEXT, checked_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day_id TEXT, author TEXT,
    label TEXT, url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, when_text TEXT,
    confirmation TEXT, who TEXT, notes TEXT, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS packing (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT, category TEXT,
    done INTEGER DEFAULT 0, who TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS day_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day_id TEXT, activity_id TEXT,
    title TEXT, time_text TEXT, who TEXT DEFAULT '[]', created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS processed_ops (
    op_id TEXT PRIMARY KEY, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS user_tokens (
    token TEXT PRIMARY KEY, name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// Carry any existing single-token logins into the multi-device token table (so current sessions survive the upgrade).
try { db.exec("INSERT OR IGNORE INTO user_tokens (token, name) SELECT token, name FROM users WHERE token IS NOT NULL AND token <> ''"); } catch (e) {}

// CORS_ORIGIN env pins CORS to one exact origin; unset keeps the permissive template default.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN || '*');
  if (CORS_ORIGIN) res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Op-Id, X-Auth-Token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Idempotency: a write carrying X-Op-Id is applied at most once (safe offline replays).
const _opSeen = db.prepare('SELECT 1 FROM processed_ops WHERE op_id = ?');
const _opMark = db.prepare('INSERT OR IGNORE INTO processed_ops (op_id, created_at) VALUES (?, ?)');
app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const opId = req.get('X-Op-Id');
  if (!opId) return next();
  try {
    if (_opSeen.get(opId)) return res.json({ ok: true, deduped: true });
    const _json = res.json.bind(res);
    res.json = (body) => { try { if (res.statusCode < 400) _opMark.run(opId, Date.now()); } catch(e){} return _json(body); };
  } catch(e) {}
  next();
});

// ── ADMIN CONSOLE (additive; every /api/admin/* route 404s unless the ADMIN_KEY env var is set) ──
// Registered BEFORE the token-auth middleware: admin requests authenticate by key alone,
// while idempotency (above) still applies to admin POSTs carrying X-Op-Id.
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_FAILS = { count: 0, until: 0 }; // in-memory lockout, same pattern as LOGIN_FAILS
const _adminDigest = s => crypto.createHash('sha256').update(String(s)).digest();
const adminGate = (req, res, next) => {
  if (!ADMIN_KEY) return res.status(404).json({ error: 'Not found' }); // disabled: admin is invisible
  const now = Date.now();
  if (ADMIN_FAILS.until > now) return res.status(429).json({ error: 'Too many attempts', retryMs: ADMIN_FAILS.until - now });
  const key = req.get('X-Admin-Key') || '';
  if (!crypto.timingSafeEqual(_adminDigest(key), _adminDigest(ADMIN_KEY))) {
    ADMIN_FAILS.count += 1;
    if (ADMIN_FAILS.count >= 5) { ADMIN_FAILS.until = now + 30 * 60 * 1000; ADMIN_FAILS.count = 0; }
    return res.status(401).json({ error: 'Bad admin key' });
  }
  ADMIN_FAILS.count = 0; ADMIN_FAILS.until = 0;
  next();
};
app.use('/api/admin', adminGate);

// ── TRIP CONFIG: the active trip lives in the db; POST /api/trip (admin) imports a new one.
// Import + versioning are shared with tools/apply-trip-data.js via tools/lib/trip-store.js. ──
const { ensureTripConfigTable, importTripConfig } = require('./tools/lib/trip-store.js');
ensureTripConfigTable(db);
// Boot migration: first start after this upgrade seeds version 1 from the inline
// trip-data block, so existing deployments keep their trip with zero manual steps.
try {
  if (!db.prepare('SELECT COUNT(*) AS c FROM trip_config').get().c) {
    const _html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const _m = _html.match(/<script type="application\/json" id="trip-data">\s*([\s\S]*?)<\/script>/);
    db.prepare('INSERT INTO trip_config (json, version, updated_by) VALUES (?, 1, ?)')
      .run(JSON.stringify(JSON.parse(_m[1])), 'boot-seed');
    console.log('trip_config: seeded version 1 from the inline trip-data block');
  }
} catch (e) { console.error('trip_config boot seed failed:', e.message); }

let _tripCache; // undefined = not loaded yet; null = table empty
function activeTrip() {
  if (_tripCache === undefined) {
    try {
      const row = db.prepare('SELECT json FROM trip_config ORDER BY version DESC, id DESC LIMIT 1').get();
      _tripCache = row ? JSON.parse(row.json) : null;
    } catch (e) { _tripCache = null; }
  }
  return _tripCache;
}
const activeTripVersion = () => { try { return db.prepare('SELECT MAX(version) AS v FROM trip_config').get().v || 0; } catch (e) { return 0; } };

// Name lists derive from the active trip. The hardcoded ALLOWED/PLANNERS literals
// below are ONLY the fallback for an empty trip_config (fresh checkout, seed failed).
// Writers are still trusted solely by their token — only membership became dynamic.
const allowedNames = () => {
  const t = activeTrip();
  return t && Array.isArray(t.family) && t.family.length ? t.family.map(f => String(f.name)) : ALLOWED;
};
const plannerNames = () => {
  const t = activeTrip();
  if (!t) return PLANNERS;
  const fam = allowedNames();
  return Array.isArray(t.planners) && t.planners.length ? t.planners.filter(n => fam.includes(n)) : fam;
};

app.get('/api/trip', (req, res) => {
  const t = activeTrip();
  if (!t) return res.status(404).json({ error: 'No trip configured' });
  res.json(t);
});
app.get('/api/trip/export', (req, res) => {
  const t = activeTrip();
  if (!t) return res.status(404).json({ error: 'No trip configured' });
  res.setHeader('Content-Disposition', 'attachment; filename="trip-data.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(t, null, 1));
});

const { validateTripData } = require('./tools/lib/validate.js');
const _tripFindings = v => ({
  errors: v.findings.filter(f => f.type === 'err').map(f => f.msg),
  warnings: v.findings.filter(f => f.type === 'warn').map(f => f.msg)
});
app.post('/api/trip/validate', adminGate, (req, res) => {
  const d = req.body;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return res.status(400).json({ ok: false, errors: ['Body must be the trip-data JSON object'], warnings: [] });
  const v = validateTripData(d);
  res.json({ ok: v.errors === 0, ...(_tripFindings(v)), summary: v.summary });
});
app.post('/api/trip', adminGate, (req, res) => {
  const d = req.body;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return res.status(400).json({ ok: false, errors: ['Body must be the trip-data JSON object'], warnings: [] });
  const r = importTripConfig(db, d, 'admin');
  if (!r.ok) return res.status(400).json({ ok: false, errors: r.errors, warnings: r.warnings });
  _tripCache = d; // refresh the cache: name lists and GET /api/trip switch immediately
  res.json({ ok: true, version: r.version, warnings: r.warnings });
});

app.get('/api/admin/overview', (req, res) => {
  // interests entries are "Name|stars" strings (see intParse in index.html), with
  // legacy bare names possible — mirror the client's parse rule exactly.
  const votesBy = {}, lastVoteBy = {};
  db.prepare('SELECT names, updated_at FROM interests').all().forEach(r => {
    try {
      JSON.parse(r.names).forEach(e => {
        let n = String(e);
        const i = n.lastIndexOf('|');
        if (i >= 0) { const st = parseInt(n.slice(i + 1), 10); if (st >= 1 && st <= 3) n = n.slice(0, i); }
        votesBy[n] = (votesBy[n] || 0) + 1;
        // proxy timestamp: the row's updated_at (bumped whenever anyone votes on that activity)
        if (r.updated_at && (!lastVoteBy[n] || r.updated_at > lastVoteBy[n])) lastVoteBy[n] = r.updated_at;
      });
    } catch (e) {}
  });
  const _cnt = (sql, n) => db.prepare(sql).get(n).c;
  const travelers = allowedNames().map(name => ({
    name,
    registered: !!db.prepare('SELECT name FROM users WHERE name = ?').get(name),
    planner: plannerNames().includes(name),
    lastActivity: [db.prepare(`SELECT MAX(t) AS t FROM (
      SELECT MAX(created_at) AS t FROM user_tokens WHERE name = @n
      UNION ALL SELECT MAX(created_at) FROM notes WHERE author = @n
      UNION ALL SELECT MAX(created_at) FROM suggestions WHERE author = @n
      -- day_schedule deliberately NOT filtered by moved_to here: a tombstone still
      -- proves its creator was active at created_at; this is an activity signal,
      -- not plan content.
      UNION ALL SELECT MAX(created_at) FROM day_schedule WHERE created_by = @n
      UNION ALL SELECT MAX(created_at) FROM reservations WHERE created_by = @n
      UNION ALL SELECT MAX(created_at) FROM packing WHERE who = @n
    )`).get({ n: name }).t, lastVoteBy[name]].filter(Boolean).sort().pop() || null,
    counts: {
      votes: votesBy[name] || 0,
      notes: _cnt('SELECT COUNT(*) AS c FROM notes WHERE author = ?', name),
      suggestions: _cnt('SELECT COUNT(*) AS c FROM suggestions WHERE author = ?', name),
      packing: _cnt('SELECT COUNT(*) AS c FROM packing WHERE who = ?', name)
    }
  }));
  const rows = {};
  ['users', 'user_tokens', 'interests', 'flight_status', 'notes', 'suggestions',
   'reservations', 'packing', 'day_schedule', 'processed_ops', 'trip_config'].forEach(t => {
    // day_schedule: the hub shows this as "day-plan rows" — count only the visible
    // plan, not tombstones a move left behind (moved_to set). COALESCE-free because
    // pre-move databases simply have no moved_to values; the ALTER runs before listen.
    rows[t] = t === 'day_schedule'
      ? db.prepare('SELECT COUNT(*) AS c FROM day_schedule WHERE moved_to IS NULL').get().c
      : db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
  });
  let dbSizeBytes = 0;
  try { dbSizeBytes = fs.statSync(path.join(__dirname, 'data.db')).size; } catch (e) {}
  let backups = [];
  try {
    backups = fs.readdirSync(__dirname).filter(f => f.startsWith('data.db.backup-')).map(f => {
      const st = fs.statSync(path.join(__dirname, f));
      return { file: f, mtime: st.mtime.toISOString(), sizeBytes: st.size };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch (e) {}
  const _t = (activeTrip() || {}).trip || {};
  res.json({ travelers,
    trip: { title: _t.title || '', startDate: _t.startDate || '', endDate: _t.endDate || '', version: activeTripVersion() },
    db: { sizeBytes: dbSizeBytes, rows }, backups });
});

// Clears the login credential only: the user's PIN row + every session token.
// Registration re-opens for that name on next login; votes/notes/content untouched.
const _adminClearCred = name => db.transaction(() => {
  const hadPin = !!db.prepare('SELECT name FROM users WHERE name = ?').get(name);
  const tokensRevoked = db.prepare('DELETE FROM user_tokens WHERE name = ?').run(name).changes;
  db.prepare('DELETE FROM users WHERE name = ?').run(name);
  return { hadPin, tokensRevoked };
})();

app.post('/api/admin/reset-pin', (req, res) => {
  const name = (req.body || {}).name;
  if (!allowedNames().includes(name)) return res.status(400).json({ error: 'Unknown name' });
  const out = _adminClearCred(name);
  res.json({ ok: true, name, hadPin: out.hadPin, tokensRevoked: out.tokensRevoked,
    message: 'PIN cleared — ' + name + ' sets a fresh PIN at next sign-in. Their votes, notes and lists are untouched.' });
});

app.post('/api/admin/remove-user', (req, res) => {
  const name = (req.body || {}).name;
  if (!allowedNames().includes(name)) return res.status(400).json({ error: 'Unknown name' });
  const out = _adminClearCred(name);
  delete LOGIN_FAILS[name];
  res.json({ ok: true, name, hadPin: out.hadPin, tokensRevoked: out.tokensRevoked, lockoutCleared: true,
    message: name + "'s sign-in and lockout state were removed. Their content (votes, notes, suggestions, packing) is retained." });
});

app.post('/api/admin/backup', (req, res, next) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = 'data.db.backup-admin-' + stamp;
  // better-sqlite3 online backup: safe while the db is live, unlike copying the file.
  db.backup(path.join(__dirname, file))
    .then(() => res.json({ ok: true, file }))
    .catch(next);
});

// ── AUTH: writes must carry a valid session token; we trust the token, not a self-asserted author. ──
const _tokenUser = db.prepare('SELECT name FROM user_tokens WHERE token = ?');
app.use((req, res, next) => {
  if (req.method === 'GET' || req.path === '/api/login' || req.path === '/api/health') return next();
  const tok = req.get('X-Auth-Token');
  const row = tok ? _tokenUser.get(tok) : null;
  if (!row) return res.status(401).json({ error: 'Session expired \u2014 please sign in again' });
  req.authUser = row.name;
  next();
});
const hashPin = pin => crypto.createHash('sha256').update(String(pin)).digest('hex');
const ALLOWED = ["Alex","Sam","Jordan","Riley","Casey"]; // fallback only — see allowedNames()
const LOGIN_FAILS = {}; // name -> { count, until } : in-memory brute-force lockout

app.post('/api/login', (req, res) => {
  const { name, pin } = req.body;
  if (!allowedNames().includes(name)) return res.status(400).json({ error: 'Unknown name' });
  if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4 digits' });
  const _now = Date.now();
  const _lk = LOGIN_FAILS[name];
  if (_lk && _lk.until > _now) return res.status(429).json({ error: 'Too many attempts', retryMs: _lk.until - _now });
  const ph = hashPin(pin);
  const existing = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!existing) {
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (name, pin_hash, token) VALUES (?, ?, ?)').run(name, ph, token);
    db.prepare('INSERT OR IGNORE INTO user_tokens (token, name) VALUES (?, ?)').run(token, name);
    return res.json({ ok: true, token, firstTime: true });
  }
  if (existing.pin_hash !== ph) {
    const _r = LOGIN_FAILS[name] || { count: 0, until: 0 };
    _r.count += 1;
    if (_r.count >= 5) { _r.until = _now + 30 * 60 * 1000; _r.count = 0; LOGIN_FAILS[name] = _r; return res.status(429).json({ error: 'Too many attempts', retryMs: 30 * 60 * 1000 }); }
    LOGIN_FAILS[name] = _r;
    return res.status(401).json({ error: 'Incorrect PIN', attemptsLeft: 5 - _r.count });
  }
  delete LOGIN_FAILS[name];
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET token = ? WHERE name = ?').run(token, name);
  db.prepare('INSERT OR IGNORE INTO user_tokens (token, name) VALUES (?, ?)').run(token, name);
  return res.json({ ok: true, token, firstTime: false });
});

app.get('/api/users', (req, res) => {
  res.json({ registered: db.prepare('SELECT name FROM users').all().map(r => r.name) });
});

// Session check for restore-on-boot: trusts the token only (GETs skip the auth middleware).
app.get('/api/me', (req, res) => {
  const tok = req.get('X-Auth-Token');
  const row = tok ? _tokenUser.get(tok) : null;
  if (!row) return res.status(401).json({ error: 'Session expired — please sign in again' });
  res.json({ ok: true, name: row.name });
});

// ── FAMILY SSO: accept a session minted by the family portal ────────────────
// Opt-in PER INSTANCE and invisible when off: with no FAMILY_SSO_SECRET in the
// environment this route 404s, so an instance that never joins the portal is
// byte-for-byte the app it was before. deploy/sync-sso-secret.sh is what puts
// the shared secret into an instance's .env.
//
// The portal signs a self-contained cookie (family-hub/lib/sso.js) — the format
// is duplicated below on purpose, because a deployed instance has no access to
// the portal's tree. Keep the two in step.
//
// This mints a session EXACTLY like POST /api/login does, minus the users-table
// work: user_tokens is the sole authority for a token, so no users row is
// needed and none is created. The PIN lives at the portal; this instance never
// sees one, and a guest (no portal account, no cookie) is unaffected — as is
// anyone whose cookie names someone this trip doesn't list.
const SSO_SECRET = String(process.env.FAMILY_SSO_SECRET || '').trim();
const _ssoB64u = buf => Buffer.from(buf).toString('base64url');
const _ssoCookie = (header, name) => {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 1 || part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return part.slice(i + 1).trim(); }
  }
  return '';
};
// Returns the claimed name, or '' for every failure (missing, malformed, bad
// signature, expired) — the client treats them all the same: show the PIN screen.
const _ssoVerify = value => {
  if (!SSO_SECRET || typeof value !== 'string') return '';
  const dot = value.indexOf('.');
  if (dot < 1 || dot === value.length - 1) return '';
  const part1 = value.slice(0, dot), sig = value.slice(dot + 1);
  const want = _ssoB64u(crypto.createHmac('sha256', SSO_SECRET).update(part1).digest());
  if (sig.length !== want.length) return ''; // timingSafeEqual throws on length mismatch
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return '';
  let p;
  try { p = JSON.parse(Buffer.from(part1, 'base64url').toString('utf8')); } catch (e) { return ''; }
  if (!p || typeof p.n !== 'string' || !p.n) return '';
  if (typeof p.exp !== 'number' || !(p.exp > Date.now())) return '';
  return p.n;
};

app.get('/api/sso', (req, res) => {
  if (!SSO_SECRET) return res.status(404).json({ error: 'Not found' });
  const name = _ssoVerify(_ssoCookie(req.headers.cookie, 'fam_sso'));
  if (!name) return res.status(401).json({ error: 'No portal session' });
  if (!allowedNames().includes(name)) return res.status(401).json({ error: 'Not on this trip' });
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT OR IGNORE INTO user_tokens (token, name) VALUES (?, ?)').run(token, name);
  res.json({ ok: true, token, name });
});

app.get('/api/interests', (req, res) => {
  const rows = db.prepare('SELECT * FROM interests').all();
  const result = {}; rows.forEach(r => { result[r.activity_id] = JSON.parse(r.names); });
  res.json(result);
});
app.post('/api/interests', (req, res) => {
  const { activityId, names } = req.body;
  if (!activityId || !Array.isArray(names)) return res.status(400).json({ error: 'Invalid' });
  db.prepare(`INSERT INTO interests (activity_id, names, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(activity_id) DO UPDATE SET names=excluded.names, updated_at=CURRENT_TIMESTAMP`
  ).run(activityId, JSON.stringify(names));
  res.json({ ok: true });
});

app.get('/api/flights', (req, res) => {
  const rows = db.prepare('SELECT * FROM flight_status').all();
  const result = {}; rows.forEach(r => { result[r.flight_id] = { status: r.status, checked: r.checked_at }; });
  res.json(result);
});
app.post('/api/flights', (req, res) => {
  const { flightId, status } = req.body;
  if (!flightId || !status) return res.status(400).json({ error: 'Invalid' });
  const checked = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
  db.prepare(`INSERT INTO flight_status (flight_id, status, checked_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(flight_id) DO UPDATE SET status=excluded.status, checked_at=excluded.checked_at, updated_at=CURRENT_TIMESTAMP`
  ).run(flightId, status, checked);
  res.json({ ok: true });
});

app.get('/api/notes', (req, res) => {
  res.json(db.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT 50').all()); 
});
app.post('/api/notes', (req, res) => {
  const { author, message } = req.body;
  if (!author || !message) return res.status(400).json({ error: 'Invalid' });
  const r = db.prepare('INSERT INTO notes (author, message) VALUES (?, ?)').run(author, message.slice(0, 500));
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.delete('/api/notes/:id', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id); res.json({ ok: true }); 
});

// ── SUGGESTIONS (per-day third-party links the family pastes) ───────────────
app.get('/api/suggestions', (req, res) => {
  res.json(db.prepare('SELECT * FROM suggestions ORDER BY created_at ASC').all()); 
});
app.post('/api/suggestions', (req, res) => {
  const { dayId, author, label, url } = req.body;
  if (!dayId || !author || !url) return res.status(400).json({ error: 'Invalid' });
  const r = db.prepare('INSERT INTO suggestions (day_id, author, label, url) VALUES (?, ?, ?, ?)')
    .run(dayId, author, (label || '').slice(0, 120), url.slice(0, 500));
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.delete('/api/suggestions/:id', (req, res) => {
  db.prepare('DELETE FROM suggestions WHERE id = ?').run(req.params.id); res.json({ ok: true }); 
});

// ── RESERVATIONS ────────────────────────────────────────
app.get('/api/reservations', (req, res) => {
  res.json(db.prepare('SELECT * FROM reservations ORDER BY created_at ASC').all()); 
});
app.post('/api/reservations', (req, res) => {
  const { title, when, conf, who, notes, dayId, planTime } = req.body;
  const author = req.authUser;
  if (!title) return res.status(400).json({ error: 'Invalid' });
  const newId = db.transaction(() => {
    const r = db.prepare('INSERT INTO reservations (title, when_text, confirmation, who, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(title).slice(0,160), String(when||'').slice(0,120), String(conf||'').slice(0,120), String(who||'').slice(0,120), String(notes||'').slice(0,400), String(author||''));
    if (dayId && plannerNames().includes(author)) {
      db.prepare('INSERT INTO day_schedule (day_id, activity_id, title, time_text, who, created_by, res_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(String(dayId).slice(0,20), '', String(title).slice(0,160), String(planTime||'').slice(0,10), JSON.stringify(allowedNames()), String(author||''), r.lastInsertRowid);
    }
    return r.lastInsertRowid;
  })();
  res.json({ ok: true, id: newId });
});
app.delete('/api/reservations/:id', (req, res) => {
  const paired = db.prepare('SELECT COUNT(*) AS c FROM day_schedule WHERE (res_id = ? OR activity_id = ?) AND moved_to IS NULL')
    .get(req.params.id, 'res:' + req.params.id).c > 0;
  if (paired && !plannerNames().includes(req.authUser)) {
    return res.status(403).json({ error: 'This booking is on the day plan — only trip planners can delete it' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM reservations WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM day_schedule WHERE res_id = ? OR activity_id = ?').run(req.params.id, 'res:' + req.params.id);
  })();
  res.json({ ok: true });
});

// ── PACKING LIST ──────────────────────────────────────
app.get('/api/packing', (req, res) => {
  res.json(db.prepare('SELECT * FROM packing ORDER BY created_at ASC').all()); 
});
app.post('/api/packing', (req, res) => {
  const { item, category, who } = req.body;
  if (!item) return res.status(400).json({ error: 'Invalid' });
  const r = db.prepare('INSERT INTO packing (item, category, who) VALUES (?, ?, ?)')
    .run(String(item).slice(0,120), String(category||'').slice(0,40), String(who||'').slice(0,40));
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.post('/api/packing/:id/toggle', (req, res) => {
  const row = db.prepare('SELECT done FROM packing WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE packing SET done = ? WHERE id = ?').run(row.done ? 0 : 1, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/packing/:id', (req, res) => {
  db.prepare('DELETE FROM packing WHERE id = ?').run(req.params.id); res.json({ ok: true }); 
});

// ── DAY SCHEDULE (planned itinerary; only the planners can edit) ─────────────
try { db.exec("ALTER TABLE day_schedule ADD COLUMN res_id INTEGER"); } catch (e) {}
// moved_to: set when a move replaced this row — it points at the replacement row's id.
// A row with moved_to set is a tombstone: it stays for history but is invisible to every
// plan read (all of which filter moved_to IS NULL). Moves never UPDATE day/time/who in
// place and never DELETE — see POST /api/dayplan/move.
try { db.exec("ALTER TABLE day_schedule ADD COLUMN moved_to INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE reservations ADD COLUMN created_by TEXT"); } catch (e) {}
// One-time backfill: attribute existing bookings from the day-plan row that created them.
// (No moved_to filter: this targets legacy databases that predate moves entirely, and a
// tombstone's created_by is still the correct attribution.)
try { db.exec(`UPDATE reservations SET created_by = (
  SELECT ds.created_by FROM day_schedule ds
  WHERE ds.res_id = reservations.id AND ds.created_by IS NOT NULL
  ORDER BY ds.id LIMIT 1
) WHERE created_by IS NULL`); } catch (e) {}
// (template: no trip-specific seed data)
const PLANNERS = ["Alex", "Sam", "Jordan", "Riley", "Casey"]; // fallback only — see plannerNames()
app.get('/api/schedule', (req, res) => {
  res.json(db.prepare('SELECT * FROM day_schedule WHERE moved_to IS NULL ORDER BY day_id ASC, time_text ASC, id ASC').all());
});
app.post('/api/schedule', (req, res) => {
  const { dayId, activityId, title, time, who, whenText, resId } = req.body;
  const author = req.authUser;
  if (!plannerNames().includes(author)) return res.status(403).json({ error: 'Only trip planners can edit the day plan' });
  if (!dayId || !title || !Array.isArray(who) || who.length === 0) return res.status(400).json({ error: 'Invalid' });
    const _fam = allowedNames();
  const cleanWho = who.filter(n => _fam.includes(n));
  if (cleanWho.length === 0) return res.status(400).json({ error: 'Invalid members' });
  if (resId && !db.prepare('SELECT id FROM reservations WHERE id = ?').get(resId)) return res.status(400).json({ error: 'Booking not found' });
  const out = db.transaction(() => {
    let linkId = resId || null;
    if (!linkId) {
      const nr = db.prepare('INSERT INTO reservations (title, when_text, confirmation, who, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(String(title).slice(0,160), String(whenText||'').slice(0,120), '', '', '', String(author||''));
      linkId = nr.lastInsertRowid;
    }
    const r = db.prepare('INSERT INTO day_schedule (day_id, activity_id, title, time_text, who, created_by, res_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(dayId).slice(0,20), String(activityId||'').slice(0,60), String(title).slice(0,160),
           String(time||'').slice(0,10), JSON.stringify(cleanWho), author, linkId);
    return { id: r.lastInsertRowid, resId: linkId };
  })();
  res.json({ ok: true, id: out.id, resId: out.resId });
});
app.patch('/api/schedule/:id', (req, res) => {
  const { who, time, whenText } = req.body;
  if (!plannerNames().includes(req.authUser)) return res.status(403).json({ error: 'Only trip planners can edit the day plan' });
  // moved tombstones are not editable — the replacement row is the live one
  const row = db.prepare('SELECT * FROM day_schedule WHERE id = ? AND moved_to IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (who !== undefined) {
    if (!Array.isArray(who)) return res.status(400).json({ error: 'Invalid' });
      const _fam = allowedNames();
  const cleanWho = who.filter(n => _fam.includes(n));
    if (cleanWho.length === 0) return res.status(400).json({ error: 'Invalid members' });
    db.prepare('UPDATE day_schedule SET who = ? WHERE id = ?').run(JSON.stringify(cleanWho), row.id);
  }
  if (time !== undefined) db.prepare('UPDATE day_schedule SET time_text = ? WHERE id = ?').run(String(time||'').slice(0,10), row.id);
  if (whenText !== undefined && row.res_id) db.prepare('UPDATE reservations SET when_text = ? WHERE id = ?').run(String(whenText||'').slice(0,120), row.res_id);
  res.json({ ok: true });
});
app.delete('/api/schedule/:id', (req, res) => {
  if (!plannerNames().includes(req.authUser)) return res.status(403).json({ error: 'Only trip planners can edit the day plan' });
  // A moved tombstone must be a no-op here: deleting it would cascade to its linked
  // reservation, which the (visible) replacement row still references.
  const row = db.prepare('SELECT * FROM day_schedule WHERE id = ? AND moved_to IS NULL').get(req.params.id);
  if (!row) return res.json({ ok: true });
  let resId = row.res_id;
  if (!resId && row.activity_id && String(row.activity_id).indexOf('res:') === 0) resId = parseInt(String(row.activity_id).slice(4), 10) || null;
  db.transaction(() => {
    if (resId) {
      db.prepare('DELETE FROM reservations WHERE id = ?').run(resId);
      db.prepare('DELETE FROM day_schedule WHERE res_id = ? OR activity_id = ?').run(resId, 'res:' + resId);
    }
    db.prepare('DELETE FROM day_schedule WHERE id = ?').run(row.id);
  })();
  res.json({ ok: true });
});

// Move a plan item to another day. NOT a mutating UPDATE: the original row is kept as a
// tombstone (moved_to = replacement id) and a fresh row is inserted on the target day —
// so the plan's history survives and offline replays stay safe (X-Op-Id dedupe applies).
app.post('/api/dayplan/move', (req, res) => {
  const { schedule_id, target_day, time_text } = req.body || {};
  if (!plannerNames().includes(req.authUser)) return res.status(403).json({ error: 'Only trip planners can edit the day plan' });
  const id = parseInt(schedule_id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid schedule_id' });
  const t = activeTrip();
  const dayOk = t && Array.isArray(t.days) && t.days.some(d => d && String(d.id) === String(target_day));
  if (!dayOk) return res.status(400).json({ error: 'Unknown day' });
  const row = db.prepare('SELECT * FROM day_schedule WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.moved_to) return res.status(409).json({ error: 'This item was already moved' });
  const newTime = time_text === undefined || time_text === null ? (row.time_text || '') : String(time_text).slice(0, 10);
  const newId = db.transaction(() => {
    const nr = db.prepare('INSERT INTO day_schedule (day_id, activity_id, title, time_text, who, created_by, res_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(target_day).slice(0, 20), row.activity_id, row.title, newTime, row.who, req.authUser, row.res_id);
    db.prepare('UPDATE day_schedule SET moved_to = ? WHERE id = ?').run(nr.lastInsertRowid, row.id);
    return nr.lastInsertRowid;
  })();
  res.json({ ok: true, id: newId, dayId: String(target_day) });
});

// ── LIVE LOCATION (opt-in): last known position per traveler. NO history table, ever. ──
db.exec(`CREATE TABLE IF NOT EXISTS locations (
  name TEXT PRIMARY KEY, lat REAL, lng REAL, acc REAL, updated_at TEXT
)`);
const LOC_TTL_MS = 30 * 60 * 1000; // hard expiry: server-side filter is authoritative

app.post('/api/location', (req, res) => {
  const { lat, lng, acc } = req.body || {};
  const okNum = (x, lo, hi) => typeof x === 'number' && isFinite(x) && x >= lo && x <= hi;
  if (!okNum(lat, -90, 90) || !okNum(lng, -180, 180)) return res.status(400).json({ error: 'Invalid coordinates' });
  if (acc !== undefined && !okNum(acc, 0, 100000)) return res.status(400).json({ error: 'Invalid accuracy' });
  // name comes from the token (req.authUser) — never from the body
  db.prepare(`INSERT INTO locations (name, lat, lng, acc, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, acc=excluded.acc, updated_at=excluded.updated_at`)
    .run(req.authUser, lat, lng, acc === undefined ? null : acc, new Date().toISOString());
  res.json({ ok: true });
});

app.delete('/api/location', (req, res) => {
  db.prepare('DELETE FROM locations WHERE name = ?').run(req.authUser);
  res.json({ ok: true });
});

// Family-only data: the one GET that requires a token (GETs skip the auth middleware).
app.get('/api/locations', (req, res) => {
  const tok = req.get('X-Auth-Token');
  const row = tok ? _tokenUser.get(tok) : null;
  if (!row) return res.status(401).json({ error: 'Session expired — please sign in again' });
  const cutoff = Date.now() - LOC_TTL_MS;
  try { db.prepare('DELETE FROM locations WHERE updated_at < ?').run(new Date(cutoff).toISOString()); } catch (e) {}
  const out = db.prepare('SELECT * FROM locations').all()
    .map(r => ({ name: r.name, lat: r.lat, lng: r.lng, acc: r.acc, agoS: Math.round((Date.now() - Date.parse(r.updated_at)) / 1000) }))
    .filter(r => isFinite(r.agoS) && r.agoS * 1000 <= LOC_TTL_MS);
  res.json(out);
});

// ── POST-TRIP REVIEWS (retro): attendance-gated ratings + free-added items. ──
// Retro ratings NEVER overwrite pre-trip votes (interests) — both are stored,
// and the predicted-vs-actual delta is itself a finding (tools/profile-export.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, activity_id TEXT,
    attended INTEGER, rating INTEGER, reason_code TEXT, reason_note TEXT,
    comment TEXT, created_at TEXT, updated_at TEXT,
    UNIQUE(name, activity_id)
  );
  CREATE TABLE IF NOT EXISTS review_additions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, title TEXT,
    category TEXT, day TEXT, rating INTEGER, reason_code TEXT,
    reason_note TEXT, comment TEXT, created_at TEXT, updated_at TEXT
  );
`);
// created_at is CREATION time and never moves on re-answer; updated_at bumps on
// every write and is what lastReviewAt reads. Databases from the first retro
// release lack the column — add it and backfill from created_at (same
// idempotent try/catch pattern as the day_schedule/reservations migrations).
try { db.exec("ALTER TABLE reviews ADD COLUMN updated_at TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE review_additions ADD COLUMN updated_at TEXT"); } catch (e) {}
try { db.exec(`UPDATE reviews SET updated_at = created_at WHERE updated_at IS NULL;
  UPDATE review_additions SET updated_at = created_at WHERE updated_at IS NULL`); } catch (e) {}

const REVIEW_RATINGS = [3, 2, 1, -1]; // loved / good / meh / disliked
const REASON_CODES = ['service', 'crowds', 'weather', 'timing', 'logistics', 'mood', 'cost', 'activity', 'other'];

// A scheduled row is identified for review by its trip-data activity id when it
// has one, else by a synthetic 'sched:<row id>' key (booking/custom plan rows).
const reviewKey = row => (row.activity_id && String(row.activity_id)) || ('sched:' + row.id);

// Mirrors intParse in public/index.html exactly (bare entries default to 2 stars):
// the downgrade trigger compares against the vote the app itself displays.
function preTripStars(activityId, name) {
  try {
    const r = db.prepare('SELECT names FROM interests WHERE activity_id = ?').get(activityId);
    if (!r) return null;
    for (const e of JSON.parse(r.names || '[]')) {
      const s = String(e), i = s.lastIndexOf('|');
      if (i < 0) { if (s === name) return 2; continue; }
      const st = parseInt(s.slice(i + 1), 10);
      const ok = st >= 1 && st <= 3;
      const nm = ok ? s.slice(0, i) : (s.slice(0, i) || s);
      if (nm === name) return ok ? st : 2;
    }
  } catch (e) {}
  return null;
}

// Reason required for negatives/meh, or when the retro rating is below that
// traveler's own pre-trip vote (a downgrade). preStars null = no pre-trip vote.
const reasonRequired = (rating, preStars) =>
  rating === -1 || rating === 1 || (preStars !== null && rating < preStars);

// Shared validation for the reason fields. Returns { code, note } or an error string.
// A reason is always ACCEPTED when valid (a rating-2 with a note is fine) but only
// REQUIRED when the trigger fires. Only 'other' gates on the note.
function cleanReason(required, reasonCode, reasonNote) {
  if (reasonCode === undefined || reasonCode === null || reasonCode === '') {
    return required ? 'This rating needs a reason — pick the closest one' : { code: null, note: null };
  }
  if (!REASON_CODES.includes(reasonCode)) return 'Invalid reason';
  const note = String(reasonNote || '').slice(0, 300).trim() || null;
  if (reasonCode === 'other' && !note) return 'A short note is required when the reason is "other"';
  return { code: reasonCode, note };
}

// Scheduled items for one traveler (rows whose who-list includes them) + their
// saved answers. Public GET, same as /api/interests — writes are what need a token.
app.get('/api/review/items', (req, res) => {
  const name = String(req.query.name || '');
  if (!allowedNames().includes(name)) return res.status(400).json({ error: 'Unknown name' });
  const items = db.prepare('SELECT * FROM day_schedule WHERE moved_to IS NULL ORDER BY day_id ASC, time_text ASC, id ASC').all()
    .filter(r => { try { return JSON.parse(r.who || '[]').includes(name); } catch (e) { return false; } })
    .map(r => ({ activityId: reviewKey(r), dayId: r.day_id, title: r.title, timeText: r.time_text, resId: r.res_id || null }));
  const reviews = {};
  db.prepare('SELECT * FROM reviews WHERE name = ?').all(name).forEach(r => { reviews[r.activity_id] = r; });
  const additions = db.prepare('SELECT * FROM review_additions WHERE name = ? ORDER BY id ASC').all(name);
  res.json({ items, reviews, additions });
});

// Upsert one review row. The reviewer is req.authUser (trusted from the token,
// never from the body). ATTENDANCE GATE: "No" ends the item — no rating, no
// reason, no comment stored, and it is never read as a negative signal.
app.post('/api/review/item', (req, res) => {
  const name = req.authUser;
  const { activityId, attended, rating, reasonCode, reasonNote, comment } = req.body || {};
  if (!activityId || typeof activityId !== 'string') return res.status(400).json({ error: 'Invalid' });
  const known = db.prepare('SELECT id, activity_id FROM day_schedule WHERE moved_to IS NULL').all().some(r => reviewKey(r) === activityId);
  if (!known) return res.status(400).json({ error: 'Not a scheduled item' });
  if (attended !== 0 && attended !== 1) return res.status(400).json({ error: 'attended must be 0 or 1' });
  let cRating = null, cReason = null, cNote = null, cComment = null;
  if (attended === 0) {
    if (rating !== undefined && rating !== null) return res.status(400).json({ error: 'A rating needs attendance — items answered "No" are never rated' });
  } else if (rating !== undefined && rating !== null) {
    if (!REVIEW_RATINGS.includes(rating)) return res.status(400).json({ error: 'Invalid rating' });
    cRating = rating;
    const r = cleanReason(reasonRequired(cRating, preTripStars(activityId, name)), reasonCode, reasonNote);
    if (typeof r === 'string') return res.status(400).json({ error: r });
    cReason = r.code; cNote = r.note;
    cComment = String(comment || '').slice(0, 500).trim() || null;
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO reviews (name, activity_id, attended, rating, reason_code, reason_note, comment, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name, activity_id) DO UPDATE SET attended=excluded.attended, rating=excluded.rating,
      reason_code=excluded.reason_code, reason_note=excluded.reason_note, comment=excluded.comment,
      updated_at=excluded.updated_at`)
    .run(name, activityId, attended, cRating, cReason, cNote, cComment, now, now);
  res.json({ ok: true });
});

// Free-add: something they did that was never on the plan. Attended by definition,
// so a rating is required up front; the reason trigger has no pre-trip vote to
// compare against (rating -1 or 1 still requires one).
app.post('/api/review/addition', (req, res) => {
  const name = req.authUser;
  const { title, category, day, rating, reasonCode, reasonNote, comment } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  if (!REVIEW_RATINGS.includes(rating)) return res.status(400).json({ error: 'Invalid rating' });
  const r = cleanReason(reasonRequired(rating, null), reasonCode, reasonNote);
  if (typeof r === 'string') return res.status(400).json({ error: r });
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO review_additions (name, title, category, day, rating, reason_code, reason_note, comment, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, String(title).slice(0, 160).trim(), String(category || '').slice(0, 60).trim() || null,
         String(day || '').slice(0, 20).trim() || null, rating, r.code, r.note,
         String(comment || '').slice(0, 500).trim() || null, now, now);
  res.json({ ok: true, id: ins.lastInsertRowid });
});

// Per-traveler completion, admin only (same key gate as the other admin routes).
// "Done" = attended-No, or attended-Yes with a rating saved.
app.get('/api/review/status', adminGate, (req, res) => {
  const sched = db.prepare('SELECT * FROM day_schedule WHERE moved_to IS NULL').all();
  const travelers = allowedNames().map(name => {
    const keys = sched
      .filter(r => { try { return JSON.parse(r.who || '[]').includes(name); } catch (e) { return false; } })
      .map(reviewKey);
    const rows = db.prepare('SELECT * FROM reviews WHERE name = ?').all(name);
    const done = rows.filter(r => keys.includes(r.activity_id) && (r.attended === 0 || r.rating !== null)).length;
    const additions = db.prepare('SELECT COUNT(*) AS c FROM review_additions WHERE name = ?').get(name).c;
    // COALESCE covers rows written between the column landing and this read
    // (none in practice, but a null must never beat a real timestamp to MAX).
    const last = db.prepare(`SELECT MAX(t) AS t FROM (
      SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM reviews WHERE name = @n
      UNION ALL SELECT MAX(COALESCE(updated_at, created_at)) FROM review_additions WHERE name = @n
    )`).get({ n: name }).t || null;
    return { name, items: keys.length, done, additions, lastReviewAt: last };
  });
  res.json({ travelers });
});

// Housekeeping: keep the idempotency log from growing forever (drop ops older than 14 days).
function pruneOps(){ try { db.prepare('DELETE FROM processed_ops WHERE created_at < ?').run(Date.now() - 14*24*60*60*1000); } catch(e){} }
pruneOps();
setInterval(pruneOps, 24*60*60*1000);

const APP_VERSION = (() => { try { return require('./package.json').version || ''; } catch (e) { return ''; } })();
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: APP_VERSION, time: new Date().toISOString() }));
// Centralized error handler: any uncaught throw in a route lands here as clean JSON
// (Express 5 forwards both sync throws and rejected async handlers here).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Trip dashboard server on port ' + PORT));
