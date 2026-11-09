import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parse as parseToml } from 'smol-toml'
import type { EngineConfig } from './config.ts'
import { stripJsonc } from './adapters/opencode/read.ts'
import { listInstallations, setupSelf } from './service.ts'
import type { SetupReport } from './service.ts'

const BIN = '/opt/acm/bin/acm'

// A home with the Pi and Codex config directories and no OpenCode one: the first run on a machine
// that has never run OpenCode is the case the user scope has to survive.
function fixture(): EngineConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-setup-test-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  for (const dir of [
    [home, '.pi', 'agent'],
    [home, '.codex'],
    [projectRoot],
  ]) {
    fs.mkdirSync(path.join(...dir), { recursive: true })
  }
  return { home, projectRoot, storePath: path.join(root, 'dashboard.db') }
}

function piFile(config: EngineConfig): string {
  return path.join(config.home, '.pi', 'agent', 'mcp.json')
}

function codexFile(config: EngineConfig): string {
  return path.join(config.home, '.codex', 'config.toml')
}

function openCodeFile(config: EngineConfig): string {
  return path.join(config.home, '.config', 'opencode', 'opencode.json')
}

function readJson(file: string): { mcpServers?: Record<string, Entry>; mcp?: { servers?: Record<string, Entry> } } {
  return JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')))
}

type Entry = { command: string | string[]; args?: string[]; type?: string; enabled?: boolean; disabled?: boolean }

// The CLI's own environment: every root is the fixture's, so nothing reaches the real home, and
// `CODEX_HOME` is stated for the same reason — an ambient one would point Codex elsewhere.
function cliEnv(config: EngineConfig) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    ACM_HOME: config.home,
    ACM_PROJECT_ROOT: config.projectRoot,
    ACM_STORE: config.storePath,
    CODEX_HOME: path.join(config.home, '.codex'),
  }
}

// The bin sees itself as `argv[1]`, which is what setup records and what a harness would spawn, so
// the entry is run as the script rather than an import.
function runCli(bin: string, config: EngineConfig, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bin, 'setup', ...args], {
    encoding: 'utf8',
    env: { ...cliEnv(config), ...env },
  })
}

// An entry inside the fixture that stands in for the installed bin: same CLI, its own mode and
// shebang, so a test never changes the permissions of a file in the working tree.
function isolatedBin(config: EngineConfig, shebang: string, mode = 0o755): string {
  const bin = path.join(path.dirname(config.storePath), 'acm.mjs')
  const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  fs.writeFileSync(bin, `${shebang}\nawait import(${JSON.stringify(cli)})\n`)
  fs.chmodSync(bin, mode)
  return bin
}

test('setup writes the absolute bin path and the server arguments into all three harnesses', () => {
  const config = fixture()

  const report = setupSelf(config, BIN)

  assert.deepEqual(
    report.harnesses.map((harness) => [harness.harness, harness.refused, harness.applied?.outcome]),
    [
      ['pi', null, 'applied'],
      ['codex', null, 'applied'],
      ['opencode', null, 'applied'],
    ],
  )
  // One entry per harness, exactly as the spec settles it: the absolute bin plus the server
  // arguments, and no working directory for a harness to spawn it from.
  assert.deepEqual(readJson(piFile(config)).mcpServers, {
    acm: { command: BIN, args: ['mcp', 'serve'], enabled: true },
  })
  assert.deepEqual(parseToml(fs.readFileSync(codexFile(config), 'utf8')), {
    mcp_servers: { acm: { command: BIN, args: ['mcp', 'serve'], enabled: true } },
  })
  assert.deepEqual(readJson(openCodeFile(config)).mcp, {
    servers: { acm: { type: 'local', command: [BIN, 'mcp', 'serve'], disabled: false } },
  })
})

test('a second setup reports the entry as already present and writes nothing', () => {
  const config = fixture()
  setupSelf(config, BIN)
  const bytes = [piFile(config), codexFile(config), openCodeFile(config)].map((file) =>
    fs.readFileSync(file, 'utf8'),
  )

  const report = setupSelf(config, BIN)

  assert.deepEqual(
    report.harnesses.map((harness) => [
      harness.plan?.disposition.kind,
      harness.applied?.outcome,
      harness.applied?.landed.length,
    ]),
    [
      ['alreadyPresent', 'applied', 0],
      ['alreadyPresent', 'applied', 0],
      ['alreadyPresent', 'applied', 0],
    ],
  )
  assert.deepEqual(
    [piFile(config), codexFile(config), openCodeFile(config)].map((file) =>
      fs.readFileSync(file, 'utf8'),
    ),
    bytes,
  )
})

test('ACM is an ordinary MCP installation in the inventory afterwards', () => {
  const config = fixture()
  setupSelf(config, BIN)

  const rows = listInstallations(config, {}).installations
    .filter((row) => row.name === 'acm')
    .map((row) => [row.category, row.scope, row.nativeFile, row.knownFieldsJson])
    .sort()

  assert.deepEqual(
    rows,
    [piFile(config), codexFile(config), openCodeFile(config)]
      .map((file) => [
        'mcp',
        'user',
        file,
        JSON.stringify({ transport: 'stdio', command: BIN, args: ['mcp', 'serve'], enabled: true }),
      ])
      .sort(),
  )
})

test('a harness that cannot be written is refused before any write, and the rest still install', () => {
  const config = fixture()
  const before = ['[mcp_servers.other]', "command = 'other'", ''].join('\n')
  fs.writeFileSync(codexFile(config), before)
  fs.chmodSync(codexFile(config), 0o444)

  try {
    const report = setupSelf(config, BIN)
    const codex = report.harnesses.find((harness) => harness.harness === 'codex')

    assert.match(codex?.applied?.reason ?? '', /read-only/)
    assert.deepEqual(codex?.applied?.landed, [])
    assert.equal(fs.readFileSync(codexFile(config), 'utf8'), before)
    assert.deepEqual(
      report.harnesses.filter((harness) => harness.harness !== 'codex').map((harness) => harness.applied?.outcome),
      ['applied', 'applied'],
    )
  } finally {
    fs.chmodSync(codexFile(config), 0o644)
  }
})

test('setup installs into a config directory that does not exist yet', () => {
  const config = fixture()
  assert.equal(fs.existsSync(path.join(config.home, '.config', 'opencode')), false)

  setupSelf(config, BIN)

  assert.deepEqual(readJson(openCodeFile(config)).mcp, {
    servers: { acm: { type: 'local', command: [BIN, 'mcp', 'serve'], disabled: false } },
  })
})

test('the entry the CLI writes is the bin it was run as, and that entry speaks MCP', async () => {
  const config = fixture()
  const bin = isolatedBin(config, '#!/usr/bin/env bun')

  const first = runCli(bin, config, [])
  assert.equal(first.status, 0, first.stderr)
  const entry = readJson(piFile(config)).mcpServers?.acm
  assert.deepEqual(entry, { command: fs.realpathSync(bin), args: ['mcp', 'serve'], enabled: true })

  // The launch the config names is the launch that is tried: nothing here knows the bin path.
  const transport = new StdioClientTransport({
    command: fs.realpathSync(bin),
    args: ['mcp', 'serve'],
    env: cliEnv(config),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'acm-setup-test', version: '0.0.0' })
  await client.connect(transport)
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'apply_plan',
      'inspect_installation',
      'list_installations',
      'plan_mirror',
      'verify_plan',
    ])
  } finally {
    await client.close()
  }

  const second = runCli(bin, config, ['--json'])
  assert.equal(second.status, 0, second.stderr)
  const report: SetupReport = JSON.parse(second.stdout)
  assert.deepEqual(
    report.harnesses.map((harness) => [harness.plan?.disposition.kind, harness.applied?.landed.length]),
    [
      ['alreadyPresent', 0],
      ['alreadyPresent', 0],
      ['alreadyPresent', 0],
    ],
  )
})

test('the CLI refuses a bin that a harness could not spawn, and writes nothing', () => {
  // The exec bit first, then the interpreter its shebang names through `env`: a bin naming an
  // interpreter that is not on the PATH it will be spawned with is one no harness can start either.
  // `PATH` is given for both cases, so the second does not depend on what this machine has.
  const cases = [
    { mode: 0o644, shebang: '#!/usr/bin/env bun', path: process.env.PATH ?? '', reason: /not executable/ },
    { mode: 0o755, shebang: '#!/usr/bin/env acm-no-such-interpreter', path: '', reason: /is not on PATH/ },
  ]
  for (const refused of cases) {
    const config = fixture()
    const bin = isolatedBin(config, refused.shebang, refused.mode)

    const run = runCli(bin, config, [], { PATH: refused.path })

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, refused.reason)
    assert.equal(fs.existsSync(piFile(config)), false)
    assert.equal(fs.existsSync(codexFile(config)), false)
  }
})
