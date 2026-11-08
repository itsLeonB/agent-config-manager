import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

type Entry = { command: string | string[]; args?: string[]; type?: string }

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
    acm: { command: BIN, args: ['mcp', 'serve'] },
  })
  assert.deepEqual(parseToml(fs.readFileSync(codexFile(config), 'utf8')), {
    mcp_servers: { acm: { command: BIN, args: ['mcp', 'serve'] } },
  })
  assert.deepEqual(readJson(openCodeFile(config)).mcp, {
    servers: { acm: { type: 'local', command: [BIN, 'mcp', 'serve'] } },
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
        JSON.stringify({ transport: 'stdio', command: BIN, args: ['mcp', 'serve'] }),
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
    servers: { acm: { type: 'local', command: [BIN, 'mcp', 'serve'] } },
  })
})

test('the CLI installs the absolute path of the bin it was run as', () => {
  const config = fixture()
  const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  const run = () =>
    spawnSync(process.execPath, [cli, 'setup', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACM_HOME: config.home,
        ACM_PROJECT_ROOT: config.projectRoot,
        ACM_STORE: config.storePath,
      },
    })

  const first = run()

  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(readJson(piFile(config)).mcpServers?.acm, {
    command: fs.realpathSync(cli),
    args: ['mcp', 'serve'],
  })
  const second = run()
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
