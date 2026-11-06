import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../server/store.cjs'
import type { EngineConfig } from './config.ts'
import { discover, listInstallations } from './service.ts'

interface PiServerFixture {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  description?: string
  enabled?: boolean
  timeout?: number
  exposure?: string
}

// A fixture home, a fixture project, and a temporary database are the whole environment.
function fixture(): EngineConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-engine-test-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.pi'), { recursive: true })
  return { home, projectRoot, storePath: path.join(root, 'dashboard.db') }
}

function userMcpFile(config: EngineConfig): string {
  return path.join(config.home, '.pi', 'agent', 'mcp.json')
}

function writeMcp(file: string, servers: Record<string, PiServerFixture>): void {
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }))
}

function rowsByName(config: EngineConfig): Map<string, ReturnType<typeof listInstallations>['installations'][number]> {
  const rows = listInstallations(config, {}).installations
  return new Map(rows.map((row) => [row.name, row]))
}

test('discovery records Pi MCP servers and the listing reads them back from the store', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), {
    serena: { command: 'serena', args: ['start-mcp-server'], description: 'symbol tools' },
  })
  writeMcp(path.join(config.projectRoot, '.pi', 'mcp.json'), {
    local: { url: 'https://example.test/mcp' },
  })

  const scan = discover(config)
  assert.equal(scan.installations, 2)
  assert.deepEqual(
    scan.tierHealth.map((health) => [health.tierId, health.status]),
    [
      ['pi:user', 'ok'],
      ['pi:project', 'ok'],
    ],
  )

  const inventory = listInstallations(config, {})
  assert.equal(inventory.scannedAt, scan.scannedAt)
  assert.equal(listInstallations(config, { harness: 'codex' }).scannedAt, scan.scannedAt)
  const serena = rowsByName(config).get('serena')
  assert.ok(serena)
  assert.equal(serena.category, 'mcp')
  assert.equal(serena.scope, 'user')
  assert.equal(serena.nativeFile, userMcpFile(config))
  assert.equal(serena.nativePointer, 'mcpServers.serena')
  assert.match(serena.contentDigest ?? '', /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(
    serena.bindings.map((binding) => binding.tierId),
    ['pi:user'],
  )
  assert.deepEqual(
    rowsByName(config).get('local')?.bindings.map((binding) => binding.tierId),
    ['pi:project'],
  )
})

test('re-running discovery upserts the same rows instead of duplicating them', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { serena: { command: 'serena' } })

  discover(config)
  const first = listInstallations(config, {}).installations
  discover(config)
  const second = listInstallations(config, {}).installations

  assert.equal(second.length, 1)
  assert.deepEqual(
    second.map((row) => row.id),
    first.map((row) => row.id),
  )
  assert.equal(second[0]?.firstSeenAt, first[0]?.firstSeenAt)
})

test('a hand edit updates the digest on the same row', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { serena: { command: 'serena', description: 'one' } })
  discover(config)
  const before = rowsByName(config).get('serena')

  writeMcp(userMcpFile(config), { serena: { command: 'serena', description: 'two' } })
  discover(config)
  const after = rowsByName(config).get('serena')

  assert.ok(before && after)
  assert.equal(after.id, before.id)
  assert.notEqual(after.contentDigest, before.contentDigest)
})

test('a removed server leaves the default listing but keeps its row, and re-adding revives it', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { serena: { command: 'serena' }, context7: { command: 'context7' } })
  discover(config)
  const serenaId = rowsByName(config).get('serena')?.id
  const context7Id = rowsByName(config).get('context7')?.id

  writeMcp(userMcpFile(config), { context7: { command: 'context7' } })
  discover(config)

  assert.deepEqual(
    listInstallations(config, {}).installations.map((row) => row.name),
    ['context7'],
  )
  const withRemoved = listInstallations(config, { includeRemoved: true }).installations
  const tombstoned = withRemoved.find((row) => row.name === 'serena')
  assert.equal(withRemoved.length, 2)
  assert.ok(tombstoned?.removedAt)
  assert.equal(tombstoned.id, serenaId)
  assert.equal(withRemoved.find((row) => row.name === 'context7')?.id, context7Id)

  writeMcp(userMcpFile(config), { serena: { command: 'serena' }, context7: { command: 'context7' } })
  discover(config)
  assert.equal(rowsByName(config).get('serena')?.removedAt, null)
})

test('an unreadable tier tombstones nothing and reports itself unreadable', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { serena: { command: 'serena' } })
  discover(config)

  fs.writeFileSync(userMcpFile(config), '{ "mcpServers": ')
  const scan = discover(config)

  assert.equal(scan.tierHealth.find((health) => health.tierId === 'pi:user')?.status, 'unreadable')
  assert.equal(rowsByName(config).get('serena')?.removedAt, null)
})

test('an existing dashboard database gains the canonical tables without losing its rows', () => {
  const config = fixture()
  const legacy = new DatabaseSync(config.storePath)
  legacy.exec(`
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO snapshots (created_at, kind, data) VALUES ('2024-01-01T00:00:00.000Z', 'local', '{"marker":true}');
    INSERT INTO config (key, value) VALUES ('projectsRoot', '"/projects"');
  `)
  legacy.close()

  writeMcp(userMcpFile(config), { serena: { command: 'serena' } })
  discover(config)
  discover(config)

  const reopened = openStore(config.storePath)
  try {
    assert.deepEqual(reopened.readLatestSnapshot('local'), { marker: true })
    assert.equal(reopened.readConfig('projectsRoot'), '/projects')
    assert.equal(reopened.listInstallations({}).length, 1)
  } finally {
    reopened.close()
  }

  const migrated = new DatabaseSync(config.storePath)
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 1)
  } finally {
    migrated.close()
  }

  const fresh = fixture()
  const freshStore = openStore(fresh.storePath)
  freshStore.close()
  assert.deepEqual(schemaOf(config.storePath), schemaOf(fresh.storePath))
})

// Every table and index, so one migration path landing somewhere else shows up as a diff.
function schemaOf(file: string): string[] {
  const db = new DatabaseSync(file)
  try {
    return db
      .prepare(
        "SELECT type || ':' || name AS entry FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.entry))
  } finally {
    db.close()
  }
}

test('acm list prints the stored inventory from a fixture home', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), {
    serena: { command: 'serena' },
    remote: { url: 'https://example.test/mcp' },
  })
  const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  const run = spawnSync(process.execPath, [cli, 'list', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ACM_HOME: config.home,
      ACM_PROJECT_ROOT: config.projectRoot,
      ACM_STORE: config.storePath,
    },
  })

  assert.equal(run.status, 0)
  const output: { installations: { name: string }[]; scan: { scannedAt: string } } = JSON.parse(run.stdout)
  assert.deepEqual(
    output.installations.map((row) => row.name),
    ['remote', 'serena'],
  )
  assert.ok(output.scan.scannedAt)
})
