'use strict';

// The only module that touches node:sqlite. Shared by the TypeScript server
// (imported as ESM) and by scan.cjs (required as CJS), so it stays plain
// CommonJS with no build step.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    key TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function openStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  // WAL plus a busy timeout lets a reader keep serving while another process
  // (the scanner) commits a snapshot, instead of failing on a locked file.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const insertSnapshot = db.prepare('INSERT INTO snapshots (created_at, kind, data) VALUES (?, ?, ?)');
  const latestSnapshot = db.prepare('SELECT data FROM snapshots WHERE kind = ? ORDER BY id DESC LIMIT 1');
  const selectConfig = db.prepare('SELECT value FROM config WHERE key = ?');
  const upsertConfig = db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
  );
  const selectComment = db.prepare('SELECT text FROM comments WHERE key = ?');
  const upsertComment = db.prepare(
    'INSERT INTO comments (key, text, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at'
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
    writeComment(key, text) {
      upsertComment.run(key, text, new Date().toISOString());
    },
    readComment(key) {
      const row = selectComment.get(key);
      return row === undefined ? null : row.text;
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openStore };
