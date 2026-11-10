import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineConfig } from '../engine/config.ts'
import { readStatus, formatStatus, formatRefusal, statusDocument } from './service.ts'
import type { ProvisionRow } from './types.ts'

// Seam A: the environment service against a fixture. A temp home holds a hand-written environment
// file and hand-written native files; the assertions are the rows `acm status` prints and the same
// rows as data. Nothing here inspects how the loader got there.

interface Fixture {
  home: string
  projectRoot: string
  config: EngineConfig
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-environ-'))
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

// One Provision per shape the ticket names: an export in a shell profile, a markdown block, a
// native config, and a check whose file is not on this machine.
const ENVIRONMENT = `version = 1

[provision.opencode-no-claude]
tags = ["harness-switch"]

[provision.opencode-no-claude.opencode]
check   = { file = "~/.zshrc", contains = "OPENCODE_DISABLE_CLAUDE_CODE" }
install = "./scripts/zshrc-export.sh OPENCODE_DISABLE_CLAUDE_CODE=1"

[provision.i-have-adhd]
tags = ["prompt"]

[provision.i-have-adhd.pi]
check   = { file = "~/.config/opencode/AGENTS.md", contains = "^## Output style" }
install = "./scripts/append-block.sh --file AGENTS.md --block output-style"

[provision.serena]
tags = ["mcp"]

[provision.serena.codex]
check   = { file = "~/.codex/config.toml", contains = "^\\\\[mcp_servers.serena\\\\]" }
install = "python3 scripts/merge-codex-mcp.py serena"

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json", contains = "serena" }
install = "pi plugin install serena"
`

function installed(f: Fixture): void {
  write(path.join(f.home, 'agents_environ.toml'), ENVIRONMENT)
  write(path.join(f.home, '.zshrc'), 'export PATH="$HOME/.bun/bin:$PATH"\nexport OPENCODE_DISABLE_CLAUDE_CODE=1\n')
  write(path.join(f.home, '.config', 'opencode', 'AGENTS.md'), '# AGENTS\n\n## Output style\n\nBe terse.\n')
  write(path.join(f.home, '.codex', 'config.toml'), '[mcp_servers.serena]\ncommand = "serena"\n')
}

function rows(f: Fixture, filter: { harness?: 'pi' | 'codex' | 'opencode'; name?: string } = {}): ProvisionRow[] {
  return readStatus(filter, f.config).provisions
}

test('status answers one row per Provision, one entry per harness it declares', () => {
  const f = fixture()
  installed(f)
  assert.deepEqual(rows(f), [
    {
      name: 'opencode-no-claude',
      tags: ['harness-switch'],
      harnesses: [{ harness: 'opencode', tier: 'user', source: path.join(f.home, 'agents_environ.toml'), presence: 'present', detail: null }],
    },
    {
      name: 'i-have-adhd',
      tags: ['prompt'],
      harnesses: [{ harness: 'pi', tier: 'user', source: path.join(f.home, 'agents_environ.toml'), presence: 'present', detail: null }],
    },
    {
      name: 'serena',
      tags: ['mcp'],
      harnesses: [
        { harness: 'codex', tier: 'user', source: path.join(f.home, 'agents_environ.toml'), presence: 'present', detail: null },
        // The file this check names is not on the fixture, so the answer is an absence rather than
        // an invented entry: nothing is added for a harness the file does not mention.
        { harness: 'pi', tier: 'user', source: path.join(f.home, 'agents_environ.toml'), presence: 'absent', detail: null },
      ],
    },
  ])
})

test('a harness filter keeps the entries of that harness and drops Provisions left with none', () => {
  const f = fixture()
  installed(f)
  assert.deepEqual(
    rows(f, { harness: 'codex' }).map((row) => ({ name: row.name, harnesses: row.harnesses.map((entry) => entry.harness) })),
    [{ name: 'serena', harnesses: ['codex'] }],
  )
  assert.deepEqual(rows(f, { harness: 'opencode' }).map((row) => row.name), ['opencode-no-claude'])
})

test('a name filter keeps one Provision and every harness entry it has', () => {
  const f = fixture()
  installed(f)
  assert.deepEqual(rows(f, { name: 'serena' }), [
    {
      name: 'serena',
      tags: ['mcp'],
      harnesses: [
        { harness: 'codex', tier: 'user', source: path.join(f.home, 'agents_environ.toml'), presence: 'present', detail: null },
        { harness: 'pi', tier: 'user', source: path.join(f.home, 'agents_environ.toml'), presence: 'absent', detail: null },
      ],
    },
  ])
  assert.deepEqual(rows(f, { name: 'missing' }), [])
})

test('a file the parser refuses contributes nothing and is reported with its source', () => {
  const f = fixture()
  installed(f)
  // The second Provision is valid; the first is not, so the whole file is refused rather than loaded
  // halfway with the good one.
  write(
    path.join(f.home, 'agents_environ.toml'),
    `version = 1

[provision.serena.codex]
check   = { file = "~/.codex/config.toml", patrh = "mcp_servers.serena" }
install = "python3 scripts/merge-codex-mcp.py serena"

[provision.opencode-no-claude.opencode]
check   = { file = "~/.zshrc", contains = "OPENCODE_DISABLE_CLAUDE_CODE" }
install = "true"
`,
  )
  const status = readStatus({}, f.config)
  assert.deepEqual(status.provisions, [])
  assert.deepEqual(status.refusals, [
    {
      source: path.join(f.home, 'agents_environ.toml'),
      line: 4,
      column: 44,
      reason: "unknown predicate 'patrh'",
    },
  ])
  assert.equal(formatRefusal(status.refusals[0]), `${path.join(f.home, 'agents_environ.toml')}:4:44: unknown predicate 'patrh'`)
})

// A Check is data: it reads the file it names and nothing else. An executable file at the check's
// path is the trap — evaluating it must not run it, and nothing may be written to the fixture.
test('evaluating a check runs nothing and writes nothing', () => {
  const f = fixture()
  const payload = path.join(f.home, 'payload.sh')
  write(payload, '#!/bin/sh\ntouch "$HOME/executed"\n')
  fs.chmodSync(payload, 0o755)
  write(
    path.join(f.home, 'agents_environ.toml'),
    `version = 1

[provision.trap.pi]
check   = { file = "~/payload.sh", contains = "touch" }
install = "true"
`,
  )
  const before = fs.readFileSync(path.join(f.home, 'agents_environ.toml'))
  assert.equal(rows(f)[0].harnesses[0].presence, 'present')
  assert.equal(fs.existsSync(path.join(f.home, 'executed')), false)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'agents_environ.toml')), before)
})

test('the printing is a function of the rows, and the JSON carries the same rows', () => {
  const f = fixture()
  installed(f)
  const status = readStatus({}, f.config)
  // No store was ever written here, so no entry carries history: the document is the rows.
  assert.deepEqual(statusDocument(status, []).provisions, status.provisions)
  const printed = formatStatus(status)
  assert.match(printed, /^provision .*harness .*source .*presence$/m)
  assert.match(printed, /^serena\s+codex\s+~\/agents_environ\.toml\s+present$/m)
  assert.match(printed, /^serena\s+pi\s+~\/agents_environ\.toml\s+absent$/m)
  assert.match(printed, /^i-have-adhd\s+pi\s+~\/agents_environ\.toml\s+present$/m)
  // The footer names where acm thinks it is: the project it read and the store it would record in.
  assert.match(printed, new RegExp(`project ${f.projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(printed, /store \/.*dashboard\.db/)
  assert.match(printed, /4 entries over 3 provisions/)
})

test('a machine with no environment file declares nothing, which is not a fault', () => {
  const f = fixture()
  assert.deepEqual(readStatus({}, f.config), {
    provisions: [],
    refusals: [],
    home: f.home,
    projectRoot: f.projectRoot,
    storePath: f.config.storePath,
    readFiles: [],
  })
  assert.match(formatStatus(readStatus({}, f.config)), /^no Provisions declared\n\n0 entries over 0 provisions/)
})

test('a home project reads the shared environment file only as user, even through an equal path', () => {
  const f = fixture()
  f.config.projectRoot = path.join(f.home, '..', path.basename(f.home))
  write(path.join(f.home, 'agents_environ.toml'), `version = 1\n\n[provision.home.pi]\ncheck = { file = "missing" }\ninstall = "true"\n`)
  const status = readStatus({}, f.config)
  assert.deepEqual(status.provisions[0].harnesses, [{ harness: 'pi', tier: 'user', source: path.join(f.home, 'agents_environ.toml'), presence: 'absent', detail: null }])
})

test('an unmatched tier reports the tiers and environment files read', () => {
  const f = fixture()
  installed(f)
  // A project file too, so the answer names both files it read and neither tier the filter named.
  write(path.join(f.projectRoot, 'agents_environ.toml'), 'version = 1\n')
  const printed = formatStatus(readStatus({ tier: 'project-local' }, f.config))
  assert.match(printed, /no Provisions declared/)
  assert.match(printed, /user ~\/agents_environ\.toml/)
  assert.match(printed, /project .*agents_environ\.toml/)
  assert.doesNotMatch(printed, /project-local/)
})
