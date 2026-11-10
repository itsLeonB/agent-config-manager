'use strict';

// The only module that touches node:sqlite. Shared by the TypeScript server
// (imported as ESM) and by scan.cjs (required as CJS), so it stays plain
// CommonJS with no build step.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// PRAGMA user_version gates these in order, so an existing dashboard.db (version 0) and a fresh
// clone reach the same schema. Nothing here is destructive: migration 1 is pure CREATE ... IF NOT
// EXISTS, which leaves the snapshot and settings rows exactly where the dashboard expects them.
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

function writeTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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

  // Re-discovery of an installation that is still on disk must keep its id, its first_seen_at and
  // its provenance, and clear the tombstone if a human added the entry back; that is why this is an
  // upsert on the id rather than a delete-and-insert.
  const upsertInstallation = db.prepare(`
    INSERT INTO installations (id, category, name, aliases, scope, native_file, native_pointer,
      content_digest, known_fields, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      aliases = excluded.aliases,
      content_digest = excluded.content_digest,
      known_fields = excluded.known_fields,
      last_seen_at = excluded.last_seen_at,
      removed_at = NULL
  `);
  const upsertBinding = db.prepare(`
    INSERT INTO bindings (installation_id, harness, tier_id, method, verification_status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (installation_id, harness, tier_id) DO UPDATE SET
      method = excluded.method,
      verification_status = excluded.verification_status
  `);
  const tombstone = db.prepare(
    'UPDATE installations SET removed_at = ? WHERE id = ? AND removed_at IS NULL'
  );
  const upsertTierHealth = db.prepare(`
    INSERT INTO tier_health (harness, tier_id, status, detail, at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (harness, tier_id) DO UPDATE SET
      status = excluded.status,
      detail = excluded.detail,
      at = excluded.at
  `);
  const liveRowsForTier = db.prepare(`
    SELECT i.id, i.native_file FROM installations i
    JOIN bindings b ON b.installation_id = i.id
    WHERE b.harness = ? AND b.tier_id = ? AND i.removed_at IS NULL
  `);
  const readTierHealth = db.prepare('SELECT * FROM tier_health ORDER BY harness, tier_id');
  const insertOperation = db.prepare(`
    INSERT INTO operations (id, at, kind, plan_id, grade, outcome, source_installation_id,
      target_installation_id, landed_writes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const readOperations = db.prepare('SELECT * FROM operations ORDER BY at, id');
  // The plan's hash persists on the target's provenance as well as on the operation row: there is no
  // plans table, so this is what ties a row back to the document that wrote it.
  const stampMirror = db.prepare(`
    UPDATE installations
    SET mirrored_from_id = ?, mirrored_plan_id = ?, mirrored_at = ?, mirrored_tool_version = ?
    WHERE id = ?
  `);
  const setBindingVerification = db.prepare(
    'UPDATE bindings SET verification_status = ? WHERE installation_id = ? AND harness = ? AND tier_id = ?'
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
    // One transaction for a whole discovery pass: installations, bindings, tombstones and tier
    // health either all land or none do, so an interrupted scan cannot leave half an inventory.
    writeDiscovery(batch) {
      writeTransaction(db, () => {
        for (const installation of batch.installations) {
          upsertInstallation.run(
            installation.id,
            installation.category,
            installation.name,
            JSON.stringify(installation.aliases),
            installation.scope,
            installation.nativeFile,
            installation.nativePointer,
            installation.contentDigest,
            installation.knownFieldsJson,
            batch.at,
            batch.at
          );
          for (const binding of installation.bindings) {
            upsertBinding.run(
              installation.id,
              binding.harness,
              binding.tierId,
              binding.method,
              binding.verificationStatus
            );
          }
        }
        for (const id of batch.tombstones) tombstone.run(batch.at, id);
        for (const health of batch.tierHealth) {
          upsertTierHealth.run(health.harness, health.tierId, health.status, health.detail, batch.at);
        }
      });
    },
    listInstallations(filter) {
      const conditions = [];
      const params = [];
      if (filter.includeRemoved !== true) conditions.push('i.removed_at IS NULL');
      if (filter.category !== undefined) {
        conditions.push('i.category = ?');
        params.push(filter.category);
      }
      if (filter.scope !== undefined) {
        conditions.push('i.scope = ?');
        params.push(filter.scope);
      }
      if (filter.harness !== undefined) {
        conditions.push(
          'EXISTS (SELECT 1 FROM bindings bh WHERE bh.installation_id = i.id AND bh.harness = ?)'
        );
        params.push(filter.harness);
      }
      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const rows = db
        .prepare(
          `SELECT i.*, b.harness, b.tier_id, b.method, b.verification_status
           FROM installations i LEFT JOIN bindings b ON b.installation_id = i.id
           ${where} ORDER BY i.category, i.name, b.harness, b.tier_id`
        )
        .all(...params);
      const byId = new Map();
      for (const row of rows) {
        let installation = byId.get(row.id);
        if (installation === undefined) {
          installation = {
            id: row.id,
            category: row.category,
            name: row.name,
            aliases: JSON.parse(row.aliases),
            scope: row.scope,
            nativeFile: row.native_file,
            nativePointer: row.native_pointer,
            contentDigest: row.content_digest,
            knownFieldsJson: row.known_fields,
            firstSeenAt: row.first_seen_at,
            lastSeenAt: row.last_seen_at,
            removedAt: row.removed_at,
            bindings: [],
          };
          byId.set(row.id, installation);
        }
        if (row.harness !== null) {
          installation.bindings.push({
            harness: row.harness,
            tierId: row.tier_id,
            method: row.method,
            verificationStatus: row.verification_status,
          });
        }
      }
      return [...byId.values()];
    },
    listLiveInstallationsForTier(harness, tierId) {
      return liveRowsForTier.all(harness, tierId).map((row) => ({
        id: row.id,
        nativeFile: row.native_file,
      }));
    },
    readTierHealth() {
      return readTierHealth.all().map((row) => ({
        harness: row.harness,
        tierId: row.tier_id,
        status: row.status,
        detail: row.detail,
        at: row.at,
      }));
    },
    // The audit row and the target's own state land together or not at all: an operation recorded
    // without its binding status would claim a write the inventory does not show.
    recordMirror(record) {
      writeTransaction(db, () => {
        insertOperation.run(
          record.id,
          record.at,
          record.kind,
          record.planId,
          record.grade,
          record.outcome,
          record.sourceInstallationId,
          record.targetInstallationId,
          JSON.stringify(record.landed)
        );
        if (record.binding === null) return;
        stampMirror.run(
          record.sourceInstallationId,
          record.planId,
          record.at,
          record.toolVersion,
          record.binding.installationId
        );
        setBindingVerification.run(
          record.binding.status,
          record.binding.installationId,
          record.binding.harness,
          record.binding.tierId
        );
      });
    },
    listOperations() {
      return readOperations.all().map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind,
        planId: row.plan_id,
        grade: row.grade,
        outcome: row.outcome,
        sourceInstallationId: row.source_installation_id,
        targetInstallationId: row.target_installation_id,
        landed: JSON.parse(row.landed_writes),
      }));
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openStore };
