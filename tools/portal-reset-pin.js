#!/usr/bin/env node
// tools/portal-reset-pin.js — clear one person's family-portal PIN.
//
// The portal (family-hub) holds a single credential per family member in its
// own data.db. There is no admin console there and no "forgot PIN" flow by
// design, so this is the whole recovery story: delete the row, and the next
// visit to the portal re-claims that name as a first-time PIN set.
//
// It touches ONLY family-hub/data.db. Trip instances are untouched — their
// sessions are separate, and any fam_sso cookie already in a phone's browser
// stays valid until it expires (the cookie is self-contained; revoking it
// would need the shared secret rotated, see deploy/sync-sso-secret.sh).
'use strict';
const path = require('path');
const fs = require('fs');

const HELP = `
portal-reset-pin — clear one family-portal PIN so it can be set again

  node portal-reset-pin.js <name> [--db <path>] [--list]

  <name>        the person as spelled in the portal's FAMILY_NAMES
  --db <path>   the portal database. Default order:
                  1. --db <path>
                  2. $PORTAL_DB
                  3. <this file>/../family-hub/data.db   (repo layout)
  --list        show the names that currently have a PIN, then exit
  -h, --help    this text

On the droplet the portal lives in /var/www/family-hub, which is NOT next to
this script, so pass the path (or set PORTAL_DB):

  PORTAL_DB=/var/www/family-hub/data.db node portal-reset-pin.js Alex

better-sqlite3 is resolved the normal way, so run it from somewhere that has
one: the repo root locally, or copy this file into /var/www/family-hub (which
has its own node_modules) on the droplet.

Afterwards, tell them to open the portal and pick their name — it will offer
"set PIN" again. Nothing else about them changes.
`.trim();

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log(HELP);
  process.exit(argv.length ? 0 : 1);
}

let name = '';
let dbPath = process.env.PORTAL_DB || path.join(__dirname, '..', 'family-hub', 'data.db');
let list = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--db') {
    dbPath = argv[++i];
    if (!dbPath) { console.error('portal-reset-pin: --db needs a path'); process.exit(2); }
  } else if (a === '--list') {
    list = true;
  } else if (a.startsWith('-')) {
    console.error(`portal-reset-pin: unknown option '${a}' (see --help)`);
    process.exit(2);
  } else if (!name) {
    name = a;
  } else {
    console.error('portal-reset-pin: only one name at a time');
    process.exit(2);
  }
}

if (!fs.existsSync(dbPath)) {
  console.error(`portal-reset-pin: no portal database at ${dbPath}`);
  console.error('Pass --db <path> or set PORTAL_DB (see --help).');
  process.exit(2);
}

let Database;
try { Database = require('better-sqlite3'); }
catch (e) {
  console.error('portal-reset-pin: cannot load better-sqlite3 — run this from the repo root or from /var/www/family-hub (see --help).');
  process.exit(2);
}

const db = new Database(dbPath);
// A portal db that predates v1.1.0 (or a wrong path pointed at some other
// database) has no users table — say so rather than crashing on the query.
const hasUsers = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
if (!hasUsers) {
  console.error(`portal-reset-pin: ${dbPath} has no users table — is this the portal's data.db?`);
  process.exit(2);
}

const claimed = db.prepare('SELECT name FROM users ORDER BY name').all().map(r => r.name);
if (list) {
  console.log(claimed.length ? 'PINs set for: ' + claimed.join(', ') : 'No PINs are set yet.');
  process.exit(0);
}
if (!name) { console.error('portal-reset-pin: give a name (or --list). See --help.'); process.exit(2); }

const removed = db.prepare('DELETE FROM users WHERE name = ?').run(name).changes;
if (!removed) {
  console.log(`No PIN was set for "${name}" — nothing to clear.`);
  if (claimed.length) console.log('Names that do have one: ' + claimed.join(', '));
  process.exit(0);
}
console.log(`Cleared the portal PIN for ${name} (${dbPath}).`);
console.log('Next visit to the portal, that name offers "set PIN" again.');
