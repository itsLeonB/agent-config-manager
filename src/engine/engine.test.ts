import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { openStore } from '../server/store.cjs'
import type { EngineConfig } from './config.ts'
import { stripJsonc } from './adapters/opencode/read.ts'
import { discover, inspectInstallation, listInstallations } from './service.ts'
import { recordDiscovery } from './repo.ts'

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
  // No harness probe in a fixture: a test must never spawn the real `opencode`.
  return { home, projectRoot, storePath: path.join(root, 'dashboard.db'), opencodeProbe: false }
}

// A stand-in for the real binary: it prints the diagnostics a test hands it, and appends to `calls`
// when one is given, so a test can assert the probe ran once and only when it should.
function probeStub(
  config: EngineConfig,
  options: {
    stderr?: string[]
    exitCode?: number
    calls?: string
    name?: string
    // A file the stub records the environment it was handed into.
    env?: string
    // Enough noise after the diagnostics to overflow `spawnSync`'s default buffer.
    overflow?: boolean
  },
): string {
  const dir = path.join(path.dirname(config.storePath), 'bin')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, options.name ?? 'opencode')
  const lines = [
    '#!/bin/sh',
    options.calls === undefined ? '' : `echo call >> '${options.calls}'`,
    options.env === undefined ? '' : `echo "$HOME|$OPENCODE_CONFIG|$XDG_CONFIG_HOME" > '${options.env}'`,
    // A quoted heredoc, so a diagnostic line reaches stderr exactly as written.
    `cat >&2 <<'EOF'\n${(options.stderr ?? []).join('\n')}\nEOF`,
    options.overflow === true
      ? `yes 'level=INFO pad' 2>/dev/null | head -c 1400000 >&2 || true`
      : '',
    `exit ${options.exitCode ?? 0}`,
  ]
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

// The default `opencode` resolution is PATH, so a stub on it stands in for an installed binary.
function stubOnPath(config: EngineConfig, options: { stderr?: string[]; exitCode?: number; calls?: string }): () => void {
  probeStub(config, options)
  const prior = process.env.PATH
  process.env.PATH = `${path.join(path.dirname(config.storePath), 'bin')}${path.delimiter}${prior ?? ''}`
  return () => {
    process.env.PATH = prior
  }
}

function probeCalls(file: string): number {
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '').length
}

function diagnostic(source: string, pointer: string): string {
  return `level=WARN message="configuration normalization diagnostic" source=${source} path=${pointer} kind=invalid action="skipped malformed recognized value"`
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

test('a listing answers from the store unless it is asked to re-scan', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { serena: { command: 'serena' } })
  discover(config)
  assert.deepEqual([...rowsByName(config).keys()], ['serena'])

  // A native file written after the scan is invisible until someone asks for a fresh read, and the
  // read that asks for one answers from the store the scan filled, like every other listing.
  writeMcp(userMcpFile(config), { serena: { command: 'serena' }, context7: { command: 'context7' } })
  assert.deepEqual([...rowsByName(config).keys()], ['serena'])
  assert.deepEqual(
    listInstallations(config, { fresh: true }).installations.map((row) => row.name).sort(),
    ['context7', 'serena'],
  )
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

test('a pass in another project leaves the first project’s project-tier rows live', () => {
  const config = fixture()
  const projectA = config.projectRoot
  const projectB = path.join(path.dirname(projectA), 'project-b')
  fs.mkdirSync(path.join(projectB, '.pi'), { recursive: true })
  writeMcp(path.join(projectA, '.pi', 'mcp.json'), { alpha: { command: 'alpha' } })
  discover({ ...config, projectRoot: projectA })

  writeMcp(path.join(projectB, '.pi', 'mcp.json'), { beta: { command: 'beta' } })
  discover({ ...config, projectRoot: projectB })

  // Project B's pass read its own file and never touched A's, so A's row is not a removal.
  const rows = new Map(
    listInstallations(config, { scope: 'project' }).installations.map((row) => [row.name, row]),
  )
  assert.ok(rows.get('alpha'))
  assert.ok(rows.get('beta'))
})

test('an entry removed from a file the pass read is still tombstoned', () => {
  const config = fixture()
  const file = path.join(config.projectRoot, '.pi', 'mcp.json')
  writeMcp(file, { alpha: { command: 'alpha' }, beta: { command: 'beta' } })
  discover(config)

  writeMcp(file, { beta: { command: 'beta' } })
  discover(config)

  assert.equal(rowsByName(config).get('alpha'), undefined)
  const removed = listInstallations(config, { includeRemoved: true }).installations.find(
    (row) => row.name === 'alpha',
  )
  assert.ok(removed?.removedAt)
})

test('a live row under a path that only shares a string prefix with a declared read survives', () => {
  const config = fixture()
  const declared = path.join(config.projectRoot, '.agents', 'skills')
  const inside = path.join(declared, 'kept', 'SKILL.md')
  const sibling = path.join(config.projectRoot, '.agents', 'skills-extra', 'kept', 'SKILL.md')
  const skill = (file: string, name: string) => ({
    category: 'skills' as const,
    name,
    scope: 'project' as const,
    tierId: 'pi:project',
    nativeFile: file,
    nativePointer: 'SKILL.md',
    knownFieldsJson: '{}',
    contentDigest: `sha256:${'d'.repeat(64)}`,
  })
  const report = (installations: ReturnType<typeof skill>[]) => [
    { harness: 'pi', tierId: 'pi:project', health: 'ok' as const, detail: null, declaredReads: [declared], installations },
  ]

  recordDiscovery(config.storePath, report([skill(inside, 'kept'), skill(sibling, 'sibling')]), '2026-01-01T00:00:00.000Z')
  // The next pass read the declared root only, so the sibling that merely shares its string prefix
  // is outside this tier's reads and stays live.
  recordDiscovery(config.storePath, report([]), '2026-01-02T00:00:00.000Z')

  const rows = new Map(
    listInstallations(config, { includeRemoved: true }).installations.map((row) => [row.name, row]),
  )
  assert.ok(rows.get('kept')?.removedAt)
  assert.equal(rows.get('sibling')?.removedAt, null)
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

// A row's native location is part of its identity and every later plan addresses it, so the pointer
// must name something that exists in the file the row came from.
function pointerResolves(file: string, pointer: string): boolean {
  const text = fs.readFileSync(file, 'utf8')
  const document: unknown = file.endsWith('.toml')
    ? parseToml(text)
    : JSON.parse(file.endsWith('.jsonc') ? stripJsonc(text) : text)
  const record = z.record(z.string(), z.unknown())
  let current: unknown = document
  for (const segment of pointer.match(/"(?:[^"\\]|\\.)*"|[^.]+/g) ?? []) {
    const step = record.safeParse(current)
    if (!step.success) return false
    current = step.data[segment.startsWith('"') ? JSON.parse(segment) : segment]
    if (current === undefined) return false
  }
  return true
}

test('every stored native pointer resolves inside the file it names', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { piserver: { command: 'pi' } })
  fs.writeFileSync(codexConfigFile(config, 'user'), '[mcp_servers.serena]\ncommand = "serena"\n')
  fs.writeFileSync(
    codexConfigFile(config, 'project'),
    '[mcp_servers."dotted.name"]\nurl = "https://example.test/mcp"\n',
  )
  fs.writeFileSync(
    opencodeConfigFile(config, 'project'),
    '{ "mcp": { "legacyoc": { "type": "local", "command": ["z"] }, "servers": { "ocserver": { "type": "local", "command": ["oc"] } } } }',
  )
  discover(config)

  const rows = listInstallations(config, { includeRemoved: true }).installations
  assert.ok(rows.length >= 5)
  for (const row of rows) {
    assert.equal(
      pointerResolves(row.nativeFile, row.nativePointer ?? ''),
      true,
      `${row.name} ${row.nativePointer} does not resolve in ${row.nativeFile}`,
    )
  }
})

test('a relocated CODEX_HOME is read instead of ~/.codex', () => {
  const config = fixture()
  const codexHome = path.join(config.home, 'elsewhere')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.relocated]\ncommand = "x"\n')
  const relocated = { ...config, codexHome }

  discover(relocated)
  const rows = listInstallations(relocated, { harness: 'codex' }).installations
  assert.deepEqual(rows.map((row) => row.name), ['relocated'])
  // The row's native file is the relocated config, not `~/.codex/config.toml`.
  assert.equal(rows[0]?.nativeFile, path.join(codexHome, 'config.toml'))
})

test('a Codex user-tier entry with neither command nor url is not a server, a project override is', () => {
  const config = fixture()
  fs.writeFileSync(
    codexConfigFile(config, 'user'),
    '[mcp_servers.serena]\ncommand = "serena"\n\n[mcp_servers.ghost]\nenabled = false\n',
  )
  fs.writeFileSync(codexConfigFile(config, 'project'), '[mcp_servers.serena]\nenabled = false\n')
  discover(config)

  assert.deepEqual([...rowsByName(config).keys()], ['serena'])
  assert.deepEqual(
    listInstallations(config, { scope: 'project' }).installations.map((row) => row.name),
    ['serena'],
  )
})

test('acm list --json --harness codex emits no other harness tier health', () => {
  const config = fixture()
  fs.writeFileSync(opencodeConfigFile(config, 'user'), '{ "mcp": ')
  const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  const run = spawnSync(process.execPath, [cli, 'list', '--json', '--harness', 'codex'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ACM_HOME: config.home,
      ACM_PROJECT_ROOT: config.projectRoot,
      ACM_STORE: config.storePath,
    },
  })

  assert.equal(run.status, 0)
  const output: { scan: { tierHealth: { harness: string; tierId: string }[] } } = JSON.parse(run.stdout)
  assert.deepEqual(
    output.scan.tierHealth.map((health) => health.tierId),
    ['codex:user', 'codex:project'],
  )
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

test('a config that parses locally but the probe rejects is unreadable and tombstones nothing', () => {
  // The default binary name, resolved through PATH: a stub on it stands in for an installed one.
  const config = { ...fixture(), opencodeProbe: undefined }
  const file = opencodeConfigFile(config, 'user')
  const calls = path.join(path.dirname(config.storePath), 'probe-calls')
  fs.writeFileSync(file, '{"mcp":{"servers":{"a":{"command":["x"]}}}}')

  let restore = stubOnPath(config, { calls })
  try {
    discover(config)
  } finally {
    restore()
  }
  assert.ok(rowsByName(config).get('a'))
  assert.equal(probeCalls(calls), 1)

  // The document still parses and still lists a server, and OpenCode now drops it: the tier says
  // nothing, so the row it no longer lists survives instead of being tombstoned.
  fs.writeFileSync(file, '{"mcp":{"servers":{"b":{"command":["y"]}}}}')
  restore = stubOnPath(config, { stderr: [diagnostic(file, '$.mcp.servers.b')] })
  let scan: ReturnType<typeof discover>
  try {
    scan = discover(config)
  } finally {
    restore()
  }

  const health = scan.tierHealth.find((row) => row.tierId === 'oc:user')
  assert.equal(health?.status, 'unreadable')
  assert.ok(health?.detail?.includes(file), health?.detail ?? '')
  assert.ok(health?.detail?.includes('$.mcp.servers.b'), health?.detail ?? '')
  assert.ok(health?.detail?.includes('skipped malformed recognized value'), health?.detail ?? '')
  assert.equal(rowsByName(config).get('a')?.removedAt, null)
  assert.equal(rowsByName(config).has('b'), false)
})

test('a config that does not parse locally is unreadable with no probe spawned', () => {
  const config = { ...fixture(), opencodeProbe: undefined }
  const calls = path.join(path.dirname(config.storePath), 'probe-calls')
  fs.writeFileSync(opencodeConfigFile(config, 'user'), '{ "mcp": { "servers": ')

  const restore = stubOnPath(config, { calls })
  let scan: ReturnType<typeof discover>
  try {
    scan = discover(config)
  } finally {
    restore()
  }

  assert.equal(scan.tierHealth.find((row) => row.tierId === 'oc:user')?.status, 'unreadable')
  assert.equal(probeCalls(calls), 0)
})

test('the probe runs once per discovery pass, and its diagnostics map to the tier they name', () => {
  const config = { ...fixture(), opencodeProbe: undefined }
  const userFile = opencodeConfigFile(config, 'user')
  const projectFile = opencodeConfigFile(config, 'project')
  fs.writeFileSync(userFile, '{"mcp":{"servers":{"a":{"command":["x"]}}}}')
  fs.writeFileSync(projectFile, '{"mcp":{"servers":{"p":{"command":["p"]}}}}')
  const calls = path.join(path.dirname(config.storePath), 'probe-calls')

  // One spawn answers both tiers: the diagnostic names the project file, so only that tier is
  // unreadable even though the same verdict covers the user tier's file too.
  const restore = stubOnPath(config, { stderr: [diagnostic(projectFile, '$.mcp.servers.p')], calls })
  let scan: ReturnType<typeof discover>
  try {
    scan = discover(config)
  } finally {
    restore()
  }

  assert.equal(probeCalls(calls), 1)
  assert.equal(scan.tierHealth.find((row) => row.tierId === 'oc:project')?.status, 'unreadable')
  assert.equal(scan.tierHealth.find((row) => row.tierId === 'oc:user')?.status, 'ok')
  assert.ok(rowsByName(config).get('a'))
  assert.equal(rowsByName(config).has('p'), false)
})

test('a probe that cannot run degrades to the local parse verdict and says so in the detail', () => {
  const missing = { ...fixture(), opencodeProbe: path.join(os.tmpdir(), 'acm-no-such-opencode') }
  fs.writeFileSync(
    opencodeConfigFile(missing, 'user'),
    '{"mcp":{"servers":{"a":{"command":["x"]}}}}',
  )
  const missingScan = discover(missing)
  const missingHealth = missingScan.tierHealth.find((row) => row.tierId === 'oc:user')
  assert.equal(missingHealth?.status, 'ok')
  assert.ok(missingHealth?.detail?.includes('probe unavailable'), missingHealth?.detail ?? '')
  assert.ok(rowsByName(missing).get('a'))

  const failing = fixture()
  fs.writeFileSync(
    opencodeConfigFile(failing, 'user'),
    '{"mcp":{"servers":{"a":{"command":["x"]}}}}',
  )
  const failingScan = discover({
    ...failing,
    opencodeProbe: probeStub(failing, { exitCode: 3 }),
  })
  const failingHealth = failingScan.tierHealth.find((row) => row.tierId === 'oc:user')
  assert.equal(failingHealth?.status, 'ok')
  assert.ok(failingHealth?.detail?.includes('exited 3'), failingHealth?.detail ?? '')
  assert.ok(rowsByName(failing).get('a'))

  // The degradation is stored, not only returned.
  const stored = listInstallations(failing, {}).tierHealth.find((row) => row.tierId === 'oc:user')
  assert.equal(stored?.detail, failingHealth?.detail)
  assert.equal(stored?.status, 'ok')
})

test('the probe judges the declared configs, not one the environment redirects it to', () => {
  const config = fixture()
  fs.writeFileSync(
    opencodeConfigFile(config, 'user'),
    '{"mcp":{"servers":{"a":{"command":["x"]}}}}',
  )
  const dump = path.join(path.dirname(config.storePath), 'probe-env')
  const redirect = process.env.OPENCODE_CONFIG
  const xdg = process.env.XDG_CONFIG_HOME
  // A shell with either of these set would send the probe to somebody else's file, whose
  // diagnostics name no declared path — so every tier would read clean however broken it is.
  process.env.OPENCODE_CONFIG = '/elsewhere/opencode.json'
  process.env.XDG_CONFIG_HOME = '/elsewhere/config'
  try {
    discover({ ...config, opencodeProbe: probeStub(config, { env: dump }) })
  } finally {
    if (redirect === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = redirect
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = xdg
  }

  assert.equal(fs.readFileSync(dump, 'utf8').trim(), `${config.home}||`)
})

test('a probe whose output overflows its buffer keeps the diagnostics it did print', () => {
  const config = fixture()
  const file = opencodeConfigFile(config, 'user')
  fs.writeFileSync(file, '{"mcp":{"servers":{"a":{"command":["x"]}}}}')

  // `spawnSync` kills the binary at its buffer limit and reports an error for it, but the rejection
  // it printed first is still the verdict: degrading here would call a rejected config clean.
  const scan = discover({
    ...config,
    opencodeProbe: probeStub(config, {
      stderr: [diagnostic(file, '$.mcp.servers.a')],
      overflow: true,
    }),
  })

  const health = scan.tierHealth.find((row) => row.tierId === 'oc:user')
  assert.equal(health?.status, 'unreadable')
  assert.ok(health?.detail?.includes('$.mcp.servers.a'), health?.detail ?? '')
})

test('a diagnostic naming the physical file matches a tier that declares a symlinked one', () => {
  const config = fixture()
  const physical = path.join(config.home, 'real-opencode')
  fs.mkdirSync(physical, { recursive: true })
  // A dotfiles-style setup: the tier's declared path is the link, OpenCode reads the real file.
  fs.rmSync(path.join(config.home, '.config', 'opencode'), { recursive: true, force: true })
  fs.symlinkSync(physical, path.join(config.home, '.config', 'opencode'))
  const file = path.join(physical, 'opencode.jsonc')
  fs.writeFileSync(file, '{"mcp":{"servers":{"a":{"command":["x"]}}}}')

  const scan = discover({
    ...config,
    opencodeProbe: probeStub(config, { stderr: [diagnostic(file, '$.mcp.servers.a')] }),
  })

  assert.equal(scan.tierHealth.find((row) => row.tierId === 'oc:user')?.status, 'unreadable')
})

test('a degraded probe and a failing read both reach the tier detail', () => {
  const config = { ...fixture(), opencodeProbe: path.join(os.tmpdir(), 'acm-no-such-opencode') }
  fs.writeFileSync(
    opencodeConfigFile(config, 'user'),
    '{"mcp":{"servers":{"a":{"command":["x"]}}}}',
  )
  // A skills root that cannot be listed makes that category unreadable after the probe degraded.
  const skillsRoot = path.join(config.home, '.agents', 'skills')
  fs.mkdirSync(path.dirname(skillsRoot), { recursive: true })
  fs.writeFileSync(skillsRoot, 'not a directory')

  const health = discover(config).tierHealth.find((row) => row.tierId === 'oc:user')

  assert.equal(health?.status, 'unreadable')
  assert.ok(health?.detail?.includes('could not be read'), health?.detail ?? '')
  assert.ok(health?.detail?.includes('probe unavailable'), health?.detail ?? '')
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
  assert.match(stored, /\[withheld: secret\]/)

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

function runCli(config: EngineConfig, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ACM_HOME: config.home,
      ACM_PROJECT_ROOT: config.projectRoot,
      ACM_STORE: config.storePath,
    },
  })
}

test('acm inspect reports a verdict in place of every credential-shaped value', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), {
    remote: {
      command: 'x',
      args: ['--api-key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'],
      env: {
        GITHUB_TOKEN: 'ghp_AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRr',
        OPENAI_API_KEY: '${OPENAI_API_KEY}',
        KEYCHAIN_TOKEN: '!op read op://vault/token',
      },
      headers: { Authorization: 'Bearer sk-AaBbCcDdEeFfGgHhIiJjKkLl' },
      url: 'https://user:pass@example.test/mcp',
      description: 'symbol tools',
    },
  })
  discover(config)

  const id = listInstallations(config, {}).installations[0]?.id ?? ''
  assert.match(id, /^sha256:[0-9a-f]{64}$/)
  const inspected = runCli(config, ['inspect', id.slice(7, 15), '--json'])
  assert.equal(inspected.status, 0)
  // A clean command-retrieval value is printed: it is the reference, not the credential.
  for (const token of ['ghp_AaBb', 'sk-proj', 'sk-AaBb', 'user:pass']) {
    assert.equal(inspected.stdout.includes(token), false, token)
  }

  const output: {
    leaves: { pointer: string; value: string }[]
    secrets: { pointer: string; verdict: string }[]
    executables: { pointer: string; why: string }[]
  } = JSON.parse(inspected.stdout)
  const leaf = (pointer: string): string | undefined =>
    output.leaves.find((candidate) => candidate.pointer === pointer)?.value

  // A reference is clean and stays itself; a command-loaded value is clean but flagged executable.
  assert.equal(leaf('env.OPENAI_API_KEY'), '${OPENAI_API_KEY}')
  assert.equal(leaf('env.KEYCHAIN_TOKEN'), '!op read op://vault/token')
  assert.deepEqual(output.executables, [{ pointer: 'env.KEYCHAIN_TOKEN', why: 'command retrieval' }])
  assert.equal(leaf('description'), 'symbol tools')
  // The address survives; only the userinfo that made it a credential is gone.
  assert.equal(leaf('url'), '[withheld: secret] https://example.test/mcp')
  assert.deepEqual(
    output.secrets.map((secret) => [secret.pointer, secret.verdict]),
    [
      ['args.1', 'secret'],
      ['env.GITHUB_TOKEN', 'secret'],
      ['url', 'secret'],
      ['headers.Authorization', 'secret'],
    ],
  )

  const text = runCli(config, ['inspect', id.slice(7, 15)])
  assert.equal(text.status, 0)
  assert.match(text.stdout, /env\.GITHUB_TOKEN = \[withheld: secret\]/)
  assert.match(text.stdout, /env\.OPENAI_API_KEY = \$\{OPENAI_API_KEY\}/)
  assert.equal(text.stdout.includes('ghp_AaBb'), false)
})

test('acm inspect refuses an id that matches nothing, and the stored row keeps the verdict', () => {
  const config = fixture()
  writeMcp(userMcpFile(config), { serena: { command: 'serena', env: { GITHUB_TOKEN: 'ghp_fixturetoken' } } })
  discover(config)

  const row = listInstallations(config, {}).installations[0]
  assert.ok(row)
  // The verdict travels with the pointer it belongs to, so no side table can drift from it.
  assert.match(row.knownFieldsJson, /"env":\{"GITHUB_TOKEN":"\[withheld: secret\]"\}/)

  const missing = runCli(config, ['inspect', 'deadbeef'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no installation matches deadbeef/)

  // The service is the face the MCP server will use, and it reads the same store.
  const service = inspectInstallation(config, row.id)
  assert.equal(service.kind, 'ok')
  assert.equal(inspectInstallation(config, 'deadbeef').kind, 'notFound')
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
