const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.json());
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

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
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
const ALLOWED = ["Alex","Sam","Jordan","Riley","Casey"];
const LOGIN_FAILS = {}; // name -> { count, until } : in-memory brute-force lockout

app.post('/api/login', (req, res) => {
  const { name, pin } = req.body;
  if (!ALLOWED.includes(name)) return res.status(400).json({ error: 'Unknown name' });
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
    if (dayId && PLANNERS.includes(author)) {
      db.prepare('INSERT INTO day_schedule (day_id, activity_id, title, time_text, who, created_by, res_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(String(dayId).slice(0,20), '', String(title).slice(0,160), String(planTime||'').slice(0,10), JSON.stringify(ALLOWED), String(author||''), r.lastInsertRowid);
    }
    return r.lastInsertRowid;
  })();
  res.json({ ok: true, id: newId });
});
app.delete('/api/reservations/:id', (req, res) => {
  const paired = db.prepare('SELECT COUNT(*) AS c FROM day_schedule WHERE res_id = ? OR activity_id = ?')
    .get(req.params.id, 'res:' + req.params.id).c > 0;
  if (paired && !PLANNERS.includes(req.authUser)) {
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
try { db.exec("ALTER TABLE reservations ADD COLUMN created_by TEXT"); } catch (e) {}
// One-time backfill: attribute existing bookings from the day-plan row that created them.
try { db.exec(`UPDATE reservations SET created_by = (
  SELECT ds.created_by FROM day_schedule ds
  WHERE ds.res_id = reservations.id AND ds.created_by IS NOT NULL
  ORDER BY ds.id LIMIT 1
) WHERE created_by IS NULL`); } catch (e) {}
// (template: no trip-specific seed data)
const PLANNERS = ["Alex", "Sam", "Jordan", "Riley", "Casey"];
app.get('/api/schedule', (req, res) => {
  res.json(db.prepare('SELECT * FROM day_schedule ORDER BY day_id ASC, time_text ASC, id ASC').all()); 
});
app.post('/api/schedule', (req, res) => {
  const { dayId, activityId, title, time, who, whenText, resId } = req.body;
  const author = req.authUser;
  if (!PLANNERS.includes(author)) return res.status(403).json({ error: 'Only trip planners can edit the day plan' });
  if (!dayId || !title || !Array.isArray(who) || who.length === 0) return res.status(400).json({ error: 'Invalid' });
  const cleanWho = who.filter(n => ALLOWED.includes(n));
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
  if (!PLANNERS.includes(req.authUser)) return res.status(403).json({ error: 'Only trip planners can edit the day plan' });
  const row = db.prepare('SELECT * FROM day_schedule WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (who !== undefined) {
    if (!Array.isArray(who)) return res.status(400).json({ error: 'Invalid' });
    const cleanWho = who.filter(n => ALLOWED.includes(n));
    if (cleanWho.length === 0) return res.status(400).json({ error: 'Invalid members' });
    db.prepare('UPDATE day_schedule SET who = ? WHERE id = ?').run(JSON.stringify(cleanWho), row.id);
  }
  if (time !== undefined) db.prepare('UPDATE day_schedule SET time_text = ? WHERE id = ?').run(String(time||'').slice(0,10), row.id);
  if (whenText !== undefined && row.res_id) db.prepare('UPDATE reservations SET when_text = ? WHERE id = ?').run(String(whenText||'').slice(0,120), row.res_id);
  res.json({ ok: true });
});
app.delete('/api/schedule/:id', (req, res) => {
  if (!PLANNERS.includes(req.authUser)) return res.status(403).json({ error: 'Only trip planners can edit the day plan' });
  const row = db.prepare('SELECT * FROM day_schedule WHERE id = ?').get(req.params.id);
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

// Housekeeping: keep the idempotency log from growing forever (drop ops older than 14 days).
function pruneOps(){ try { db.prepare('DELETE FROM processed_ops WHERE created_at < ?').run(Date.now() - 14*24*60*60*1000); } catch(e){} }
pruneOps();
setInterval(pruneOps, 24*60*60*1000);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
// Centralized error handler: any uncaught throw in a route lands here as clean JSON
// (Express 5 forwards both sync throws and rejected async handlers here).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Trip dashboard server on port ' + PORT));
