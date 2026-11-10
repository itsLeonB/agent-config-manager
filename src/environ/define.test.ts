import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineConfig } from '../engine/config.ts'
import { digestOfBytes } from '../engine/digest.ts'
import { defineProvision, readNativeConfig, readStatus } from './service.ts'
import type { DefineOutcome, DefineRequest } from './service.ts'
import type { NativeValue } from '../engine/native-value.ts'
import type { Refusal } from './types.ts'

// Seam A: a definition against a fixture home and a fixture project root, and then the rows `acm
// status` reports from what landed. The assertions are the bytes on disk and the rows, never how the
// write got there.

interface Fixture {
  home: string
  projectRoot: string
  config: EngineConfig
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-define-'))
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

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

function userFile(f: Fixture): string {
  return path.join(f.home, 'agents_environ.toml')
}

function committedFile(f: Fixture): string {
  return path.join(f.projectRoot, 'agents_environ.toml')
}

// The file a definition lands in when its caller names no tier.
function localFile(f: Fixture): string {
  return path.join(f.projectRoot, 'agents_environ.local.toml')
}

type Defined = Extract<DefineOutcome, { kind: 'defined' }>

// The reason a definition did not land, for the assertion message rather than for an answer.
function why(outcome: DefineOutcome): string {
  if (outcome.kind === 'refused') {
    return `${outcome.refusal.line}:${outcome.refusal.column}: ${outcome.refusal.reason}`
  }
  return outcome.kind === 'failed' ? outcome.reason : 'the definition was written'
}

function defined(outcome: DefineOutcome): Defined {
  assert.ok(outcome.kind === 'defined', why(outcome))
  return outcome
}

function refused(outcome: DefineOutcome): Refusal {
  assert.ok(outcome.kind === 'refused', why(outcome))
  return outcome.refusal
}

// A file a human already reviewed: a comment of its own, one Provision with two harness entries, and
// a second Provision below it. Every test asserts against this text byte for byte.
const REVIEWED = `version = 1

# Provisions below are reviewed by hand
[provision.serena]
tags = ["mcp"]

[provision.serena.codex]
check   = { file = "~/.codex/config.toml", contains = "^\\\\[mcp_servers.serena\\\\]" } # keep the anchor
install = "python3 scripts/merge-codex-mcp.py serena"

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json", contains = "serena" }
install = "pi plugin install serena"

# zeta sits below serena, so an added table has a sibling on both sides
[provision.zeta.pi]
check   = { file = "~/.pi/agent/mcp.json", contains = "zeta" }
install = "pi plugin install zeta"
`

test('a definition is a row status reports, with the Presence its Check answers', () => {
  const f = fixture()
  write(path.join(f.home, 'AGENTS.md'), '# AGENTS\n\n@RTK\n')
  const outcome = defined(
    defineProvision(
      {
        name: 'rtk',
        harness: 'pi',
        check: { file: '~/AGENTS.md', contains: '^@RTK' },
        install: 'npx rtk init --quiet',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.rtk.pi')
  assert.equal(outcome.tier, 'project-local')
  assert.equal(outcome.file, localFile(f))
  // The digest is the bytes a later read would see, not a value computed on the way past them.
  assert.equal(outcome.digest, digestOfBytes(fs.readFileSync(localFile(f))))
  assert.deepEqual(readStatus({}, f.config).provisions, [
    {
      name: 'rtk',
      tags: [],
      harnesses: [{ harness: 'pi', tier: 'project-local', source: path.join(f.projectRoot, 'agents_environ.local.toml'), presence: 'present', detail: null }],
    },
  ])
})

test('a new harness entry is one added table, and every other byte of the file is unchanged', () => {
  const f = fixture()
  write(localFile(f), REVIEWED)
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'opencode',
        check: { file: '~/.config/opencode/opencode.json', contains: 'serena' },
        install: 'opencode mcp add serena',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.opencode')
  // The comment, the tags table, both sibling harness entries, and zeta's comment above it: all the
  // same bytes, in the same order. The diff is the separator and the table below.
  assert.equal(
    read(localFile(f)),
    `${REVIEWED}
[provision.serena.opencode]
check = { file = "~/.config/opencode/opencode.json", contains = "serena" }
install = "opencode mcp add serena"
`,
  )
})

test('a same-key write replaces that entry and leaves the sibling harness entry intact', () => {
  const f = fixture()
  write(localFile(f), REVIEWED)
  write(path.join(f.home, '.codex', 'config.toml'), '[mcp_servers.serena]\ncommand = "uvx"\n')
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'codex',
        check: { file: '~/.codex/config.toml', contains: 'mcp_servers.serena' },
        install: 'python3 scripts/merge-codex-mcp.py serena --replace',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.codex')
  // Only the two lines of the entry named are new — the address formatter drops the alignment —
  // and the human's trailing comment on the check line stays where it was.
  assert.equal(
    read(localFile(f)),
    `version = 1

# Provisions below are reviewed by hand
[provision.serena]
tags = ["mcp"]

[provision.serena.codex]
check = { file = "~/.codex/config.toml", contains = "mcp_servers.serena" } # keep the anchor
install = "python3 scripts/merge-codex-mcp.py serena --replace"

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json", contains = "serena" }
install = "pi plugin install serena"

# zeta sits below serena, so an added table has a sibling on both sides
[provision.zeta.pi]
check   = { file = "~/.pi/agent/mcp.json", contains = "zeta" }
install = "pi plugin install zeta"
`,
  )
  // The replacement is the definition in force: status now answers with the new Check.
  assert.deepEqual(
    readStatus({ name: 'serena' }, f.config).provisions.flatMap((row) => row.harnesses),
    [
      { harness: 'codex', tier: 'project-local', source: path.join(f.projectRoot, 'agents_environ.local.toml'), presence: 'present', detail: null },
      {
        harness: 'pi',
        tier: 'project-local',
        source: path.join(f.projectRoot, 'agents_environ.local.toml'),
        presence: 'absent',
        detail: `${path.join(f.home, '.pi', 'agent', 'mcp.json')} is not there`,
      },
    ],
  )
})

// The other half of "a same-key write replaces that Provision's harness subtree only": the command
// the entry already carries is part of that subtree, so a definition that names a new one replaces it
// rather than leaving the old text in force beside the new Check.
test('a same-key definition replaces the Install command the entry already carried', () => {
  const f = fixture()
  write(localFile(f), REVIEWED)
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        check: { file: '~/.pi/agent/mcp.json', contains: 'serena' },
        install: 'pi plugin add serena --pinned',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.pi')
  const written = read(localFile(f))
  assert.match(written, /^install = "pi plugin add serena --pinned"$/m)
  assert.equal(written.includes('pi plugin install serena'), false, 'the command the entry carried survived')
  // The sibling harness entry and every other Provision are the bytes the human wrote.
  assert.match(written, /^install = "python3 scripts\/merge-codex-mcp\.py serena"$/m)
  assert.match(written, /^install = "pi plugin install zeta"$/m)
})

test('an unreviewed definition lands in the gitignored file, and an explicit tier writes that file', () => {
  const f = fixture()
  const user = `version = 1\n\n[provision.rtk.pi]\ncheck = { file = "~/AGENTS.md" }\ninstall = "npx rtk init"\n`
  const committed = `version = 1\n\n# the repository requires nothing yet\n`
  write(userFile(f), user)
  write(committedFile(f), committed)
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'codex',
        check: { file: '~/.codex/config.toml', contains: 'mcp_servers.serena' },
        install: 'python3 scripts/merge-codex-mcp.py serena',
      },
      f.config,
    ),
  )
  assert.equal(outcome.tier, 'project-local')
  assert.equal(outcome.file, localFile(f))
  assert.equal(
    read(localFile(f)),
    `version = 1

[provision.serena.codex]
check = { file = "~/.codex/config.toml", contains = "mcp_servers.serena" }
install = "python3 scripts/merge-codex-mcp.py serena"
`,
  )
  assert.equal(read(userFile(f)), user, 'the user file changed')
  assert.equal(read(committedFile(f)), committed, 'the committed file changed')

  // A caller that names the tier gets that file, and the other two are still untouched.
  const local = read(localFile(f))
  const named = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        tier: 'user',
        check: { file: '~/.pi/agent/mcp.json', contains: 'serena' },
        install: 'pi plugin install serena',
      },
      f.config,
    ),
  )
  assert.equal(named.tier, 'user')
  assert.equal(named.file, userFile(f))
  assert.match(read(userFile(f)), /\n\[provision\.serena\.pi\]\n/)
  assert.equal(read(localFile(f)), local, 'the project-local file changed')
  assert.equal(read(committedFile(f)), committed, 'the committed file changed')
})

// Each case is a definition, and the same declaration as a human would have hand-written it into the
// file: the reason the loader gives for that file is the reason the tool has to give back.
interface RefusalCase {
  readonly what: string
  readonly request: DefineRequest
  readonly handWritten: string
}

const REFUSAL_CASES: readonly RefusalCase[] = [
  {
    what: 'an unknown harness',
    request: { name: 'delta', harness: 'gemini', check: { file: '~/.gemini/settings.json' }, install: 'gemini mcp add delta' },
    handWritten: `version = 1\n\n[provision.delta.gemini]\ncheck = { file = "~/.gemini/settings.json" }\ninstall = "gemini mcp add delta"\n`,
  },
  {
    what: 'an empty contains',
    request: { name: 'delta', harness: 'codex', check: { file: '~/.codex/config.toml', contains: '' }, install: 'x' },
    handWritten: `version = 1\n\n[provision.delta.codex]\ncheck = { file = "~/.codex/config.toml", contains = "" }\ninstall = "x"\n`,
  },
  {
    what: 'an unknown predicate',
    request: { name: 'delta', harness: 'codex', check: { file: '~/.codex/config.toml', grep: 'serena' }, install: 'x' },
    handWritten: `version = 1\n\n[provision.delta.codex]\ncheck = { file = "~/.codex/config.toml", grep = "serena" }\ninstall = "x"\n`,
  },
]

function loaderReason(handWritten: string): string {
  const f = fixture()
  write(userFile(f), handWritten)
  const [first] = readStatus({}, f.config).refusals
  assert.ok(first !== undefined, 'the loader accepted the hand-written file')
  return first.reason
}

test('a definition the loader would refuse is refused with that reason and writes nothing', () => {
  for (const sample of REFUSAL_CASES) {
    const f = fixture()
    write(localFile(f), REVIEWED)
    const refusal = refused(defineProvision(sample.request, f.config))
    assert.equal(refusal.reason, loaderReason(sample.handWritten), sample.what)
    assert.equal(read(localFile(f)), REVIEWED, `${sample.what} changed the file`)
  }
  // A refused definition does not create the tier's file either: a half-written environment is worse
  // than none, because the next read would report a Provision nobody declared.
  const f = fixture()
  refused(
    defineProvision(
      { name: 'delta', harness: 'gemini', check: { file: '~/.gemini/settings.json' }, install: 'gemini mcp add delta' },
      f.config,
    ),
  )
  assert.equal(fs.existsSync(localFile(f)), false)
})

test('a definition never evaluates its Check: no Presence is computed and nothing else is written', () => {
  const f = fixture()
  write(path.join(f.home, 'AGENTS.md'), '# AGENTS\n\n@RTK\n')
  // A pattern that is not a regex at all. Evaluating it would answer `unknown`; a definition that
  // never evaluates cannot notice, so a written definition is the proof it did not.
  const outcome = defined(
    defineProvision(
      {
        name: 'rtk',
        harness: 'pi',
        check: { file: '~/AGENTS.md', contains: '(' },
        install: 'npx rtk init --quiet',
      },
      f.config,
    ),
  )
  assert.deepEqual(Object.keys(outcome).sort(), ['digest', 'file', 'kind', 'pointer', 'tier'])
  assert.equal(fs.existsSync(f.config.storePath), false, 'the definition wrote to the store')

  // Answered when the environment is read, and only then.
  const [row] = readStatus({}, f.config).provisions
  const [entry] = row?.harnesses ?? []
  assert.equal(entry?.presence, 'unknown')
  assert.match(entry?.detail ?? '', /invalid pattern \(/)
})

// A definition that declares several Checks writes the list spelling, and status reads the fold of
// what landed rather than the request's own word for it.
test('a definition with a checks list writes checks, and status folds the Checks', () => {
  const f = fixture()
  write(path.join(f.home, 'AGENTS.md'), '# AGENTS\n\n@RTK\n')
  const outcome = defined(
    defineProvision(
      {
        name: 'rtk',
        harness: 'pi',
        checks: [
          { file: '~/AGENTS.md', contains: '^@RTK' },
          { file: '~/AGENTS.md', contains: '^## Output style' },
        ],
        install: 'npx rtk init --quiet',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.rtk.pi')
  assert.equal(
    read(localFile(f)),
    `version = 1

[provision.rtk.pi]
checks = [{ file = "~/AGENTS.md", contains = "^@RTK" }, { file = "~/AGENTS.md", contains = "^## Output style" }]
install = "npx rtk init --quiet"
`,
  )
  assert.deepEqual(readStatus({}, f.config).provisions, [
    {
      name: 'rtk',
      tags: [],
      harnesses: [
        {
          harness: 'pi',
          tier: 'project-local',
          source: path.join(f.projectRoot, 'agents_environ.local.toml'),
          presence: 'absent',
          detail: `${path.join(f.home, 'AGENTS.md')} does not contain ^## Output style`,
        },
      ],
    },
  ])
})

test('a definition adds tags to a Provision it creates, and leaves a declared list alone', () => {
  const f = fixture()
  const outcome = defined(
    defineProvision(
      {
        name: 'rtk',
        harness: 'pi',
        check: { file: '~/AGENTS.md', contains: '^@RTK' },
        install: 'npx rtk init --quiet',
        tags: ['prompt'],
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.rtk.pi')
  assert.equal(
    read(localFile(f)),
    `version = 1

[provision.rtk]
tags = ["prompt"]

[provision.rtk.pi]
check = { file = "~/AGENTS.md", contains = "^@RTK" }
install = "npx rtk init --quiet"
`,
  )
  // The reviewed list is the human's: a later definition for the same Provision does not replace it.
  defined(
    defineProvision(
      {
        name: 'rtk',
        harness: 'codex',
        check: { file: '~/.codex/config.toml', contains: 'rtk' },
        install: 'python3 scripts/merge-codex-mcp.py rtk',
        tags: ['mcp'],
      },
      f.config,
    ),
  )
  assert.deepEqual(readStatus({ name: 'rtk' }, f.config).provisions[0]?.tags, ['prompt'])
})

test('the third harness is defined from what the other two declare, and status reports all three', () => {
  const f = fixture()
  // Two harnesses are configured on this machine, each addressing serena its own way.
  write(
    path.join(f.home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: { serena: { command: 'uvx', args: ['serena', 'start-mcp-server'] } } }),
  )
  write(path.join(f.home, '.codex', 'config.toml'), '[mcp_servers.serena]\ncommand = "uvx"\n')

  // What the agent reads: the native location each existing harness already uses.
  const pi = readNativeConfig('pi', 'pi:user', f.config)
  const codex = readNativeConfig('codex', 'codex:user', f.config)
  assert.deepEqual(
    pi.tiers.flatMap((tier) => tier.declarations.map((declaration) => `${declaration.file} ${declaration.pointer}`)),
    [`${path.join(f.home, '.pi', 'agent', 'mcp.json')} mcpServers.serena`],
  )
  assert.deepEqual(
    codex.tiers.flatMap((tier) => tier.declarations.map((declaration) => `${declaration.file} ${declaration.pointer}`)),
    [`${path.join(f.home, '.codex', 'config.toml')} mcp_servers.serena`],
  )

  // The repository declares serena for the two harnesses that exist, and the agent adds the third to
  // the gitignored file.
  const committed = `version = 1

[provision.serena]
tags = ["mcp"]

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json", contains = "serena" }
install = "pi plugin install serena"

[provision.serena.codex]
check   = { file = "~/.codex/config.toml", contains = "mcp_servers.serena" }
install = "python3 scripts/merge-codex-mcp.py serena"
`
  write(committedFile(f), committed)
  write(
    path.join(f.home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ mcp: { serena: { type: 'local', command: ['serena'] } } }),
  )

  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'opencode',
        check: { file: '~/.config/opencode/opencode.json', contains: 'serena' },
        install: 'opencode mcp add serena',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.opencode')
  assert.equal(outcome.tier, 'project-local')
  assert.equal(read(committedFile(f)), committed, 'the committed file changed')
  // The diff is the added table: nothing else in the file moved, because there was nothing else.
  assert.equal(
    read(localFile(f)),
    `version = 1

[provision.serena.opencode]
check = { file = "~/.config/opencode/opencode.json", contains = "serena" }
install = "opencode mcp add serena"
`,
  )

  // One Provision, three harness entries, each at the tier that declares it.
  assert.deepEqual(readStatus({}, f.config).provisions, [
    {
      name: 'serena',
      tags: ['mcp'],
      harnesses: [
        { harness: 'pi', tier: 'project', source: path.join(f.projectRoot, 'agents_environ.toml'), presence: 'present', detail: null },
        { harness: 'codex', tier: 'project', source: path.join(f.projectRoot, 'agents_environ.toml'), presence: 'present', detail: null },
        { harness: 'opencode', tier: 'project-local', source: path.join(f.projectRoot, 'agents_environ.local.toml'), presence: 'present', detail: null },
      ],
    },
  ])
})

test('a definition with a payload install writes the table form the file spells, and it loads', () => {
  const f = fixture()
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'codex',
        check: { file: '~/.codex/config.toml', contains: 'serena' },
        install: { payload: 'install/codex-mcp.sh', args: ['serena'] },
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.codex')
  assert.equal(
    read(localFile(f)),
    `version = 1

[provision.serena.codex]
check = { file = "~/.codex/config.toml", contains = "serena" }
install = { payload = "install/codex-mcp.sh", args = ["serena"] }
`,
  )
  // The written form is one the loader accepts: the entry is read back with its Presence, not
  // reported as a file that refuses to load.
  const status = readStatus({ name: 'serena' }, f.config)
  assert.equal(status.refusals.length, 0)
  assert.equal(status.provisions[0].harnesses[0].presence, 'absent')
})

test('a definition with a section install writes the table form the file spells, and it loads', () => {
  const f = fixture()
  const outcome = defined(
    defineProvision(
      {
        name: 'i-have-adhd',
        harness: 'pi',
        check: { file: '~/.pi/agent/AGENTS.md', section: 'instructions/output-style.md' },
        install: { file: '~/.pi/agent/AGENTS.md', section: 'instructions/output-style.md' },
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.i-have-adhd.pi')
  assert.equal(
    read(localFile(f)),
    `version = 1

[provision.i-have-adhd.pi]
check = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }
install = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }
`,
  )
  // The written form is one the loader accepts: the entry is read back with its Presence, not
  // reported as a file that refuses to load.
  const status = readStatus({ name: 'i-have-adhd' }, f.config)
  assert.equal(status.refusals.length, 0)
  assert.equal(status.provisions[0].harnesses[0].presence, 'absent')
})

// A Payload shape the parser refuses is refused with that reason, and the file is left as it was:
// the write never reaches disk.
test('a payload definition the loader would refuse is refused with that reason and writes nothing', () => {
  const f = fixture()
  write(localFile(f), REVIEWED)
  const notAString = refused(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        check: { file: '~/.pi/agent/mcp.json' },
        install: brokenInstall({ payload: 1 }),
      },
      f.config,
    ),
  )
  assert.equal(notAString.reason, 'payload must be a string')
  assert.equal(read(localFile(f)), REVIEWED, 'the refused definition changed the file')

  const missing = refused(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        check: { file: '~/.pi/agent/mcp.json' },
        install: brokenInstall({}),
      },
      f.config,
    ),
  )
  assert.equal(missing.reason, 'install has no payload')
  assert.equal(read(localFile(f)), REVIEWED, 'the refused definition changed the file')
})

// A definition can name an Install shape the file parser must refuse, the way a loose client could:
// the request type will not spell it, so the test smuggles one past it on purpose. The parameter is
// the file's own value domain, which is what a boundary would have handed over.
function brokenInstall(value: Record<string, NativeValue>): DefineRequest['install'] {
  // SAFETY: the test deliberately names a shape the file parser must refuse.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the broken shape is the point of the test
  return value as unknown as DefineRequest['install']
}
