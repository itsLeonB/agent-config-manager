import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { EngineConfig } from '../engine/config.ts'
import { digestOfBytes } from '../engine/digest.ts'
import { declareHarnesses, defineProvision, readNativeConfig, readStatus } from './service.ts'
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

// The file a definition lands in when its caller names the project tier: the committed
// `agents_environ.toml` in the Project root.
function projectFile(f: Fixture): string {
  return path.join(f.projectRoot, 'agents_environ.toml')
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

test('project writes refuse a file that also belongs to the user tier', () => {
  for (const alias of [false, true]) {
    const f = fixture()
    const projectRoot = alias ? path.join(path.dirname(f.home), 'home-link') : f.home
    if (alias) fs.symlinkSync(f.home, projectRoot)
    const config = { ...f.config, projectRoot }
    write(userFile(f), 'version = 1\n')
    const before = read(userFile(f))
    const outcomes = [
      defineProvision({ name: 'demo', harness: 'pi', tier: 'project', check: { file: 'x' }, install: 'run' }, config),
      declareHarnesses({ tier: 'project', harnesses: ['pi'] }, config),
    ]
    for (const outcome of outcomes) {
      assert.equal(outcome.kind, 'failed')
      assert.match(why(outcome), /user.*project|project.*user/)
    }
    assert.equal(read(userFile(f)), before)
    defined(declareHarnesses({ tier: 'user', harnesses: ['pi'] }, config))
  }
})

test('environment writes replace complete files, preserve permissions, and follow symlinks', () => {
  for (const operation of ['define', 'declare']) {
    for (const symlink of [false, true]) {
      const f = fixture()
      const destination = symlink ? path.join(f.home, 'actual.toml') : userFile(f)
      const before = 'version = 1\n'
      write(destination, before)
      fs.chmodSync(destination, 0o600)
      if (symlink) fs.symlinkSync(destination, userFile(f))
      const snapshot = path.join(f.home, 'snapshot.toml')
      fs.linkSync(destination, snapshot)
      const files = fs.readdirSync(f.home)
      const outcome = operation === 'define'
        ? defineProvision({ name: 'demo', harness: 'pi', tier: 'user', check: { file: 'x' }, install: 'run' }, f.config)
        : declareHarnesses({ tier: 'user', harnesses: ['pi'] }, f.config)
      assert.equal(defined(outcome).file, userFile(f))
      assert.equal(read(snapshot), before)
      assert.notEqual(read(destination), before)
      assert.equal(fs.statSync(destination).mode & 0o777, 0o600)
      assert.deepEqual(fs.readdirSync(f.home), files)
      if (symlink) assert.ok(fs.lstatSync(userFile(f)).isSymbolicLink())
    }
  }
})

test('an environment symlink to a missing file keeps its destination', () => {
  const f = fixture()
  const destination = path.join(f.home, 'nested', 'actual.toml')
  fs.symlinkSync(destination, userFile(f))
  defined(declareHarnesses({ tier: 'user', harnesses: ['pi'] }, f.config))
  assert.ok(fs.lstatSync(userFile(f)).isSymbolicLink())
  assert.equal(read(destination), read(userFile(f)))
})

test('refusals and read failures leave the destination and write directory unchanged', () => {
  const f = fixture()
  write(userFile(f), 'version = 1\n')
  const before = read(userFile(f))
  const files = fs.readdirSync(f.home)
  assert.equal(declareHarnesses({ tier: 'user', harnesses: [''] }, f.config).kind, 'refused')
  assert.equal(read(userFile(f)), before)
  assert.deepEqual(fs.readdirSync(f.home), files)
  fs.unlinkSync(userFile(f))
  fs.mkdirSync(userFile(f))
  assert.equal(declareHarnesses({ tier: 'user', harnesses: ['pi'] }, f.config).kind, 'failed')
  assert.ok(fs.statSync(userFile(f)).isDirectory())
  assert.deepEqual(fs.readdirSync(f.home), files)
  fs.rmdirSync(userFile(f))
  defined(declareHarnesses({ tier: 'user', harnesses: ['pi'] }, f.config))
  assert.deepEqual(fs.readdirSync(f.home), files)
})

test('concurrent definitions and harness declarations do not lose successful writes', async () => {
  const f = fixture()
  write(userFile(f), `version = 1\n${'# padding\n'.repeat(100_000)}`)
  const gate = path.join(f.home, 'start')
  const definition = { name: 'demo', harness: 'pi', tier: 'user', check: { file: 'x' }, install: 'run' } satisfies DefineRequest
  const jobs = [
    `defineProvision(${JSON.stringify(definition)}, config)`,
    'declareHarnesses({ tier: "user", harnesses: ["pi"] }, config)',
  ].map((call) => {
    const child = spawn(process.execPath, ['--eval', `
      import fs from 'node:fs'
      import { defineProvision } from ${JSON.stringify(new URL('./define.ts', import.meta.url).href)}
      import { declareHarnesses } from ${JSON.stringify(new URL('./declare.ts', import.meta.url).href)}
      const config = ${JSON.stringify(f.config)}
      console.log('ready')
      while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      console.log(JSON.stringify(${call}))
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
        if (output.includes('ready\n')) resolve()
      })
      child.on('error', reject)
      child.on('close', () => reject(new Error(errors || output)))
    })
    const result = new Promise<DefineOutcome>((resolve, reject) => {
      child.stderr.on('data', (chunk) => { errors += chunk.toString() })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(errors || output))
        else resolve(JSON.parse(output.trim().split('\n').at(-1) ?? 'null'))
      })
    })
    return { child, ready, result }
  })
  try {
    await Promise.all(jobs.map((job) => job.ready))
    write(gate, '')
    const outcomes = await Promise.all(jobs.map((job) => job.result))
    assert.ok(outcomes.some((outcome) => outcome.kind === 'defined'))
    const status = readStatus({}, f.config)
    if (outcomes[0].kind === 'defined') assert.equal(status.provisions[0]?.name, 'demo')
    if (outcomes[1].kind === 'defined') assert.deepEqual(status.harnesses.user, ['pi'])
    for (const outcome of outcomes) {
      if (outcome.kind !== 'defined') assert.match(why(outcome), /locked|busy/)
    }
    if (outcomes[0].kind !== 'defined') defined(defineProvision(definition, f.config))
    if (outcomes[1].kind !== 'defined') defined(declareHarnesses({ tier: 'user', harnesses: ['pi'] }, f.config))
    const retried = readStatus({}, f.config)
    assert.equal(retried.provisions[0]?.name, 'demo')
    assert.deepEqual(retried.harnesses.user, ['pi'])
  } finally {
    for (const job of jobs) job.child.kill()
  }
})

test('a definition is a row status reports, with the Presence its Check answers', () => {
  const f = fixture()
  write(path.join(f.home, 'AGENTS.md'), '# AGENTS\n\n@RTK\n')
  const outcome = defined(
    defineProvision(
      {
        name: 'rtk',
        harness: 'pi',
        tier: 'project',
        check: { file: '~/AGENTS.md', contains: '^@RTK' },
        install: 'npx rtk init --quiet',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.rtk.pi')
  assert.equal(outcome.tier, 'project')
  assert.equal(outcome.file, projectFile(f))
  // The digest is the bytes a later read would see, not a value computed on the way past them.
  assert.equal(outcome.digest, digestOfBytes(fs.readFileSync(projectFile(f))))
  assert.deepEqual(readStatus({}, f.config).provisions, [
    {
      name: 'rtk',
      tags: [],
      harnesses: [{ harness: 'pi', tier: 'project', source: path.join(f.projectRoot, 'agents_environ.toml'), presence: 'present', detail: null }],
    },
  ])
})

test('a new harness entry is one added table, and every other byte of the file is unchanged', () => {
  const f = fixture()
  write(projectFile(f), REVIEWED)
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'opencode',
        tier: 'project',
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
    read(projectFile(f)),
    `${REVIEWED}
[provision.serena.opencode]
check = { file = "~/.config/opencode/opencode.json", contains = "serena" }
install = "opencode mcp add serena"
`,
  )
})

test('a same-key write replaces that entry and leaves the sibling harness entry intact', () => {
  const f = fixture()
  write(projectFile(f), REVIEWED)
  write(path.join(f.home, '.codex', 'config.toml'), '[mcp_servers.serena]\ncommand = "uvx"\n')
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'codex',
        tier: 'project',
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
    read(projectFile(f)),
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
      { harness: 'codex', tier: 'project', source: path.join(f.projectRoot, 'agents_environ.toml'), presence: 'present', detail: null },
      {
        harness: 'pi',
        tier: 'project',
        source: path.join(f.projectRoot, 'agents_environ.toml'),
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
  write(projectFile(f), REVIEWED)
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        tier: 'project',
        check: { file: '~/.pi/agent/mcp.json', contains: 'serena' },
        install: 'pi plugin add serena --pinned',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.pi')
  const written = read(projectFile(f))
  assert.match(written, /^install = "pi plugin add serena --pinned"$/m)
  assert.equal(written.includes('pi plugin install serena'), false, 'the command the entry carried survived')
  // The sibling harness entry and every other Provision are the bytes the human wrote.
  assert.match(written, /^install = "python3 scripts\/merge-codex-mcp\.py serena"$/m)
  assert.match(written, /^install = "pi plugin install zeta"$/m)
})

// A same-key write keeps the entry's Check spelling: a singular Check replaces a `checks` list with
// that list's one element, so the file never holds both keys, which the parser refuses.
test('a singular Check replaces a checks list with its one element, keeping the list spelling', () => {
  const f = fixture()
  write(
    projectFile(f),
    `version = 1

[provision.serena.pi]
checks = [{ file = "~/.pi/mcp.json", contains = "old" }, { file = "~/.pi/other.json" }]
install = "old command"
`,
  )
  write(path.join(f.home, '.pi', 'mcp.json'), '{ "mcpServers": {} }')
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        tier: 'project',
        check: { file: '~/.pi/mcp.json', contains: 'new' },
        install: 'new command',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.pi')
  assert.equal(
    read(projectFile(f)),
    `version = 1

[provision.serena.pi]
checks = [{ file = "~/.pi/mcp.json", contains = "new" }]
install = "new command"
`,
  )
  // The replacement is the definition in force: status folds the one Check that landed.
  const rows = readStatus({}, f.config).provisions.flatMap((row) => row.harnesses)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.presence, 'absent')
  assert.match(rows[0]?.detail ?? '', /does not contain new/)
})

// The other direction: a one-element checks list replaces a singular `check` with that element,
// keeping the singular spelling the entry already had.
test('a one-element checks list replaces a singular check, keeping the singular spelling', () => {
  const f = fixture()
  write(
    projectFile(f),
    `version = 1

[provision.serena.pi]
check = { file = "~/.pi/mcp.json", contains = "old" }
install = "old command"
`,
  )
  write(path.join(f.home, '.pi', 'mcp.json'), '{ "mcpServers": {} }')
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        tier: 'project',
        checks: [{ file: '~/.pi/mcp.json', contains: 'new' }],
        install: 'new command',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.pi')
  assert.equal(
    read(projectFile(f)),
    `version = 1

[provision.serena.pi]
check = { file = "~/.pi/mcp.json", contains = "new" }
install = "new command"
`,
  )
  const rows = readStatus({}, f.config).provisions.flatMap((row) => row.harnesses)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.presence, 'absent')
  assert.match(rows[0]?.detail ?? '', /does not contain new/)
})

test('shared declarations write the Provision table and an empty harness entry', () => {
  const f = fixture()
  write(path.join(f.home, '.agents', '.skill-lock.json'), '{ "skills": { "mattpocock": {} } }')
  const outcome = defined(
    defineProvision(
      {
        name: 'skills-mattpocock',
        harness: 'pi',
        tier: 'project',
        sharedChecks: [{ file: '~/.agents/.skill-lock.json', contains: 'mattpocock' }],
        sharedInstall: 'npx skills add mattpocock/skills -g -y',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.skills-mattpocock.pi')
  assert.equal(
    read(projectFile(f)),
    `version = 1

[provision.skills-mattpocock]
checks = [{ file = "~/.agents/.skill-lock.json", contains = "mattpocock" }]
install = "npx skills add mattpocock/skills -g -y"

[provision.skills-mattpocock.pi]
`,
  )
  assert.deepEqual(readStatus({}, f.config).provisions, [
    {
      name: 'skills-mattpocock',
      tags: [],
      harnesses: [
        {
          harness: 'pi',
          tier: 'project',
          source: path.join(f.projectRoot, 'agents_environ.toml'),
          presence: 'present',
          detail: null,
        },
      ],
    },
  ])
})

test('shared and entry fields write together, and a repeat shared write replaces only the shared keys', () => {
  const f = fixture()
  write(
    projectFile(f),
    `version = 1

# shared declarations are reviewed by hand
[provision.serena]
tags = ["mcp"]
checks = [{ file = "~/.old-shared" }]
install = "old shared install"

[provision.serena.pi]
check = { file = "~/.pi/agent/mcp.json" }
install = "pi plugin install serena"

# zeta stays put
[provision.zeta.pi]
check = { file = "~/.pi/agent/mcp.json", contains = "zeta" }
install = "pi plugin install zeta"
`,
  )
  defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'codex',
        tier: 'project',
        sharedChecks: [{ file: '~/.new-shared' }],
        sharedInstall: 'new shared install',
        check: { file: '~/.codex/config.toml', contains: 'serena' },
        install: 'codex mcp add serena',
      },
      f.config,
    ),
  )
  defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        tier: 'project',
        sharedChecks: [{ file: '~/.newer-shared', contains: 'serena' }],
        sharedInstall: 'newer shared install',
      },
      f.config,
    ),
  )
  assert.equal(
    read(projectFile(f)),
    `version = 1

# shared declarations are reviewed by hand
[provision.serena]
tags = ["mcp"]
checks = [{ file = "~/.newer-shared", contains = "serena" }]
install = "newer shared install"

[provision.serena.pi]
check = { file = "~/.pi/agent/mcp.json" }
install = "pi plugin install serena"

# zeta stays put
[provision.zeta.pi]
check = { file = "~/.pi/agent/mcp.json", contains = "zeta" }
install = "pi plugin install zeta"

[provision.serena.codex]
check = { file = "~/.codex/config.toml", contains = "serena" }
install = "codex mcp add serena"
`,
  )
})

test('a shared checks list keeps the Provision\'s singular check spelling', () => {
  const f = fixture()
  write(
    projectFile(f),
    `version = 1

[provision.serena]
check = { file = "~/.old-shared" }
install = "old shared install"

[provision.serena.pi]
`,
  )
  defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        tier: 'project',
        sharedChecks: [{ file: '~/.new-shared' }],
      },
      f.config,
    ),
  )
  assert.equal(
    read(projectFile(f)),
    `version = 1

[provision.serena]
check = { file = "~/.new-shared" }
install = "old shared install"

[provision.serena.pi]
`,
  )
})

test('shared declarations can be added to a provision that only has harness entries', () => {
  const f = fixture()
  write(
    projectFile(f),
    `version = 1

[provision.serena.pi]
check = { file = "~/.pi/agent/mcp.json" }
install = "pi plugin install serena"
`,
  )
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'codex',
        tier: 'project',
        sharedChecks: [{ file: '~/.local/bin/serena' }],
        sharedInstall: 'uv tool install serena-agent',
        check: { file: '~/.codex/config.toml', contains: 'serena' },
        install: 'codex mcp add serena',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.codex')
  assert.equal(
    read(projectFile(f)),
    `version = 1

[provision.serena.pi]
check = { file = "~/.pi/agent/mcp.json" }
install = "pi plugin install serena"

[provision.serena]
checks = [{ file = "~/.local/bin/serena" }]
install = "uv tool install serena-agent"

[provision.serena.codex]
check = { file = "~/.codex/config.toml", contains = "serena" }
install = "codex mcp add serena"
`,
  )
  assert.deepEqual(
    readStatus({ name: 'serena' }, f.config).provisions[0]?.harnesses.map((entry) => entry.harness),
    ['pi', 'codex'],
  )
})

test('an explicit tier writes that file and nowhere else', () => {
  const f = fixture()
  const user = `version = 1\n\n[provision.rtk.pi]\ncheck = { file = "~/AGENTS.md" }\ninstall = "npx rtk init"\n`
  write(userFile(f), user)
  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'codex',
        tier: 'project',
        check: { file: '~/.codex/config.toml', contains: 'mcp_servers.serena' },
        install: 'python3 scripts/merge-codex-mcp.py serena',
      },
      f.config,
    ),
  )
  assert.equal(outcome.tier, 'project')
  assert.equal(outcome.file, projectFile(f))
  assert.equal(
    read(projectFile(f)),
    `version = 1

[provision.serena.codex]
check = { file = "~/.codex/config.toml", contains = "mcp_servers.serena" }
install = "python3 scripts/merge-codex-mcp.py serena"
`,
  )
  assert.equal(read(userFile(f)), user, 'the user file changed')

  // A caller that names the other tier gets that file, and the project file is untouched.
  const project = read(projectFile(f))
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
  assert.equal(read(projectFile(f)), project, 'the project file changed')
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
    what: 'an empty contains',
    request: { name: 'delta', harness: 'codex', tier: 'project', check: { file: '~/.codex/config.toml', contains: '' }, install: 'x' },
    handWritten: `version = 1\n\n[provision.delta.codex]\ncheck = { file = "~/.codex/config.toml", contains = "" }\ninstall = "x"\n`,
  },
  {
    what: 'an unknown predicate',
    request: { name: 'delta', harness: 'codex', tier: 'project', check: { file: '~/.codex/config.toml', grep: 'serena' }, install: 'x' },
    handWritten: `version = 1\n\n[provision.delta.codex]\ncheck = { file = "~/.codex/config.toml", grep = "serena" }\ninstall = "x"\n`,
  },
  {
    what: 'shared install with no effective Check',
    request: { name: 'delta', harness: 'pi', tier: 'project', sharedInstall: 'x' },
    handWritten: `version = 1\n\n[provision.delta]\ninstall = "x"\n\n[provision.delta.pi]\n`,
  },
  {
    what: 'shared checks with no effective Install command',
    request: { name: 'delta', harness: 'pi', tier: 'project', sharedChecks: [{ file: '~/.x' }] },
    handWritten: `version = 1\n\n[provision.delta]\nchecks = [{ file = "~/.x" }]\n\n[provision.delta.pi]\n`,
  },
]

function loaderReason(handWritten: string): string {
  const f = fixture()
  write(userFile(f), handWritten)
  const [first] = readStatus({}, f.config).refusals
  assert.ok(first !== undefined, 'the loader accepted the hand-written file')
  return first.reason
}

test('a definition naming no file\'s tier is refused, not thrown', () => {
  const f = fixture()
  const outcome = defineProvision(
    // SAFETY: the test deliberately names a tier no environment file lives at.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the unknown tier is the point of the test
    { name: 'delta', harness: 'pi', tier: 'system' as never, check: { file: '~/.x' }, install: 'x' },
    f.config,
  )
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.kind === 'failed' ? outcome.reason : '', /no environment file for tier system/)
  assert.equal(fs.existsSync(projectFile(f)), false)
  assert.equal(fs.existsSync(userFile(f)), false)
})

test('a definition the loader would refuse is refused with that reason and writes nothing', () => {
  for (const sample of REFUSAL_CASES) {
    const f = fixture()
    write(projectFile(f), REVIEWED)
    const refusal = refused(defineProvision(sample.request, f.config))
    assert.equal(refusal.reason, loaderReason(sample.handWritten), sample.what)
    assert.equal(read(projectFile(f)), REVIEWED, `${sample.what} changed the file`)
  }
  // A refused definition does not create the tier's file either: a half-written environment is worse
  // than none, because the next read would report a Provision nobody declared.
  const f = fixture()
  refused(
    defineProvision(
      { name: 'delta', harness: 'pi', tier: 'project', check: { file: '~/.x', grep: 'serena' }, install: 'x' },
      f.config,
    ),
  )
  assert.equal(fs.existsSync(projectFile(f)), false)
})

// The file's own harness list is the constraint `define_provision` enforces before it writes: an
// entry naming a harness the target file does not face is refused with the parser's reason, and
// the file is left as it was. A file with no list constrains nothing.
test('a harness the target file\'s list does not name is refused, and the file is unchanged', () => {
  const f = fixture()
  write(
    projectFile(f),
    'version = 1\n\nharnesses = ["pi", "codex"]\n\n[provision.serena.pi]\ncheck = { file = "x" }\ninstall = "true"\n',
  )
  const refusal = refused(
    defineProvision(
      {
        name: 'delta',
        harness: 'opencode',
        tier: 'project',
        check: { file: '~/.x' },
        install: 'x',
      },
      f.config,
    ),
  )
  assert.equal(refusal.reason, "harness 'opencode' is not one of this file's harnesses: pi, codex")
  assert.equal(read(projectFile(f)).includes('delta'), false, 'the refused definition changed the file')

  // The same harness the list names is defined, and a file with no list still accepts any name.
  defined(
    defineProvision(
      { name: 'delta', harness: 'codex', tier: 'project', check: { file: '~/.x' }, install: 'x' },
      f.config,
    ),
  )
  write(userFile(f), 'version = 1\n')
  defined(
    defineProvision(
      { name: 'delta', harness: 'opencode', tier: 'user', check: { file: '~/.x' }, install: 'x' },
      f.config,
    ),
  )
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
        tier: 'project',
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
        tier: 'project',
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
    read(projectFile(f)),
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
          tier: 'project',
          source: path.join(f.projectRoot, 'agents_environ.toml'),
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
        tier: 'project',
        check: { file: '~/AGENTS.md', contains: '^@RTK' },
        install: 'npx rtk init --quiet',
        tags: ['prompt'],
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.rtk.pi')
  assert.equal(
    read(projectFile(f)),
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
        tier: 'project',
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

  // The repository declares serena for the two harnesses that exist, and the agent adds the third
  // to the project file — the caller names the tier, so the write is deliberate.
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
  write(projectFile(f), committed)
  write(
    path.join(f.home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ mcp: { serena: { type: 'local', command: ['serena'] } } }),
  )

  const outcome = defined(
    defineProvision(
      {
        name: 'serena',
        harness: 'opencode',
        tier: 'project',
        check: { file: '~/.config/opencode/opencode.json', contains: 'serena' },
        install: 'opencode mcp add serena',
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.opencode')
  assert.equal(outcome.tier, 'project')
  // The diff is the added table: nothing else in the file moved, because there was nothing else.
  assert.equal(
    read(projectFile(f)),
    `${committed}
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
        { harness: 'opencode', tier: 'project', source: path.join(f.projectRoot, 'agents_environ.toml'), presence: 'present', detail: null },
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
        tier: 'project',
        check: { file: '~/.codex/config.toml', contains: 'serena' },
        install: { payload: 'install/codex-mcp.sh', args: ['serena'] },
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.serena.codex')
  assert.equal(
    read(projectFile(f)),
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
        tier: 'project',
        check: { file: '~/.pi/agent/AGENTS.md', section: 'instructions/output-style.md' },
        install: { file: '~/.pi/agent/AGENTS.md', section: 'instructions/output-style.md' },
      },
      f.config,
    ),
  )
  assert.equal(outcome.pointer, 'provision.i-have-adhd.pi')
  assert.equal(
    read(projectFile(f)),
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
  write(projectFile(f), REVIEWED)
  const notAString = refused(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        tier: 'project',
        check: { file: '~/.pi/agent/mcp.json' },
        install: brokenInstall({ payload: 1 }),
      },
      f.config,
    ),
  )
  assert.equal(notAString.reason, 'payload must be a string')
  assert.equal(read(projectFile(f)), REVIEWED, 'the refused definition changed the file')

  const missing = refused(
    defineProvision(
      {
        name: 'serena',
        harness: 'pi',
        tier: 'project',
        check: { file: '~/.pi/agent/mcp.json' },
        install: brokenInstall({}),
      },
      f.config,
    ),
  )
  assert.equal(missing.reason, 'install has no payload')
  assert.equal(read(projectFile(f)), REVIEWED, 'the refused definition changed the file')
})

// A definition can name an Install shape the file parser must refuse, the way a loose client could:
// the request type will not spell it, so the test smuggles one past it on purpose. The parameter is
// the file's own value domain, which is what a boundary would have handed over.
function brokenInstall(value: Record<string, NativeValue>): DefineRequest['install'] {
  // SAFETY: the test deliberately names a shape the file parser must refuse.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the broken shape is the point of the test
  return value as unknown as DefineRequest['install']
}
