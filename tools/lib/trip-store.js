/*
 * tools/lib/trip-store.js — the ONE path a trip JSON takes into trip_config,
 * shared by the server's admin import (POST /api/trip in server.js) and
 * tools/apply-trip-data.js. Both callers therefore run the exact same
 * validation and versioning; change it here, never in just one caller.
 *
 * importTripConfig(db, trip, updatedBy) returns:
 *   { ok: false, errors: [...], warnings: [...] }   — nothing written
 *   { ok: true, version, warnings: [...] }          — versioned row inserted
 */
'use strict';
const { validateTripData } = require('./validate.js');

// Same statement server.js runs at boot — kept here so a standalone caller
// (the apply tool against a pre-trip_config data.db) can create the table.
const TRIP_CONFIG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS trip_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT, version INTEGER,
  updated_by TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;
const ensureTripConfigTable = db => db.exec(TRIP_CONFIG_TABLE_SQL);

function importTripConfig(db, trip, updatedBy) {
  const v = validateTripData(trip);
  const errors = v.findings.filter(f => f.type === 'err').map(f => f.msg);
  const warnings = v.findings.filter(f => f.type === 'warn').map(f => f.msg);
  if (v.errors) return { ok: false, errors, warnings };
  ensureTripConfigTable(db);
  const version = (db.prepare('SELECT MAX(version) AS v FROM trip_config').get().v || 0) + 1;
  db.prepare('INSERT INTO trip_config (json, version, updated_by) VALUES (?, ?, ?)')
    .run(JSON.stringify(trip), version, updatedBy);
  return { ok: true, version, warnings };
}

module.exports = { ensureTripConfigTable, importTripConfig };
