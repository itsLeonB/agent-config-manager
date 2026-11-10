import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { openStore, writeTransaction } from './store.cjs'
import { DatabaseSync } from 'node:sqlite'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-store-test-'))
  return path.join(dir, 'dashboard.db')
}

const RUN = {
  at: '2024-01-01T00:00:00.000Z',
  provision: 'serena',
  harness: 'pi',
  tier: 'user',
  command: 'pi plugin install serena',
  exitCode: 0,
  presence: 'present',
}

test('a write that throws rolls back every row it opened with', () => {
  const db = new DatabaseSync(tempDb())
  try {
    db.exec('CREATE TABLE probe (value TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO probe (value) VALUES (?)')
    // Two statements, one helper call: the first must not survive the second failing, or the
    // "transaction" is autocommit under another name.
    assert.throws(() =>
      writeTransaction(db, () => {
        insert.run('landed')
        insert.run(null)
      }),
    )
    assert.deepStrictEqual(db.prepare('SELECT value FROM probe').all(), [])
    // And the connection is usable afterwards, which is what the rollback is for.
    writeTransaction(db, () => insert.run('after'))
    assert.deepStrictEqual(
      db.prepare('SELECT value FROM probe').all().map((row) => row.value),
      ['after'],
    )
  } finally {
    db.close()
  }
})

test('a write that fails leaves no run behind, and the next run still lands', () => {
  const store = openStore(tempDb())
  try {
    // `presence` is NOT NULL, so this INSERT fails inside the transaction the store opened. A
    // transaction left open by a missing rollback fails the next write instead of this one.
    assert.throws(() => store.recordRun({ ...RUN, presence: null }))
    assert.deepStrictEqual(store.readLatestRuns(), [])
    store.recordRun(RUN)
    assert.strictEqual(store.readLatestRuns().length, 1)
  } finally {
    store.close()
  }
})

test('two openers both write the same file without SQLITE_BUSY', () => {
  const file = tempDb()
  const one = openStore(file)
  const two = openStore(file)
  try {
    for (let index = 0; index < 20; index++) {
      one.saveSnapshot('local', { from: 'one', index })
      two.saveSnapshot('local', { from: 'two', index })
      one.writeConfig('scanIntervalMinutes', index)
      two.writeConfig('skipPaths', [String(index)])
      one.recordRun({ ...RUN, exitCode: index })
      two.recordRun({ ...RUN, command: 'other', exitCode: index })
    }
    assert.deepStrictEqual(one.readLatestSnapshot('local'), { from: 'two', index: 19 })
    assert.strictEqual(two.readConfig('scanIntervalMinutes'), 19)
    assert.deepStrictEqual(one.readConfig('skipPaths'), ['19'])
    const runs = two.readLatestRuns()
    assert.strictEqual(runs.length, 1)
    assert.strictEqual(runs[0].exitCode, 19)
  } finally {
    one.close()
    two.close()
  }
})

test('a saved snapshot reads back', () => {
  const store = openStore(tempDb())
  try {
    store.saveSnapshot('local', { generatedAt: '2024-01-01T00:00:00.000Z', projects: [{ name: 'a' }] })
    assert.deepStrictEqual(store.readLatestSnapshot('local'), {
      generatedAt: '2024-01-01T00:00:00.000Z',
      projects: [{ name: 'a' }],
    })
  } finally {
    store.close()
  }
})

test('the newest snapshot wins, independently per kind', () => {
  const store = openStore(tempDb())
  try {
    assert.strictEqual(store.readLatestSnapshot('local'), null)

    store.saveSnapshot('local', { n: 1 })
    store.saveSnapshot('other', { n: 'other-1' })
    store.saveSnapshot('local', { n: 2 })

    assert.deepStrictEqual(store.readLatestSnapshot('local'), { n: 2 })
    assert.deepStrictEqual(store.readLatestSnapshot('other'), { n: 'other-1' })
    assert.strictEqual(store.readLatestSnapshot('nope'), null)
  } finally {
    store.close()
  }
})

test('history is retained across reopens', () => {
  const file = tempDb()
  const first = openStore(file)
  first.saveSnapshot('local', { n: 1 })
  first.saveSnapshot('local', { n: 2 })
  first.close()

  const second = openStore(file)
  try {
    assert.deepStrictEqual(second.readLatestSnapshot('local'), { n: 2 })
  } finally {
    second.close()
  }
})

test('config round-trips and overwrites', () => {
  const store = openStore(tempDb())
  try {
    assert.strictEqual(store.readConfig('scanIntervalMinutes'), null)

    store.writeConfig('scanIntervalMinutes', 30)
    store.writeConfig('skipPaths', ['/a', '/b'])
    assert.strictEqual(store.readConfig('scanIntervalMinutes'), 30)
    assert.deepStrictEqual(store.readConfig('skipPaths'), ['/a', '/b'])

    store.writeConfig('scanIntervalMinutes', 5)
    assert.strictEqual(store.readConfig('scanIntervalMinutes'), 5)
  } finally {
    store.close()
  }
})

test('a version 1 database keeps its snapshots and settings, and loses the inventory tables', () => {
  const file = tempDb()
  // The database the previous engine left behind: the dashboard's two tables holding rows, plus the
  // four inventory tables that are now dropped.
  const legacy = new DatabaseSync(file)
  legacy.exec(`
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE installations (id TEXT PRIMARY KEY);
    CREATE TABLE bindings (installation_id TEXT NOT NULL REFERENCES installations(id));
    CREATE TABLE operations (id TEXT PRIMARY KEY);
    CREATE TABLE tier_health (harness TEXT NOT NULL);
    PRAGMA user_version = 1;
    INSERT INTO snapshots (created_at, kind, data) VALUES ('2024-01-01T00:00:00.000Z', 'local', '{"n":1}');
    INSERT INTO config (key, value) VALUES ('scanIntervalMinutes', '30');
  `)
  legacy.close()

  const store = openStore(file)
  try {
    assert.deepStrictEqual(store.readLatestSnapshot('local'), { n: 1 })
    assert.strictEqual(store.readConfig('scanIntervalMinutes'), 30)
  } finally {
    store.close()
  }

  const migrated = new DatabaseSync(file)
  try {
    const tables = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)
    assert.deepEqual(tables, ['config', 'runs', 'snapshots'])
    assert.strictEqual(migrated.prepare('PRAGMA user_version').get().user_version, 3)
  } finally {
    migrated.close()
  }
})

test('a version 2 database gains runs and keeps its dashboard rows', () => {
  const file = tempDb()
  // The database as migration 2 left it: snapshots and config holding rows, no runs yet.
  const previous = new DatabaseSync(file)
  previous.exec(`
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 2;
    INSERT INTO snapshots (created_at, kind, data) VALUES ('2024-01-01T00:00:00.000Z', 'local', '{"n":2}');
    INSERT INTO config (key, value) VALUES ('skipPaths', '["/tmp"]');
  `)
  previous.close()

  const store = openStore(file)
  try {
    assert.deepStrictEqual(store.readLatestSnapshot('local'), { n: 2 })
    assert.deepStrictEqual(store.readConfig('skipPaths'), ['/tmp'])
    assert.deepEqual(store.readLatestRuns(), [])
    store.recordRun({
      at: '2024-01-02T00:00:00.000Z',
      provision: 'serena',
      harness: 'pi',
      tier: 'user',
      command: 'pi plugin install serena',
      exitCode: 0,
      presence: 'present',
    })
  } finally {
    store.close()
  }

  const migrated = new DatabaseSync(file)
  try {
    assert.strictEqual(migrated.prepare('PRAGMA user_version').get().user_version, 3)
    const tables = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)
    assert.deepEqual(tables, ['config', 'runs', 'snapshots'])
  } finally {
    migrated.close()
  }
})

test('a run reads back whole, and only the newest run per entry is the latest', () => {
  const file = tempDb()
  const store = openStore(file)
  try {
    assert.deepEqual(store.readLatestRuns(), [])

    store.recordRun({
      at: '2024-01-01T00:00:00.000Z',
      provision: 'serena',
      harness: 'pi',
      tier: 'user',
      command: 'pi plugin install serena',
      exitCode: 1,
      presence: 'absent',
    })
    store.recordRun({
      at: '2024-01-02T00:00:00.000Z',
      provision: 'serena',
      harness: 'codex',
      tier: 'project',
      command: 'python3 merge-codex-mcp.py serena',
      exitCode: null,
      presence: 'unknown',
    })
    store.recordRun({
      at: '2024-01-03T00:00:00.000Z',
      provision: 'serena',
      harness: 'pi',
      tier: 'user',
      command: 'pi plugin install serena',
      exitCode: 0,
      presence: 'present',
    })

    // `exitCode` null is a command a signal ended, and it comes back as null rather than as 0.
    assert.deepEqual(store.readLatestRuns(), [
      {
        at: '2024-01-03T00:00:00.000Z',
        provision: 'serena',
        harness: 'pi',
        tier: 'user',
        command: 'pi plugin install serena',
        exitCode: 0,
        presence: 'present',
      },
      {
        at: '2024-01-02T00:00:00.000Z',
        provision: 'serena',
        harness: 'codex',
        tier: 'project',
        command: 'python3 merge-codex-mcp.py serena',
        exitCode: null,
        presence: 'unknown',
      },
    ])
  } finally {
    store.close()
  }

  // History is the point: a reopen still answers with the run, and the newest is the one read.
  const reopened = openStore(file)
  try {
    assert.equal(reopened.readLatestRuns().length, 2)
    assert.equal(reopened.readLatestRuns()[0].at, '2024-01-03T00:00:00.000Z')
  } finally {
    reopened.close()
  }
})

test('a read during a write returns the old or the new snapshot, never a corrupt one', async () => {
  const file = tempDb()
  const store = openStore(file)
  const pad = 'x'.repeat(20_000)
  store.saveSnapshot('local', { marker: 'old', pad })

  const writer = `
    const { openStore } = require(${JSON.stringify(path.join(import.meta.dirname, 'store.cjs'))})
    const store = openStore(process.env.ACM_TEST_DB)
    for (let i = 0; i < 200; i++) {
      store.saveSnapshot('local', { marker: i % 2 === 0 ? 'new' : 'old', pad: ${JSON.stringify(pad)} })
    }
    store.close()
  `
  const child = spawn(process.execPath, ['-e', writer], {
    env: { ...process.env, ACM_TEST_DB: file },
    stdio: 'inherit',
  })
  let exited = false
  const done = new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      exited = true
      if (code === 0) resolve()
      else reject(new Error(`writer exited with ${code}`))
    })
    child.on('error', reject)
  })

  try {
    for (let reads = 0; !exited && reads < 5000; reads++) {
      const snapshot = store.readLatestSnapshot('local')
      // A torn write would surface as a parse error or a truncated payload.
      assert.ok(snapshot !== null)
      assert.ok(snapshot.marker === 'old' || snapshot.marker === 'new')
      assert.strictEqual(snapshot.pad, pad)
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    await done
    store.close()
  }
})
