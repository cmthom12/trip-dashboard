/*
 * tools/lib/trip-store.js — the ONE path a trip JSON takes into trip_config,
 * shared by the server's admin import (POST /api/trip in server.js) and
 * tools/apply-trip-data.js. Both callers therefore run the exact same
 * validation and versioning; change it here, never in just one caller.
 *
 * importTripConfig(db, trip, updatedBy, opts) returns:
 *   { ok: false, errors: [...], warnings: [...] }   — nothing written
 *   { ok: false, errors, warnings, orphans: [ids] } — would strand votes
 *   { ok: true, version, warnings: [...] }          — versioned row inserted
 *
 * opts.force = true skips the orphaned-vote refusal. Callers that omit opts
 * entirely get the guard, which is the safe default.
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

// Every id a vote could legitimately be attached to: day activities and must-do
// items. Must-do ids are conventionally md_-prefixed but that is only a
// convention, so both are collected the same way.
function votableIds(trip) {
  const ids = new Set();
  (Array.isArray(trip && trip.days) ? trip.days : []).forEach(d => {
    (Array.isArray(d && d.activities) ? d.activities : []).forEach(a => {
      if (a && a.id != null) ids.add(String(a.id));
    });
  });
  (Array.isArray(trip && trip.mustDos) ? trip.mustDos : []).forEach(g => {
    (Array.isArray(g && g.items) ? g.items : []).forEach(it => {
      if (it && it.id != null) ids.add(String(it.id));
    });
  });
  return ids;
}

// Ids that carry at least one vote today but do not exist in the incoming trip.
// /api/interests keys on the raw activity id and nothing ever reconciles the
// table against trip_config, so those rows survive the import but stop being
// reachable from any screen — the stars are neither counted nor visible nor
// recoverable through the UI. Refuse instead of silently stranding them.
function orphanedVoteIds(db, trip) {
  const ids = votableIds(trip);
  let rows;
  try {
    rows = db.prepare('SELECT activity_id, names FROM interests').all();
  } catch (e) {
    return []; // no interests table yet (fresh database) — nothing to strand
  }
  const out = new Set();
  rows.forEach(r => {
    if (r.activity_id == null) return;
    let list = [];
    try { list = JSON.parse(r.names || '[]'); } catch (e) { list = []; }
    // A row emptied of votes is not worth blocking an import over.
    if (!Array.isArray(list) || !list.length) return;
    if (!ids.has(String(r.activity_id))) out.add(String(r.activity_id));
  });
  return [...out].sort();
}

function importTripConfig(db, trip, updatedBy, opts) {
  const v = validateTripData(trip);
  const errors = v.findings.filter(f => f.type === 'err').map(f => f.msg);
  const warnings = v.findings.filter(f => f.type === 'warn').map(f => f.msg);
  if (v.errors) return { ok: false, errors, warnings };
  if (!(opts && opts.force)) {
    const orphans = orphanedVoteIds(db, trip);
    if (orphans.length) {
      return {
        ok: false,
        orphans,
        errors: [orphans.length + ' id(s) already carry votes but are missing from this trip: ' +
          orphans.join(', ') + '. Those stars would be stranded — nothing in the app can reach ' +
          'them again. Re-add the ids, or import with force to accept losing the votes.'],
        warnings
      };
    }
  }
  ensureTripConfigTable(db);
  const version = (db.prepare('SELECT MAX(version) AS v FROM trip_config').get().v || 0) + 1;
  db.prepare('INSERT INTO trip_config (json, version, updated_by) VALUES (?, ?, ?)')
    .run(JSON.stringify(trip), version, updatedBy);
  return { ok: true, version, warnings };
}

module.exports = { ensureTripConfigTable, importTripConfig };
