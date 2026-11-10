import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineConfig } from '../engine/config.ts'
import { installRun, readStatus } from './service.ts'
import type { EnvironmentTier, ProvisionRow } from './types.ts'

// Seam A: three environment files against a fixture, through the environment service. A temp home
// and a temp project root hold hand-written files, and scripts in both roots record which directory
// a command ran in. The assertions are the rows `acm status` prints, the plan a run prints, and the
// bytes a command left behind; nothing here inspects how the loader got there.

interface Fixture {
  home: string
  projectRoot: string
  log: string
  config: EngineConfig
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-tiers-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projectRoot, { recursive: true })
  return {
    home,
    projectRoot,
    log: path.join(root, 'ran.log'),
    config: { home, projectRoot, storePath: path.join(root, 'store', 'dashboard.db') },
  }
}

function write(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}

// The file one tier reads: the committed name in the home directory and in the Project root, and the
// `.local` suffix in the Project root for the gitignored one.
function declare(f: Fixture, tier: EnvironmentTier, text: string): void {
  const name = tier === 'project-local' ? 'agents_environ.local.toml' : 'agents_environ.toml'
  write(path.join(tier === 'user' ? f.home : f.projectRoot, name), text)
}

// A same-named script in each root. It records the directory it ran in and the marker it was given,
// then creates the file its Check names — so the log says which copy answered and the run's own
// answer afterwards is a file rather than a claim.
function installer(f: Fixture, root: string): void {
  const target = path.join(root, 'install.sh')
  write(target, `#!/bin/sh\necho "$(basename "$PWD") $1" >> "${f.log}"\ntouch "$2"\n`)
  fs.chmodSync(target, 0o755)
}

function log(f: Fixture): string[] {
  if (!fs.existsSync(f.log)) return []
  return fs
    .readFileSync(f.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

function rows(f: Fixture, filter: { tier?: EnvironmentTier } = {}): ProvisionRow[] {
  return readStatus(filter, f.config).provisions
}

function names(f: Fixture, filter: { tier?: EnvironmentTier } = {}): string[] {
  return rows(f, filter).map((row) => row.name)
}

function presence(f: Fixture, filter: { tier?: EnvironmentTier } = {}): string {
  const selected = rows(f, filter)
  assert.equal(selected.length, 1, 'expected one Provision')
  return selected[0].harnesses[0].presence
}

// The whole point of the merge: an entry is won or lost whole. The nearer file's tags, Check,
// Install command, tier and root all come from that file, and nothing is inherited field by field.
test('one Provision at all three tiers keeps the project-local entry whole, and its command runs in the Project root', () => {
  const f = fixture()
  const declaration = (tags: string, marker: string): string => `version = 1

[provision.serena]
tags = ["${tags}"]

[provision.serena.codex]
check   = { file = "installed.txt" }
install = "./install.sh ${marker} installed.txt"
`
  declare(f, 'user', declaration('user', 'user'))
  declare(f, 'project', declaration('project', 'project'))
  declare(f, 'project-local', declaration('project-local', 'project-local'))
  installer(f, f.home)
  installer(f, f.projectRoot)

  assert.deepEqual(rows(f), [
    {
      name: 'serena',
      tags: ['project-local'],
      harnesses: [{ harness: 'codex', tier: 'project-local', presence: 'absent', detail: null }],
    },
  ])

  const printed: string[] = []
  const outcome = installRun((text) => printed.push(text), { dryRun: false }, f.config)
  assert.equal(outcome.entries.length, 1)
  assert.match(printed.join(''), /serena\s+codex\s+project-local/)
  // The copy that ran is the Project root's, so a relative `install` path meant the Project root.
  assert.deepEqual(log(f), ['project project-local'])
  assert.equal(outcome.entries[0].after, 'present')
})

// The failure this ticket exists to prevent: a project file that changes one field and silently
// keeps the rest, leaving an entry half from one tier and half from another.
test('a nearer file replaces the entry whole: tags are replaced rather than unioned, and order follows the winning file', () => {
  const f = fixture()
  declare(f, 'user', `version = 1

[provision.serena]
tags = ["mcp", "remote"]

[provision.serena.codex]
check   = { file = "user-codex.toml" }
install = "echo user"

[provision.i-have-adhd]
tags = ["prompt"]

[provision.i-have-adhd.pi]
check   = { file = "user-pi.json" }
install = "echo user"
`)
  declare(f, 'project', `version = 1

[provision.serena]
tags = ["local"]

[provision.serena.codex]
check   = { file = "project-codex.toml" }
install = "echo project"
`)

  assert.deepEqual(rows(f), [
    // `i-have-adhd` is the user file's own entry, so it comes first: the shadowed `serena` entry
    // takes the position it has in the file that won it, not the one it had in the file it lost.
    {
      name: 'i-have-adhd',
      tags: ['prompt'],
      harnesses: [{ harness: 'pi', tier: 'user', presence: 'absent', detail: null }],
    },
    {
      name: 'serena',
      tags: ['local'],
      harnesses: [{ harness: 'codex', tier: 'project', presence: 'absent', detail: null }],
    },
  ])
})

// One Provision text, written twice, reads the file beside it in each tier: that is what the tier
// root is for, and what the resolved Check has to carry.
test('the same Provision text at two tiers reads two different files', () => {
  const f = fixture()
  const text = `version = 1

[provision.marker.pi]
check   = { file = "state/marker.txt", contains = "ready" }
install = "true"
`
  declare(f, 'user', text)
  declare(f, 'project', text)
  write(path.join(f.home, 'state', 'marker.txt'), 'ready\n')

  // The Project root's entry won, and its copy of that path is the one it reads: the home
  // directory's file does not answer for it.
  assert.equal(presence(f), 'absent')

  write(path.join(f.projectRoot, 'state', 'marker.txt'), 'ready\n')
  assert.equal(presence(f), 'present')

  // With the shadowing file gone the same text is read against the home directory, where the file
  // was there all along.
  fs.rmSync(path.join(f.projectRoot, 'agents_environ.toml'))
  assert.equal(presence(f), 'present')
})

test('--tier restricts status to the entries one tier owns, after the merge', () => {
  const f = fixture()
  declare(f, 'user', `version = 1

[provision.home-thing.pi]
check   = { file = "installed.txt" }
install = "./install.sh user installed.txt"
`)
  declare(f, 'project', `version = 1

[provision.repo-thing.codex]
check   = { file = "installed.txt" }
install = "./install.sh project installed.txt"
`)
  declare(f, 'project-local', `version = 1

[provision.home-thing.pi]
check   = { file = "shadowed.txt" }
install = "true"
`)

  assert.deepEqual(names(f), ['repo-thing', 'home-thing'])
  assert.deepEqual(names(f, { tier: 'project' }), ['repo-thing'])
  // `home-thing` is declared in the user file too, but the gitignored file owns it, so the user tier
  // has nothing of its own left.
  assert.deepEqual(names(f, { tier: 'user' }), [])
  assert.deepEqual(rows(f, { tier: 'project-local' })[0].tags, [])
})

test('--tier restricts install to the entries one tier owns', () => {
  const f = fixture()
  declare(f, 'user', `version = 1

[provision.home-thing.pi]
check   = { file = "installed.txt" }
install = "./install.sh user installed.txt"
`)
  declare(f, 'project', `version = 1

[provision.repo-thing.codex]
check   = { file = "installed.txt" }
install = "./install.sh project installed.txt"
`)
  installer(f, f.home)
  installer(f, f.projectRoot)

  const printed: string[] = []
  const outcome = installRun((text) => printed.push(text), { dryRun: false, tier: 'project' }, f.config)
  assert.equal(outcome.entries.length, 1)
  assert.match(printed.join(''), /repo-thing\s+codex\s+project/)
  assert.doesNotMatch(printed.join(''), /home-thing/)
  assert.deepEqual(log(f), ['project project'])

  // A name the tier filter leaves out is a name this run cannot reach, so it is refused the way an
  // unknown name is rather than quietly running nothing.
  const missing: string[] = []
  const refused = installRun((text) => missing.push(text), { dryRun: false, tier: 'project', only: ['home-thing'] }, f.config)
  assert.equal(refused.exitCode, 1)
  assert.match(missing.join(''), /no Provision named home-thing/)
})

// Each file refuses on its own: the fault is reported with the file it is in, and the tiers that
// parse still load — including one read after the refused file.
test('a malformed project file contributes nothing while the user tier still loads', () => {
  const f = fixture()
  declare(f, 'user', `version = 1

[provision.home-thing.pi]
check   = { file = "~/.zshrc" }
install = "true"
`)
  declare(f, 'project', `version = 1

[provision.repo-thing.codex]
check   = { file = "~/.codex/config.toml", smells = "mcp_servers.serena" }
install = "true"
`)
  const refused = readStatus({}, f.config)
  assert.deepEqual(
    refused.provisions.map((row) => row.name),
    ['home-thing'],
  )
  assert.equal(refused.refusals.length, 1)
  assert.equal(refused.refusals[0].source, path.join(f.projectRoot, 'agents_environ.toml'))
  assert.equal(refused.refusals[0].line, 4)
  assert.match(refused.refusals[0].reason, /unknown predicate 'smells'/)

  // The gitignored file is read after the refused one, so a refusal does not end the pass.
  declare(f, 'project-local', `version = 1

[provision.mine.opencode]
check   = { file = "installed.txt" }
install = "true"
`)
  const both = readStatus({}, f.config)
  assert.deepEqual(
    both.provisions.map((row) => row.name),
    ['home-thing', 'mine'],
  )
  assert.equal(both.provisions[1].harnesses[0].tier, 'project-local')
  assert.equal(both.refusals.length, 1)
})
