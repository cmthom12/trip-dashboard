// admin-hub/ecosystem.template.config.js — PM2 config for the aggregate hub.
//
// On the droplet:  cp ecosystem.template.config.js /var/www/admin-hub/ecosystem.config.js
//                  cd /var/www/admin-hub && pm2 start ecosystem.config.js && pm2 save
// Reload after a config change with:  pm2 reload ecosystem.config.js
//
// Reads PORT/NODE_ENV from /var/www/admin-hub/.env (from env.template, chmod
// 600) — same reader pattern as deploy/ecosystem.template.config.js; missing
// .env fails the load loudly. Deliberately NO ADMIN_KEY: the hub holds no
// secrets (the key comes from the operator's browser per request).
//
// HAZARD: cwd must be /var/www/admin-hub — NEVER under /var/www/trips (the
// hub would self-discover and backup-all.sh would sweep it).
'use strict';
const fs = require('fs');
const path = require('path');

function readEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error('admin-hub ecosystem: cannot read ' + file + ' (' + e.code + ') — create it from admin-hub/env.template, chmod 600'); }
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
const ENV = readEnv(path.join(__dirname, '.env'));

module.exports = {
  apps: [{
    name: 'admin-hub',
    script: 'server.js',
    cwd: __dirname,
    env: {
      PORT: ENV.PORT || 3010,
      NODE_ENV: ENV.NODE_ENV || 'production'
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '300M'
  }]
};
