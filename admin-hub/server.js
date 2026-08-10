// admin-hub/server.js — read-only aggregate admin console for every trip
// instance on one droplet. Serves one page + two JSON routes; holds NO state,
// NO database, and NO secrets: the admin key arrives from the browser per
// request (X-Admin-Key — the same header the instances' own admin gate reads)
// and is forwarded verbatim to each instance over localhost. It is never
// stored server-side and never logged.
//
// HAZARD: this hub must NEVER live under TRIPS_ROOT (/var/www/trips) — it
// would discover itself and be swept into backup-all.sh's db backups. Its
// droplet home is /var/www/admin-hub. See docs/MULTI_INSTANCE.md §ADMIN-HUB.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3010;
const TRIPS_ROOT = process.env.TRIPS_ROOT || '/var/www/trips';
const BACKUPS_ROOT = process.env.BACKUPS_ROOT || '/root/db-backups';
const FANOUT_TIMEOUT_MS = 3000;
const APP_VERSION = (() => { try { return require('./package.json').version || ''; } catch (e) { return ''; } })();

app.use(express.static(path.join(__dirname, 'public')));

// Same minimal .env reader pattern as deploy/ecosystem.template.config.js:
// KEY=VALUE lines, # comments, no quoting/expansion, CRLF-safe.
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

// Discovery, no config of its own: every TRIPS_ROOT subdirectory with a .env
// is an instance — name from the dirname, PORT + CORS_ORIGIN from the .env.
function discoverInstances() {
  let entries = [];
  try { entries = fs.readdirSync(TRIPS_ROOT, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const envPath = path.join(TRIPS_ROOT, d.name, '.env');
    let env;
    try { env = readEnv(envPath); } catch (e) { continue; } // no .env = not an instance
    const port = parseInt(env.PORT, 10);
    if (!port) continue;
    out.push({ name: d.name, port, origin: (env.CORS_ORIGIN || '').trim() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Nightly droplet backups (deploy/backup-all.sh) land OUTSIDE each instance's
// app dir, in BACKUPS_ROOT/<instance>/data.db.YYYYMMDD-HHMM — the instances'
// own /api/admin/overview can't see them, so the hub counts them here. The
// prefix match mirrors backup-all.sh's prune glob (data.db.*). An absent dir
// (local dev, or an instance never yet backed up) is 0/none, not an error.
function readBackups(name) {
  let files = [];
  const dir = path.join(BACKUPS_ROOT, name);
  try { files = fs.readdirSync(dir); } catch (e) { return { count: 0, latestMtime: null }; }
  let count = 0, latest = null;
  for (const f of files) {
    if (!f.startsWith('data.db.')) continue;
    count++;
    try {
      const m = fs.statSync(path.join(dir, f)).mtime.toISOString();
      if (!latest || m > latest) latest = m;
    } catch (e) {}
  }
  return { count, latestMtime: latest };
}

async function fetchInstance(port, route, headers) {
  const res = await fetch('http://localhost:' + port + route, {
    headers: headers || {},
    signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

// Keyless: who exists + public health per instance.
app.get('/api/instances', async (req, res) => {
  const instances = discoverInstances();
  const results = await Promise.allSettled(instances.map(i => fetchInstance(i.port, '/api/health')));
  res.json(instances.map((i, idx) => {
    const r = results[idx];
    const health = r.status === 'fulfilled'
      ? { ok: r.value.status === 200 && !!(r.value.data && r.value.data.status === 'ok'),
          status: r.value.status, version: (r.value.data && r.value.data.version) || '' }
      : { ok: false, error: 'unreachable' };
    return { name: i.name, origin: i.origin, health };
  }));
});

// Keyed fan-out: forwards X-Admin-Key verbatim; each instance's own gate
// decides (its status passes through unchanged — 401 stays 401). One dead
// instance renders as unreachable; the board never hangs or fails whole.
app.get('/api/overview', async (req, res) => {
  const key = req.get('X-Admin-Key') || '';
  const instances = discoverInstances();
  const results = await Promise.allSettled(
    instances.map(i => fetchInstance(i.port, '/api/admin/overview', { 'X-Admin-Key': key }))
  );
  // The hub holds no secrets, so it cannot verify X-Admin-Key itself — it
  // trusts the instances' verdict instead: backup metadata is included only
  // when at least one instance accepted the key on THIS fetch. Authenticated
  // callers still see backups for down/unreachable instances (exactly when
  // the droplet backups matter most); callers whom no instance accepted get
  // no backups field at all.
  const keyAccepted = results.some(r => r.status === 'fulfilled' && r.value.status === 200);
  res.json(instances.map((i, idx) => {
    const r = results[idx];
    const withBackups = row => keyAccepted ? { ...row, backups: readBackups(i.name) } : row;
    if (r.status !== 'fulfilled') return withBackups({ name: i.name, ok: false, status: 0, error: 'unreachable' });
    const ok = r.value.status === 200;
    return withBackups(ok ? { name: i.name, ok, status: 200, data: r.value.data }
                          : { name: i.name, ok, status: r.value.status,
                              error: (r.value.data && r.value.data.error) || ('HTTP ' + r.value.status) });
  }));
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: APP_VERSION, time: new Date().toISOString() }));

app.listen(PORT, () => console.log('admin-hub on port ' + PORT + ' (TRIPS_ROOT=' + TRIPS_ROOT + ')'));
