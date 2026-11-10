'use strict';

// The only module that touches node:sqlite. Shared by the TypeScript server
// (imported as ESM) and by scan.cjs (required as CJS), so it stays plain
// CommonJS with no build step.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// PRAGMA user_version gates these in order, so an existing dashboard.db (version 0) and a fresh
// clone reach the same schema. Migration 1 is pure CREATE ... IF NOT EXISTS, which leaves the
// snapshot and settings rows exactly where the dashboard expects them. Migration 2 drops the
// previous engine's inventory tables: recreating the file instead would cost more code and lose
// those saved settings. Migration 3 adds `runs`, the only history the environment keeps, and
// touches neither table the dashboard reads.
const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL,
    scope TEXT NOT NULL,
    native_file TEXT NOT NULL,
    native_pointer TEXT,
    content_digest TEXT,
    known_fields TEXT NOT NULL,
    mirrored_from_id TEXT REFERENCES installations(id),
    mirrored_plan_id TEXT,
    mirrored_at TEXT,
    mirrored_tool_version TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    removed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS installations_identity
    ON installations(category, name, scope, native_file, native_pointer);
  CREATE TABLE IF NOT EXISTS bindings (
    installation_id TEXT NOT NULL REFERENCES installations(id),
    harness TEXT NOT NULL,
    tier_id TEXT NOT NULL,
    method TEXT NOT NULL,
    verification_status TEXT NOT NULL,
    PRIMARY KEY (installation_id, harness, tier_id)
  );
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    grade TEXT NOT NULL,
    outcome TEXT NOT NULL,
    source_installation_id TEXT,
    target_installation_id TEXT,
    landed_writes TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tier_health (
    harness TEXT NOT NULL,
    tier_id TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (harness, tier_id)
  );
`,
  `
  DROP TABLE IF EXISTS bindings;
  DROP TABLE IF EXISTS installations;
  DROP TABLE IF EXISTS operations;
  DROP TABLE IF EXISTS tier_health;
`,
  // One row per executed Install command, written when that command ends. There is no stdout or
  // stderr column and there never will be: a command that prints a token must not put it here.
  // `exit_code` is nullable because a command killed by a signal never got a status of its own.
  `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    provision TEXT NOT NULL,
    harness TEXT NOT NULL,
    tier TEXT NOT NULL,
    command TEXT NOT NULL,
    exit_code INTEGER,
    presence TEXT NOT NULL
  );
`,
];

function migrate(db) {
  for (;;) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Read the version under the lock: another opener may have applied this step while the
      // transaction waited, and running a step from a stale read is what the guard prevents.
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version >= MIGRATIONS.length) {
        db.exec('COMMIT');
        return;
      }
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

// SQLite columns are snake_case and the rest of the engine is not, so the row is named here once.
function runRow(row) {
  return {
    at: row.at,
    provision: row.provision,
    harness: row.harness,
    tier: row.tier,
    command: row.command,
    exitCode: row.exit_code,
    presence: row.presence,
  };
}

function openStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  // WAL plus a busy timeout lets a reader keep serving while another process
  // (the scanner) commits a snapshot, instead of failing on a locked file.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

  const insertSnapshot = db.prepare('INSERT INTO snapshots (created_at, kind, data) VALUES (?, ?, ?)');
  const latestSnapshot = db.prepare('SELECT data FROM snapshots WHERE kind = ? ORDER BY id DESC LIMIT 1');
  const selectConfig = db.prepare('SELECT value FROM config WHERE key = ?');
  const upsertConfig = db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
  );
  const insertRun = db.prepare(
    'INSERT INTO runs (at, provision, harness, tier, command, exit_code, presence) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  // The newest id per entry is the most recent Run for it, so one query answers every Provision and
  // harness the history holds.
  const latestRuns = db.prepare(
    `SELECT at, provision, harness, tier, command, exit_code, presence FROM runs
     WHERE id IN (SELECT MAX(id) FROM runs GROUP BY provision, harness)
     ORDER BY id DESC`
  );

  return {
    saveSnapshot(kind, data) {
      insertSnapshot.run(new Date().toISOString(), kind, JSON.stringify(data));
    },
    readLatestSnapshot(kind) {
      const row = latestSnapshot.get(kind);
      return row === undefined ? null : JSON.parse(row.data);
    },
    writeConfig(key, value) {
      upsertConfig.run(key, JSON.stringify(value));
    },
    readConfig(key) {
      const row = selectConfig.get(key);
      return row === undefined ? null : JSON.parse(row.value);
    },
    recordRun(run) {
      // One INSERT, autocommitted on its own: a run that is interrupted keeps the rows of the
      // commands that had already finished, and nothing has to write them afterwards.
      insertRun.run(run.at, run.provision, run.harness, run.tier, run.command, run.exitCode, run.presence);
    },
    readLatestRuns() {
      return latestRuns.all().map(runRow);
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openStore };
