// deploy/ecosystem.template.config.js — per-instance PM2 config TEMPLATE.
//
// On the droplet:  cp ecosystem.template.config.js /var/www/trips/<name>/ecosystem.config.js
//                  edit NAME below, then:  cd /var/www/trips/<name> && pm2 start ecosystem.config.js && pm2 save
// Reload after a config change with:       pm2 reload ecosystem.config.js
// (Code deploys don't touch this file — deploy.sh restarts the process by name.)
//
// Lessons carried from the single-instance config:
//  - Start with `pm2 start ecosystem.config.js`, reload with `pm2 reload` — don't
//    hand-craft `pm2 start server.js` invocations that lose this env on resurrect.
//  - data.db lives in cwd (next to server.js) and must never be deleted on
//    restart — PM2 doesn't touch it.
//
// Secrets/ports live in <instance-dir>/.env (created from deploy/env.template,
// chmod 600). They are parsed HERE, at pm2 load time, by the dependency-free
// reader below — missing or unreadable .env fails the load loudly on purpose.

const fs = require('fs');
const path = require('path');

const NAME = 'trip-a'; // <-- instance name; pm2 process becomes trip-<name> (no double trip- prefix)
const DIR = __dirname; // instance dir = where this file lives (/var/www/trips/<name>)

// ── minimal .env reader (KEY=VALUE lines, # comments, no quoting/expansion) ──
function readEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error('ecosystem: cannot read ' + file + ' (' + e.code + ') — create it from deploy/env.template, chmod 600'); }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}
const ENV = readEnv(path.join(DIR, '.env'));

if (!ENV.ADMIN_KEY) {
  // matches server.js behavior: empty ADMIN_KEY = admin console disabled,
  // every /api/admin/* route answers 404 and admin stays invisible.
  console.warn('ecosystem[' + NAME + ']: ADMIN_KEY is empty in .env — the admin console is DISABLED (all /api/admin/* routes 404).');
}

module.exports = {
  apps: [{
    name: 'trip-' + NAME.replace(/^trip-/, ''),
    script: 'server.js',
    cwd: DIR,
    env: {
      PORT: ENV.PORT || 3000,
      NODE_ENV: ENV.NODE_ENV || 'production',
      ADMIN_KEY: ENV.ADMIN_KEY || '',
      CORS_ORIGIN: ENV.CORS_ORIGIN || '',
      FAMILY_SSO_SECRET: ENV.FAMILY_SSO_SECRET || ''
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '300M'
  }]
};
