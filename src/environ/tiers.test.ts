import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineConfig } from '../engine/config.ts'
import { installRun, listHarnesses, readStatus } from './service.ts'
import { loadEnvironment } from './loader.ts'
import type { EnvironmentTier, ProvisionRow } from './types.ts'

// Seam A: three environment files against a fixture, through the environment service. A temp home
// and a temp project root hold hand-written files, and scripts in both roots record which directory
// a command ran in. The assertions are the rows `acm status` prints, the preview a run prints, and the
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

// The file one tier reads: `agents_environ.toml` in the home directory for `user`, and in the
// Project root for `project`.
function declare(f: Fixture, tier: EnvironmentTier, text: string): void {
  write(path.join(tier === 'user' ? f.home : f.projectRoot, 'agents_environ.toml'), text)
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
test('one Provision at both tiers keeps the project entry whole, and its command runs in the Project root', () => {
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
  installer(f, f.home)
  installer(f, f.projectRoot)

  assert.deepEqual(rows(f), [
    {
      name: 'serena',
      tags: ['project'],
      harnesses: [
        {
          harness: 'codex',
          tier: 'project',
          source: path.join(f.projectRoot, 'agents_environ.toml'),
          presence: 'absent',
          detail: `${path.join(f.projectRoot, 'installed.txt')} is not there`,
        },
      ],
    },
  ])

  const printed: string[] = []
  const outcome = installRun((text) => printed.push(text), { dryRun: false }, f.config)
  assert.equal(outcome.entries.length, 1)
  assert.match(printed.join(''), /serena\s+codex\s+project/)
  // The copy that ran is the Project root's, so a relative `install` path meant the Project root.
  assert.deepEqual(log(f), ['project project'])
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
      harnesses: [
        {
          harness: 'pi',
          tier: 'user',
          source: path.join(f.home, 'agents_environ.toml'),
          presence: 'absent',
          detail: `${path.join(f.home, 'user-pi.json')} is not there`,
        },
      ],
    },
    {
      name: 'serena',
      tags: ['local'],
      harnesses: [
        {
          harness: 'codex',
          tier: 'project',
          source: path.join(f.projectRoot, 'agents_environ.toml'),
          presence: 'absent',
          detail: `${path.join(f.projectRoot, 'project-codex.toml')} is not there`,
        },
      ],
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
  assert.deepEqual(names(f), ['home-thing', 'repo-thing'])
  assert.deepEqual(names(f, { tier: 'project' }), ['repo-thing'])
  assert.deepEqual(names(f, { tier: 'user' }), ['home-thing'])
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
  assert.match(missing.join(''), /no Provision named or tagged home-thing/)
})

// The shared declarations merge the way tags do: the file that declares the entry owns them whole.
// The user file's empty pi entry keeps the user file's shared Install command; the project file's
// codex entry gets the project file's own, and each spelling runs once.
test('a nearer file owns the shared declarations of the entries it declares', () => {
  const f = fixture()
  declare(f, 'user', `version = 1

[provision.serena]
checks  = [{ file = "installed.txt" }]
install = "./install.sh user-shared installed.txt"

[provision.serena.pi]
`)
  declare(f, 'project', `version = 1

[provision.serena]
checks  = [{ file = "installed.txt" }]
install = "./install.sh project-shared installed.txt"

[provision.serena.codex]
check   = { file = "codex.txt" }
install = "./install.sh project-own codex.txt"
`)
  installer(f, f.home)
  installer(f, f.projectRoot)

  assert.deepEqual(
    rows(f).map((row) => row.harnesses.map((entry) => `${entry.harness}@${entry.tier}`)),
    [['pi@user', 'codex@project']],
  )

  const printed: string[] = []
  const outcome = installRun((text) => printed.push(text), { dryRun: false }, f.config)
  // pi ran the user file's shared command in the home directory; codex ran the project file's
  // shared command and then its own in the Project root — the user file's shared command was not
  // spent on the project entry, and the project's was not spent twice.
  assert.deepEqual(log(f), ['home user-shared', 'project project-shared', 'project project-own'])
  assert.equal(outcome.exitCode, 0)
})

// The same shared command spelled at two tiers is two commands: a relative path means a different
// file under each Tier root, so the run-once rule keys on the root as well as the spelling.
test('the same shared command spelled at two tiers runs once per Tier root', () => {
  const f = fixture()
  const declaration = `version = 1

[provision.p]
checks  = [{ file = "installed.txt" }]
install = "./install.sh shared installed.txt"

[provision.p.PLACEHOLDER]
`
  declare(f, 'user', declaration.replace('PLACEHOLDER', 'pi'))
  declare(f, 'project', declaration.replace('PLACEHOLDER', 'codex'))
  installer(f, f.home)
  installer(f, f.projectRoot)

  const outcome = installRun(() => {}, { dryRun: false }, f.config)
  assert.deepEqual(log(f), ['home shared', 'project shared'])
  assert.equal(outcome.exitCode, 0)
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

  // A local file git ignores is not read at all: it has no effect on status.
  write(path.join(f.projectRoot, 'agents_environ.local.toml'), `version = 1

[provision.mine.opencode]
check   = { file = "installed.txt" }
install = "true"
`)
  const both = readStatus({}, f.config)
  assert.deepEqual(
    both.provisions.map((row) => row.name),
    ['home-thing'],
  )
  assert.equal(both.refusals.length, 1)

  // Nor on install: the local file's Provision is never seen, so a run has nothing to execute.
  installer(f, f.projectRoot)
  const printed: string[] = []
  const outcome = installRun((text) => printed.push(text), { dryRun: false }, f.config)
  // Only the user file's own entry runs; the local file's `mine` is never seen.
  assert.deepEqual(outcome.entries.map((entry) => entry.provision.name), ['home-thing'])
  assert.deepEqual(log(f), [])
})

// The harness list is each file's own: it constrains that file's entries and never merges into the
// other tier's answer.
test('each tier answers its own harness list, and one file\'s list never reaches the other', () => {
  const f = fixture()
  declare(f, 'user', `version = 1

harnesses = ["pi", "codex"]

[provision.home-thing.pi]
check   = { file = "installed.txt" }
install = "true"
`)
  declare(f, 'project', `version = 1

harnesses = ["opencode"]

[provision.repo-thing.opencode]
check   = { file = "installed.txt" }
install = "true"
`)

  assert.deepEqual(readStatus({}, f.config).harnesses, {
    user: ['pi', 'codex'],
    project: ['opencode'],
  })
  // One tier's list is the answer for that tier alone, and a file with no list declares nothing.
  assert.deepEqual(listHarnesses({ tier: 'user' }, f.config), ['pi', 'codex'])
  assert.deepEqual(listHarnesses({ tier: 'project' }, f.config), ['opencode'])

  fs.rmSync(path.join(f.projectRoot, 'agents_environ.toml'))
  assert.deepEqual(readStatus({}, f.config).harnesses, { user: ['pi', 'codex'], project: [] })
})

// A file that refuses its own harness list contributes no list and no entries: the refusal is the
// file's, reported the way every other refusal is.
test('a file whose entries violate its harness list contributes nothing and is reported', () => {
  const f = fixture()
  declare(f, 'project', `version = 1

harnesses = ["pi"]

[provision.repo-thing.codex]
check   = { file = "installed.txt" }
install = "true"
`)
  const status = readStatus({}, f.config)
  assert.deepEqual(status.provisions, [])
  assert.equal(status.refusals.length, 1)
  assert.match(status.refusals[0].reason, /harness 'codex' is not one of this file's harnesses/)
  assert.deepEqual(status.harnesses, { user: [], project: [] })
})

// One tier per load: a scoped load opens only the selected tier's file, so the other tier's
// fault — even a refused file — contributes nothing to it.
test('a tier-scoped load reads only that tier file', () => {
  const f = fixture()
  declare(f, 'user', 'version = 1\nharnesses = ["pi"]\nnot = toml\n')
  declare(f, 'project', 'version = 1\n\nharnesses = ["opencode"]\n')
  const scoped = loadEnvironment(f.config, 'project')
  assert.deepEqual(scoped.refusals, [])
  assert.deepEqual(scoped.harnessesByTier.project, ['opencode'])
  assert.deepEqual(scoped.harnessesByTier.user, [])

  const user = loadEnvironment(f.config, 'user')
  assert.equal(user.refusals.length, 1)
  assert.equal(user.refusals[0].source, path.join(f.home, 'agents_environ.toml'))
  assert.deepEqual(user.harnessesByTier.user, [])
})

// The ownership rule survives the scoping: when the Project root is `$HOME` the two tiers name one
// file, the user tier keeps it, and a scoped project load reads nothing at all.
test('a scoped project load skips a file the user tier owns', () => {
  const f = fixture()
  f.config.projectRoot = f.home
  declare(f, 'user', 'version = 1\n\nharnesses = ["pi"]\n')
  const project = loadEnvironment(f.config, 'project')
  assert.deepEqual(project.harnessesByTier.project, [])
  assert.deepEqual(project.readFiles, [])
  const owner = loadEnvironment(f.config, 'user')
  assert.deepEqual(owner.harnessesByTier.user, ['pi'])
})
