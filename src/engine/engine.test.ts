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
  for (const dir of [
    [home, '.pi', 'agent'],
    [projectRoot, '.pi'],
    [home, '.codex'],
    [projectRoot, '.codex'],
    [home, '.config', 'opencode'],
    [projectRoot, '.opencode'],
  ]) {
    fs.mkdirSync(path.join(...dir), { recursive: true })
  }
  return { home, projectRoot, storePath: path.join(root, 'dashboard.db') }
}

function userMcpFile(config: EngineConfig): string {
  return path.join(config.home, '.pi', 'agent', 'mcp.json')
}

function codexConfigFile(config: EngineConfig, scope: 'user' | 'project'): string {
  return scope === 'user'
    ? path.join(config.home, '.codex', 'config.toml')
    : path.join(config.projectRoot, '.codex', 'config.toml')
}

function opencodeConfigFile(config: EngineConfig, scope: 'user' | 'project'): string {
  return scope === 'user'
    ? path.join(config.home, '.config', 'opencode', 'opencode.jsonc')
    : path.join(config.projectRoot, 'opencode.json')
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
    scan.tierHealth.filter((health) => health.harness === 'pi').map((health) => [health.tierId, health.status]),
    [
      ['pi:user', 'ok'],
      ['pi:project', 'ok'],
    ],
  )

  const inventory = listInstallations(config, {})
  assert.equal(inventory.scannedAt, scan.scannedAt)
  // Scan time survives a filter that matches nothing: it comes from tier health, not from rows.
  assert.equal(listInstallations(config, { harness: 'codex' }).scannedAt, scan.scannedAt)
  assert.deepEqual(
    listInstallations(config, { harness: 'codex' }).installations,
    [],
  )
  assert.deepEqual(
    listInstallations(config, { scope: 'project' }).installations.map((row) => row.name),
    ['local'],
  )
  assert.deepEqual(
    listInstallations(config, { category: 'mcp' }).installations.map((row) => row.name),
    ['local', 'serena'],
  )
  assert.deepEqual(
    listInstallations(config, { category: 'skills' }).installations,
    [],
  )
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

test('one listing call returns installations from all three harnesses, filterable by harness and scope', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { piserver: { command: 'pi' } })
  fs.writeFileSync(
    codexConfigFile(config, 'user'),
    '[mcp_servers.serena]\ncommand = "serena"\nargs = ["start-mcp-server"]\n',
  )
  fs.writeFileSync(
    codexConfigFile(config, 'project'),
    '[mcp_servers.projectserver]\ncommand = "codex"\n',
  )
  fs.writeFileSync(
    opencodeConfigFile(config, 'project'),
    '{ // project scope\n  "mcp": {\n    "legacyoc": { "type": "local", "command": ["z"] },\n    "servers": { "ocserver": { "type": "local", "command": ["oc"], "disabled": true } },\n  },\n}',
  )

  const scan = discover(config)
  assert.equal(scan.installations, 5)
  // Every writable tier is measured, so a tier whose config is missing still reports `ok` instead
  // of disappearing from the health list.
  assert.deepEqual(
    scan.tierHealth.map((health) => [health.harness, health.tierId, health.status]),
    [
      ['pi', 'pi:user', 'ok'],
      ['pi', 'pi:project', 'ok'],
      ['codex', 'codex:user', 'ok'],
      ['codex', 'codex:project', 'ok'],
      ['opencode', 'oc:project', 'ok'],
      ['opencode', 'oc:user', 'ok'],
    ],
  )

  assert.deepEqual(
    listInstallations(config, { harness: 'codex' }).installations.map((row) => row.name),
    ['projectserver', 'serena'],
  )
  assert.deepEqual(
    listInstallations(config, { scope: 'project' }).installations.map((row) => row.name),
    ['legacyoc', 'ocserver', 'projectserver'],
  )
  const byName = rowsByName(config)
  assert.equal(byName.get('serena')?.nativeFile, codexConfigFile(config, 'user'))
  assert.equal(byName.get('serena')?.nativePointer, 'mcp_servers.serena')
  assert.deepEqual(byName.get('serena')?.bindings.map((binding) => binding.tierId), ['codex:user'])
  // A legacy V1 server really lives at `mcp.<name>`, so its address says so.
  assert.equal(byName.get('ocserver')?.nativePointer, 'mcp.servers.ocserver')
  assert.equal(byName.get('legacyoc')?.nativePointer, 'mcp.legacyoc')
  assert.deepEqual(byName.get('ocserver')?.bindings.map((binding) => binding.tierId), ['oc:project'])
  assert.equal(JSON.parse(byName.get('ocserver')?.knownFieldsJson ?? '{}').enabled, false)
})

test('every harness row names its tiers, their scope buckets, and which of them are writable', () => {
  const config = fixture()
  const { harnesses } = listInstallations(config, {})

  assert.deepEqual(harnesses.map((harness) => harness.harness), ['pi', 'codex', 'opencode'])
  assert.deepEqual(
    harnesses.flatMap((harness) =>
      harness.tiers.map((tier) => [tier.id, tier.scopeBucket, tier.writability]),
    ),
    [
      ['pi:user', 'user', 'writable'],
      ['pi:project', 'project', 'writable'],
      ['codex:user', 'user', 'writable'],
      ['codex:profile', 'user', 'notState'],
      ['codex:project', 'project', 'writable'],
      ['oc:project', 'project', 'writable'],
      ['oc:user', 'user', 'writable'],
      ['oc:system', 'system', 'elevationRequired'],
    ],
  )
  assert.deepEqual(
    harnesses.flatMap((harness) =>
      harness.tiers.filter((tier) => tier.writability === 'writable').map((tier) => tier.id),
    ),
    ['pi:user', 'pi:project', 'codex:user', 'codex:project', 'oc:project', 'oc:user'],
  )
  assert.deepEqual(
    listInstallations(config, { harness: 'codex' }).harnesses.map((harness) => harness.harness),
    ['codex'],
  )
})

test('a malformed OpenCode config is an unreadable tier that tombstones nothing, a clean one tombstones', () => {
  const config = fixture()
  const file = opencodeConfigFile(config, 'user')
  fs.writeFileSync(file, '{"mcp":{"servers":{"a":{"command":["x"]}}}}')
  discover(config)
  assert.ok(rowsByName(config).get('a'))

  fs.writeFileSync(file, '{ "mcp": { "servers": ')
  const broken = discover(config)
  assert.equal(broken.tierHealth.find((health) => health.tierId === 'oc:user')?.status, 'unreadable')
  assert.equal(rowsByName(config).get('a')?.removedAt, null)
  const stored = listInstallations(config, {}).tierHealth.find((health) => health.tierId === 'oc:user')
  assert.equal(stored?.status, 'unreadable')
  assert.ok(stored?.at)

  fs.writeFileSync(file, '{"mcp":{"servers":{"b":{"command":["y"]}}}}')
  discover(config)
  assert.deepEqual([...rowsByName(config).keys()], ['b'])
  const tombstoned = listInstallations(config, { includeRemoved: true }).installations.find(
    (row) => row.name === 'a',
  )
  assert.ok(tombstoned?.removedAt)
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

// Every table, its columns and constraints, and its indexes: two migration paths that disagree
// about nullability or uniqueness then show up as a diff, while the pre-existing dashboard tables
// (created before the migration, so their stored SQL text differs) still compare by structure.
function schemaOf(file: string): string[] {
  const db = new DatabaseSync(file)
  try {
    const entries: string[] = []
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    for (const table of tables) {
      const name = String(table.name)
      const columns = db
        .prepare('SELECT name, type, "notnull", pk FROM pragma_table_info(?)')
        .all(name)
        .map((column) => `${column.name} ${column.type} notnull=${column.notnull} pk=${column.pk}`)
      entries.push(`table ${name}(${columns.join(', ')})`)
      for (const index of db.prepare('SELECT name, "unique" FROM pragma_index_list(?)').all(name)) {
        const indexName = String(index.name)
        const indexColumns = db
          .prepare('SELECT name FROM pragma_index_info(?)')
          .all(indexName)
          .map((column) => String(column.name))
        entries.push(`index ${indexName} unique=${index.unique}(${indexColumns.join(', ')})`)
      }
    }
    return entries
  } finally {
    db.close()
  }
}

test('a user-tier entry with neither command nor url is not a server, a project override is', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { serena: { command: 'serena' }, toggle: { enabled: false } })
  writeMcp(path.join(config.projectRoot, '.pi', 'mcp.json'), { serena: { enabled: false } })
  discover(config)

  const names = listInstallations(config, { includeRemoved: true }).installations.map((row) => row.name)
  assert.deepEqual(names, ['serena', 'serena'])
  assert.deepEqual(
    listInstallations(config, { scope: 'project' }).installations.map((row) => row.name),
    ['serena'],
  )
})

test('credential-shaped values in a fixture are withheld from the store and the CLI output', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), {
    a: {
      command: 'x',
      env: { GITHUB_TOKEN: 'ghp_fixturetoken' },
      headers: { Authorization: 'Bearer sk-fixturetoken' },
      url: 'https://user:pass@example.test/mcp',
    },
  })
  discover(config)

  const stored = listInstallations(config, {}).installations[0]?.knownFieldsJson ?? ''
  assert.equal(stored.includes('fixturetoken'), false)
  assert.equal(stored.includes('user:pass'), false)
  assert.match(stored, /"\[withheld\]"/)

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
  assert.equal(run.stdout.includes('fixturetoken'), false)
  assert.equal(run.stdout.includes('user:pass'), false)
})

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

  const filtered = spawnSync(process.execPath, [cli, 'list', '--json', '--scope', 'project'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ACM_HOME: config.home,
      ACM_PROJECT_ROOT: config.projectRoot,
      ACM_STORE: config.storePath,
    },
  })
  assert.equal(filtered.status, 0)
  const filteredOutput: { installations: { name: string }[] } = JSON.parse(filtered.stdout)
  assert.deepEqual(filteredOutput.installations, [])
})
