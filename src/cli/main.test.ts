import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { openStore } from '../server/store.cjs'

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

function run(entry: string, home: string, args: string[], extra: Record<string, string> = {}, cwd?: string) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: cwd ?? somewhere(),
    env: childEnv({ ACM_HOME: home, ...extra }),
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
  // The store is the fixture's, so this machine's own run history cannot reach the answer.
  const store = path.join(home, 'store', 'dashboard.db')
  // One Run recorded earlier. It says `present` while the Check now says `absent`: the json carries
  // what happened, not a second reading of today's files.
  const seeded = openStore(store)
  seeded.recordRun({
    at: '2024-05-01T00:00:00.000Z',
    provision: 'serena',
    harness: 'pi',
    tier: 'user',
    command: 'pi plugin install serena',
    exitCode: 1,
    presence: 'present',
  })
  seeded.close()

  const printed = run(binPath(), home, ['status'], { ACM_STORE: store })
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /^opencode-no-claude\s+opencode\s+~\/agents_environ\.toml\s+present$/m)
  assert.match(printed.stdout, /^i-have-adhd\s+pi\s+~\/agents_environ\.toml\s+present$/m)
  // No entry for a harness is no row for it, and no file at the check's path is an absence.
  assert.match(printed.stdout, /^serena\s+pi\s+~\/agents_environ\.toml\s+absent\s+.*is not there$/m)
  assert.doesNotMatch(printed.stdout, /^serena\s+(codex|opencode)/m)

  const asJson = run(binPath(), home, ['status', '--json'], { ACM_STORE: store })
  assert.equal(asJson.status, 0, asJson.stderr)
  assert.deepEqual(JSON.parse(asJson.stdout), {
    harnesses: { user: [], project: [] },
    provisions: [
      {
        name: 'opencode-no-claude',
        tags: [],
        harnesses: [{ harness: 'opencode', tier: 'user', source: path.join(home, 'agents_environ.toml'), presence: 'present', detail: null }],
      },
      {
        name: 'i-have-adhd',
        tags: [],
        harnesses: [{ harness: 'pi', tier: 'user', source: path.join(home, 'agents_environ.toml'), presence: 'present', detail: null }],
      },
      {
        name: 'serena',
        tags: ['mcp'],
        harnesses: [
          {
            harness: 'pi',
            tier: 'user',
            source: path.join(home, 'agents_environ.toml'),
            presence: 'absent',
            detail: `${path.join(home, '.pi', 'agent', 'mcp.json')} is not there`,
            latestRun: {
              at: '2024-05-01T00:00:00.000Z',
              provision: 'serena',
              harness: 'pi',
              tier: 'user',
              command: 'pi plugin install serena',
              exitCode: 1,
              presence: 'present',
            },
          },
        ],
      },
    ],
  })
})

// The footer names each tier's declared harness list: the lists are per file, so the answer is
// per tier and a file with no list contributes none.
test('acm status prints the harness lists per tier in the footer', () => {
  const home = installed()
  write(
    path.join(home, 'agents_environ.toml'),
    `version = 1

harnesses = ["pi", "codex"]

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json" }
install = "pi plugin install serena"
`,
  )
  const result = run(binPath(), home, ['status'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /harnesses: user pi, codex; project none declared/)
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

// Install off a terminal is the piped or scheduled invocation, and it is a dry run: the preview is
// printed, and no command — here, a script the fixture does not have — is started.
test('acm install prints the preview and starts nothing when stdin is not a terminal', () => {
  const home = installed()
  const preview = run(binPath(), home, ['install'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /^preview: 3 entries, 1 to run, 2 already present · dry run$/m)
  assert.match(preview.stdout, /^    \$ \.\/scripts\/zshrc-export\.sh OPENCODE_DISABLE_CLAUDE_CODE=1$/m)
  assert.match(preview.stdout, /dry run: nothing was run/)
  assert.doesNotMatch(preview.stdout, /→/)
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

// Seam C's skills half: the built bundle spawned on `acm skills install --dry-run` against fixture
// lockfiles. The printed commands are the assertion — user groups first with -g, project groups
// from the project root without it, and a tier with no declared harnesses omits --agent.
test('acm skills install --dry-run prints one command per source group and runs nothing', () => {
  const home = somewhere()
  const projectRoot = somewhere()
  write(
    path.join(home, '.agents', '.skill-lock.json'),
    JSON.stringify({
      version: 3,
      skills: {
        alpha: { source: 'repo/one', sourceType: 'github' },
        beta: { source: 'repo/two', sourceType: 'github' },
        gamma: { source: 'repo/one', sourceType: 'github' },
      },
    }),
  )
  write(
    path.join(projectRoot, 'skills-lock.json'),
    JSON.stringify({ version: 1, skills: { local: { source: 'repo/proj', sourceType: 'github' } } }),
  )
  write(
    path.join(home, 'agents_environ.toml'),
    `version = 1

harnesses = ["pi", "codex"]
`,
  )
  write(path.join(projectRoot, 'agents_environ.toml'), 'version = 1\n')
  const result = run(binPath(), home, ['skills', 'install', '--dry-run'], { ACM_PROJECT_ROOT: projectRoot }, projectRoot)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^npx -y skills@latest add repo\/one --skill alpha --skill gamma --agent pi --agent codex -g -y$/m)
  assert.match(result.stdout, /^npx -y skills@latest add repo\/two --skill beta --agent pi --agent codex -g -y$/m)
  assert.match(result.stdout, /^npx -y skills@latest add repo\/proj --skill local -y$/m)
  assert.match(result.stdout, /dry run: nothing was run/)
  // The project lockfile exists, so the only warning is none; a missing tier warns on stderr.
  assert.equal(result.stderr, '')
})
