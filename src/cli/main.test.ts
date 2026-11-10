import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// Seam C's CLI half: the built bundle, spawned on Node the way a harness starts it. `status` is the
// subcommand these assertions need, which is also what makes the bundle's own package root
// observable again — the footer names the store derived from where the bundle is installed.

// The bin the package declares is what a harness pins, so the test spawns that path rather than a
// source file of its choosing.
function binPath(): string {
  const manifest = z
    .object({ bin: z.object({ acm: z.string() }) })
    .parse(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')))
  const bin = fileURLToPath(new URL(`../../${manifest.bin.acm}`, import.meta.url))
  assert.ok(fs.existsSync(bin), `${bin} is missing: run \`bun run build:acm\` before the suite`)
  return bin
}

function somewhere(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acm-cli-'))
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

// The environment is emptied of this machine's own acm overrides, so the answer is the fixture's.
function childEnv(extra: Record<string, string>) {
  const boundary = new Set(['ACM_PROJECT_ROOT', 'ACM_HOME', 'ACM_STORE', 'CODEX_HOME', 'CLAUDE_PROJECT_DIR'])
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !boundary.has(entry[0]) && !entry[0].startsWith('ACM_'),
  )
  return { ...Object.fromEntries(inherited), ...extra }
}

function run(entry: string, home: string, args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: somewhere(),
    env: childEnv({ ACM_HOME: home }),
    encoding: 'utf8',
  })
}

const ENVIRONMENT = `version = 1

[provision.opencode-no-claude.opencode]
check   = { file = "~/.zshrc", contains = "OPENCODE_DISABLE_CLAUDE_CODE" }
install = "./scripts/zshrc-export.sh OPENCODE_DISABLE_CLAUDE_CODE=1"

[provision.i-have-adhd.pi]
check   = { file = "~/.config/opencode/AGENTS.md", contains = "^## Output style" }
install = "./scripts/append-block.sh --file AGENTS.md --block output-style"

[provision.serena]
tags = ["mcp"]

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json" }
install = "pi plugin install serena"
`

function installed(): string {
  const home = somewhere()
  write(path.join(home, 'agents_environ.toml'), ENVIRONMENT)
  write(path.join(home, '.zshrc'), 'export OPENCODE_DISABLE_CLAUDE_CODE=1\n')
  write(path.join(home, '.config', 'opencode', 'AGENTS.md'), '# AGENTS\n\n## Output style\n\nBe terse.\n')
  return home
}

// A token shaped like a GitHub credential: the classifier knows it wherever it sits, so the read
// tests can tell a withheld value from a value the answer simply never carried.
const SECRET = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'

test('acm status prints Provision by harness, and --json prints the same rows as data', () => {
  const home = installed()
  const printed = run(binPath(), home, ['status'])
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /^opencode-no-claude\s+opencode\s+present$/m)
  assert.match(printed.stdout, /^i-have-adhd\s+pi\s+present$/m)
  // No entry for a harness is no row for it, and no file at the check's path is an absence.
  assert.match(printed.stdout, /^serena\s+pi\s+absent$/m)
  assert.doesNotMatch(printed.stdout, /^serena\s+(codex|opencode)/m)

  const asJson = run(binPath(), home, ['status', '--json'])
  assert.equal(asJson.status, 0, asJson.stderr)
  assert.deepEqual(JSON.parse(asJson.stdout), {
    provisions: [
      {
        name: 'opencode-no-claude',
        tags: [],
        harnesses: [{ harness: 'opencode', tier: 'user', presence: 'present', detail: null }],
      },
      {
        name: 'i-have-adhd',
        tags: [],
        harnesses: [{ harness: 'pi', tier: 'user', presence: 'present', detail: null }],
      },
      {
        name: 'serena',
        tags: ['mcp'],
        harnesses: [{ harness: 'pi', tier: 'user', presence: 'absent', detail: null }],
      },
    ],
  })
})

test('a refused environment file is reported with line and column, and fails the command', () => {
  const home = somewhere()
  write(
    path.join(home, 'agents_environ.toml'),
    'version = 1\n\n[provision.serena.codex]\ncheck = { file = "~/.codex/config.toml", patrh = "x" }\ninstall = "true"\n',
  )
  const result = run(binPath(), home, ['status'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /agents_environ\.toml:4:42: unknown predicate 'patrh'/)
  assert.match(result.stdout, /no Provisions declared/)
})

// Install off a terminal is the piped or scheduled invocation, and it is a dry run: the plan is
// printed, and no command — here, a script the fixture does not have — is started.
test('acm install prints the plan and starts nothing when stdin is not a terminal', () => {
  const home = installed()
  const planned = run(binPath(), home, ['install'])
  assert.equal(planned.status, 0, planned.stderr)
  assert.match(planned.stdout, /^plan: 3 planned, 1 to run, 2 already present · dry run$/m)
  assert.match(planned.stdout, /^    \$ \.\/scripts\/zshrc-export\.sh OPENCODE_DISABLE_CLAUDE_CODE=1$/m)
  assert.match(planned.stdout, /dry run: nothing was run/)
  assert.doesNotMatch(planned.stdout, /→/)
})

// The carry-forward from ticket 01: a built bundle has to find the package it was installed into,
// not the directory it happens to be started from. It is copied into an install-shaped layout —
// `<root>/dist/acm.mjs` under `<root>/package.json` — started from a foreign directory, and the
// store it names in the footer is the one that layout implies.
test('acm read prints one harness native configuration, secret-free', () => {
  const home = somewhere()
  write(
    path.join(home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: SECRET } } } }, null, 2),
  )
  const result = run(binPath(), home, ['read', 'pi', 'pi:user'])
  assert.equal(result.status, 0, result.stderr)
  const document = z
    .object({ harness: z.string(), tiers: z.array(z.object({ tier: z.string() })) })
    .parse(JSON.parse(result.stdout))
  assert.equal(document.harness, 'pi')
  assert.deepEqual(document.tiers.map((tier) => tier.tier), ['pi:user'])
  // The address the agent's Install command has to write to, and the marker instead of the value.
  assert.match(result.stdout, /"pointer": "mcpServers\.github"/)
  assert.match(result.stdout, /\[withheld: secret\]/)
  // A process's stderr is the other place a fragment of a native file could reach a human or a log.
  assert.equal(result.stdout.includes(SECRET), false, 'the credential reached stdout')
  assert.equal(result.stderr.includes(SECRET), false, 'the credential reached stderr')
})

test('acm read refuses a harness or tier the lookup does not declare, naming the ones it does', () => {
  const home = somewhere()
  const harness = run(binPath(), home, ['read', 'claude'])
  assert.equal(harness.status, 1)
  assert.deepEqual(harness.stdout, '')
  assert.match(harness.stderr, /unknown harness 'claude'; harnesses are pi, codex, opencode/)

  const tier = run(binPath(), home, ['read', 'pi', 'pi:system'])
  assert.equal(tier.status, 1)
  assert.deepEqual(tier.stdout, '')
  assert.match(tier.stderr, /pi declares no tier 'pi:system'; tiers are pi:user, pi:project/)
})

test('the built bundle run from a foreign directory finds its own package root', () => {
  const root = somewhere()
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-acm', type: 'module' }))
  const entry = path.join(root, 'dist', 'acm.mjs')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.copyFileSync(binPath(), entry)

  const result = run(entry, installed(), ['status'])
  assert.equal(result.status, 0, result.stderr)
  const store = path.join(root, 'database', 'dashboard.db')
  assert.ok(result.stdout.includes(`store ${store}`), `expected the footer to name ${store}:\n${result.stdout}`)
})
