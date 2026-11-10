import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineConfig } from '../engine/config.ts'
import { readNativeConfig } from './service.ts'

// Seam A: a native read against a fixture. A temp home and a temp project hold hand-written native
// files — never captured from this machine — and the assertions are the document the CLI prints and
// the MCP tool returns. Nothing here inspects how a reader got its answer.

interface Fixture {
  home: string
  projectRoot: string
  config: EngineConfig
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-native-read-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projectRoot, { recursive: true })
  return {
    home,
    projectRoot,
    config: { home, projectRoot, storePath: path.join(root, 'store', 'dashboard.db') },
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

// Every file under a fixture directory with its bytes: nothing a native read does may add, remove or
// rewrite one of them.
function snapshot(dir: string): string[] {
  return files(dir)
    .sort()
    .map((file) => `${path.relative(dir, file)}:${fs.readFileSync(file, 'utf8')}`)
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? files(full) : [full]
  })
}

const TOKEN = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'

function codexInstalled(f: Fixture): void {
  write(
    path.join(f.home, '.codex', 'config.toml'),
    `model = "gpt-5"

[mcp_servers.serena]
command = "uvx"
args = ["serena", "start-mcp-server"]

[mcp_servers.remote]
url = "https://example.test/mcp"
`,
  )
  write(
    path.join(f.home, '.codex', 'hooks.json'),
    JSON.stringify({ hooks: { session_start: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
  )
  write(path.join(f.home, '.codex', 'AGENTS.md'), '# AGENTS\n\nBe terse.\n')
  write(path.join(f.home, '.agents', 'skills', 'terse', 'SKILL.md'), '---\nname: terse\n---\n')
  write(path.join(f.projectRoot, '.codex', 'config.toml'), '[mcp_servers.project-only]\ncommand = "true"\n')
}

test('a native read names every path the lookup declares, and every declaration its native location', () => {
  const f = fixture()
  codexInstalled(f)
  const [tier, ...others] = readNativeConfig('codex', 'codex:user', f.config).tiers
  assert.deepEqual(others, [])
  assert.equal(tier.tier, 'codex:user')
  assert.equal(tier.label, 'user')
  // The declared paths, not the ones that happened to exist: an agent's next move is to address one
  // of these, so an empty location still has to be named.
  assert.deepEqual(
    tier.reads.map((read) => ({ category: read.category, paths: read.paths, health: read.health })),
    [
      { category: 'mcp', paths: [path.join(f.home, '.codex', 'config.toml')], health: 'ok' },
      { category: 'skills', paths: [path.join(f.home, '.agents', 'skills')], health: 'ok' },
      { category: 'instructions', paths: [path.join(f.home, '.codex', 'AGENTS.md')], health: 'ok' },
      { category: 'hooks', paths: [path.join(f.home, '.codex', 'hooks.json')], health: 'ok' },
    ],
  )
  assert.deepEqual(
    tier.declarations.map(({ category, name, file, pointer }) => ({ category, name, file, pointer })),
    [
      {
        category: 'mcp',
        name: 'serena',
        file: path.join(f.home, '.codex', 'config.toml'),
        pointer: 'mcp_servers.serena',
      },
      {
        category: 'mcp',
        name: 'remote',
        file: path.join(f.home, '.codex', 'config.toml'),
        pointer: 'mcp_servers.remote',
      },
      {
        category: 'skills',
        name: 'terse',
        file: path.join(f.home, '.agents', 'skills', 'terse'),
        pointer: '',
      },
      {
        category: 'instructions',
        name: 'AGENTS.md',
        file: path.join(f.home, '.codex', 'AGENTS.md'),
        pointer: '',
      },
      {
        category: 'hooks',
        name: 'session_start',
        file: path.join(f.home, '.codex', 'hooks.json'),
        pointer: 'hooks.session_start.0',
      },
    ],
  )
  // What the file declares travels with the address, so an agent can author a Check from the answer
  // alone rather than opening the harness's file itself.
  const serena = tier.declarations.find((declaration) => declaration.name === 'serena')
  assert.ok(serena !== undefined)
  assert.deepEqual(serena.fields, {
    transport: 'stdio',
    command: 'uvx',
    args: ['serena', 'start-mcp-server'],
  })
})

test('no tier answers for every tier the lookup declares, and a project file is its own tier', () => {
  const f = fixture()
  codexInstalled(f)
  const document = readNativeConfig('codex', undefined, f.config)
  assert.deepEqual(document.tiers.map((tier) => tier.tier), ['codex:user', 'codex:project'])
  const project = document.tiers[1]
  assert.equal(project.label, 'project')
  assert.deepEqual(
    project.declarations.map((declaration) => declaration.pointer),
    ['mcp_servers.project-only'],
  )
})

test('a credentialed value comes back as its verdict marker, and the value is nowhere in the answer', () => {
  const f = fixture()
  write(
    path.join(f.home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        github: {
          command: 'gh-mcp',
          env: { GITHUB_TOKEN: TOKEN },
          headers: { Authorization: 'Bearer opaque-value-0123456789' },
          description: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
        },
      },
    }),
  )
  const document = readNativeConfig('pi', 'pi:user', f.config)
  const [tier] = document.tiers
  const [github] = tier.declarations
  // The marker, next to the key that survives: a row still says which variable the server needs.
  assert.deepEqual(github.fields, {
    transport: 'stdio',
    command: 'gh-mcp',
    env: { GITHUB_TOKEN: '[withheld: secret]' },
    headers: { Authorization: '[withheld: secret]' },
    description: '[withheld: secret]',
  })
  // Asserted on the whole serialized document, because a leak in a field nobody thought to redact is
  // the failure this read exists to prevent.
  const serialized = JSON.stringify(document)
  for (const rejected of [TOKEN, 'ghp_', 'opaque-value-0123456789', 'sk-ant-api03']) {
    assert.equal(serialized.includes(rejected), false, `${rejected} escaped into the native read`)
  }
})

test('a file that does not parse is a parse failure naming the file, not an empty answer', () => {
  const f = fixture()
  write(path.join(f.home, '.codex', 'config.toml'), `[mcp_servers.broken\ncommand = "${TOKEN}"\n`)
  write(path.join(f.home, '.codex', 'AGENTS.md'), '# AGENTS\n')
  const [tier] = readNativeConfig('codex', 'codex:user', f.config).tiers
  const mcp = tier.reads.find((read) => read.category === 'mcp')
  assert.ok(mcp !== undefined)
  assert.equal(mcp.health, 'unreadable')
  assert.match(String(mcp.detail), new RegExp(`${path.join(f.home, '.codex', 'config.toml').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `))
  // The parser's detail is its own words, never a fragment of the bytes it could not read.
  assert.equal(JSON.stringify(readNativeConfig('codex', 'codex:user', f.config)).includes(TOKEN), false)
  // One unreadable category does not blank the rest of the tier: the instruction file still answers.
  assert.deepEqual(
    tier.reads.filter((read) => read.category !== 'mcp').map((read) => read.health),
    ['ok', 'ok', 'ok'],
  )
  assert.deepEqual(tier.declarations.map((declaration) => declaration.name), ['AGENTS.md'])
})

test('a native read answers for the categories the harness claims and no others', () => {
  const f = fixture()
  write(path.join(f.projectRoot, 'opencode.json'), JSON.stringify({ mcp: { serena: { type: 'local', command: ['serena'] } } }))
  const project = readNativeConfig('opencode', 'oc:project', f.config).tiers[0]
  // OpenCode loads hooks as plugin modules this engine cannot parse, so it claims no hooks reader and
  // the read invents no location for one.
  assert.deepEqual(project.reads.map((read) => read.category), ['mcp', 'skills', 'instructions'])
  // A tier with four candidate config files names all four: the answer is the lookup's, not one file.
  assert.deepEqual(project.reads[0].paths, [
    path.join(f.projectRoot, 'opencode.json'),
    path.join(f.projectRoot, 'opencode.jsonc'),
    path.join(f.projectRoot, '.opencode', 'opencode.json'),
    path.join(f.projectRoot, '.opencode', 'opencode.jsonc'),
  ])
  assert.deepEqual(
    project.declarations.map(({ name, file, pointer }) => ({ name, file, pointer })),
    [{ name: 'serena', file: path.join(f.projectRoot, 'opencode.json'), pointer: 'mcp.serena' }],
  )
  assert.deepEqual(
    readNativeConfig('opencode', undefined, f.config).tiers.map((tier) => tier.tier),
    ['oc:project', 'oc:user', 'oc:system'],
  )
})

test('a harness or tier the lookup does not declare is refused rather than answered empty', () => {
  const f = fixture()
  assert.throws(
    () => readNativeConfig('pi', 'pi:system', f.config),
    /^Error: pi declares no tier 'pi:system'; tiers are pi:user, pi:project$/,
  )
  assert.throws(
    () => readNativeConfig('claude', undefined, f.config),
    /^Error: unknown harness 'claude'; harnesses are pi, codex, opencode$/,
  )
})

test('a native read stores nothing and starts no Install command', () => {
  const f = fixture()
  codexInstalled(f)
  write(
    path.join(f.home, 'agents_environ.toml'),
    `version = 1

[provision.trap.pi]
check   = { file = "~/payload.sh", contains = "touch" }
install = "touch executed"
`,
  )
  const before = [...snapshot(f.home), ...snapshot(f.projectRoot)]
  assert.equal(readNativeConfig('codex', undefined, f.config).tiers.length, 2)
  assert.deepEqual([...snapshot(f.home), ...snapshot(f.projectRoot)], before)
  // The Install command the environment declares would have left this file behind, and the store the
  // engine knows how to reach was not opened either.
  assert.equal(fs.existsSync(path.join(f.home, 'executed')), false)
  assert.equal(fs.existsSync(f.config.storePath), false)
})
