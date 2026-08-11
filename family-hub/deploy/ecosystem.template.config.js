// family-hub/deploy/ecosystem.template.config.js — PM2 config for the
// family-facing portal.
//
// On the droplet:  cp deploy/ecosystem.template.config.js /var/www/family-hub/ecosystem.config.js
//                  cd /var/www/family-hub && pm2 start ecosystem.config.js && pm2 save
// Reload after a config change with:  pm2 reload ecosystem.config.js
//
// It must be copied to the APP dir, not run from deploy/: it reads .env from
// its own __dirname, which is /var/www/family-hub once copied. Same reader
// pattern as admin-hub/ecosystem.template.config.js and
// deploy/ecosystem.template.config.js; a missing .env fails the load loudly.
//
// The env block below is an ALLOWLIST, not a passthrough of the whole .env: a
// key that isn't named here never reaches process.env, however correct the .env
// line is. That is why FAMILY_SSO_SECRET/FAMILY_NAMES/COOKIE_DOMAIN appear
// explicitly — forget one and SSO silently stays off after a reload.
//
// HAZARD: cwd must be /var/www/family-hub — NEVER under /var/www/trips (the
// portal would self-discover and backup-all.sh would sweep it).
'use strict';
const fs = require('fs');
const path = require('path');

function readEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error('family-hub ecosystem: cannot read ' + file + ' (' + e.code + ') — create it from family-hub/deploy/env.template, chmod 600'); }
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

if (!ENV.FAMILY_SSO_SECRET) {
  // matches server.js behavior: empty secret = family SSO disabled. The portal
  // still signs people in, but issues no cookie, so trips keep asking for a PIN.
  console.warn('family-hub ecosystem: FAMILY_SSO_SECRET is empty in .env — family SSO is DISABLED (no fam_sso cookie is issued).');
}

module.exports = {
  apps: [{
    name: 'family-hub',
    script: 'server.js',
    cwd: __dirname,
    env: {
      PORT: ENV.PORT || 3011,
      TRIPS_DIR: ENV.TRIPS_DIR || '/var/www/trips',
      PUBLIC_SUFFIX: ENV.PUBLIC_SUFFIX || 'example.com',
      FAMILY_NAMES: ENV.FAMILY_NAMES || '',
      FAMILY_SSO_SECRET: ENV.FAMILY_SSO_SECRET || '',
      COOKIE_DOMAIN: ENV.COOKIE_DOMAIN || '',
      // Empty = PINs stay on the legacy bare-sha256 scheme (no behavior change).
      // Set it and portal users migrate to peppered hashes as they next sign in.
      PIN_PEPPER: ENV.PIN_PEPPER || '',
      // '1' = only names that already have a PIN may sign in (first-claim off).
      FAMILY_ROSTER_LOCKED: ENV.FAMILY_ROSTER_LOCKED || '',
      NODE_ENV: ENV.NODE_ENV || 'production'
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '300M'
  }]
};
