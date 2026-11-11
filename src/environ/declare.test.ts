import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineConfig } from '../engine/config.ts'
import { declareHarnesses, listHarnesses, readStatus } from './service.ts'
import type { DeclareOutcome } from './service.ts'
import type { EnvironmentTier, Refusal } from './types.ts'

// Seam A: a declaration against a fixture home and a fixture project root, and then the rows
// `acm status` and `list_harnesses` report from what landed. The assertions are the bytes on disk
// and the rows, never how the write got there.

interface Fixture {
  home: string
  projectRoot: string
  config: EngineConfig
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-declare-'))
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

function projectFile(f: Fixture): string {
  return path.join(f.projectRoot, 'agents_environ.toml')
}

// The reason a declaration did not land, for the assertion message rather than for an answer.
function why(outcome: DeclareOutcome): string {
  if (outcome.kind === 'refused') {
    return `${outcome.refusal.line}:${outcome.refusal.column}: ${outcome.refusal.reason}`
  }
  return outcome.kind === 'failed' ? outcome.reason : 'the list was written'
}

function declared(outcome: DeclareOutcome): Extract<DeclareOutcome, { kind: 'defined' }> {
  assert.ok(outcome.kind === 'defined', why(outcome))
  return outcome
}

function refused(outcome: DeclareOutcome): Refusal {
  assert.ok(outcome.kind === 'refused', why(outcome))
  return outcome.refusal
}

// A file a human already reviewed: comments, an existing list, and one Provision with two harness
// entries. Every test asserts against these bytes.
const REVIEWED = `version = 1

# the harnesses this file faces
harnesses = ["pi", "codex"]

[provision.serena]
# keep this comment
tags = ["mcp"]

[provision.serena.pi]
check = { file = "x" }
install = "y"

[provision.serena.codex]
check = { file = "z" }
install = "w"
`

const REVIEWED_WRITTEN = `version = 1

# the harnesses this file faces
harnesses = ["pi", "codex", "opencode"]

[provision.serena]
# keep this comment
tags = ["mcp"]

[provision.serena.pi]
check = { file = "x" }
install = "y"

[provision.serena.codex]
check = { file = "z" }
install = "w"
`

// The list replaces the file's own key whole: the new list lands where the old one sat, comments
// and sibling Provisions untouched.
test('a declaration writes the tier\'s harnesses at the top of the file, comments and siblings kept', () => {
  const f = fixture()
  write(userFile(f), REVIEWED)
  const outcome = declareHarnesses({ tier: 'user', harnesses: ['pi', 'codex', 'opencode'] }, f.config)
  const answer = declared(outcome)
  assert.equal(answer.tier, 'user')
  assert.equal(answer.file, userFile(f))
  assert.equal(read(userFile(f)), REVIEWED_WRITTEN)
  assert.deepEqual(listHarnesses({ tier: 'user' }, f.config), ['pi', 'codex', 'opencode'])
})

// A file with no list yet gets the key written as a root key: before the first table, never inside
// one, and after the comments that belong to that table.
test('a declaration on a file with no list writes the key at the top of the file', () => {
  const f = fixture()
  write(
    userFile(f),
    `version = 1

# Provisions below are reviewed by hand
[provision.serena.pi]
check = { file = "x" }
install = "y"
`,
  )
  const outcome = declareHarnesses({ tier: 'user', harnesses: ['pi'] }, f.config)
  declared(outcome)
  assert.equal(
    read(userFile(f)),
    `version = 1
harnesses = ["pi"]

# Provisions below are reviewed by hand
[provision.serena.pi]
check = { file = "x" }
install = "y"
`,
  )
})

// An empty list is the clear: the key is gone, the next read sees no declared harnesses for that
// tier, and the other tier is untouched.
test('an empty list removes the key and the next read sees no declared harnesses', () => {
  const f = fixture()
  write(userFile(f), REVIEWED)
  write(projectFile(f), 'version = 1\n\nharnesses = ["opencode"]\n')
  declared(declareHarnesses({ tier: 'user', harnesses: [] }, f.config))
  assert.equal(
    read(userFile(f)),
    `version = 1

# the harnesses this file faces

[provision.serena]
# keep this comment
tags = ["mcp"]

[provision.serena.pi]
check = { file = "x" }
install = "y"

[provision.serena.codex]
check = { file = "z" }
install = "w"
`,
  )
  assert.deepEqual(listHarnesses(f.config), { user: [], project: ['opencode'] })
  // The cleared file loads: the provisions still report, and no harness constraint remains.
  assert.equal(readStatus({}, f.config).provisions.length, 1)
})

// A list that excludes a harness an existing entry uses would make the file unloadable, so the
// write is refused with the parser's reason and the file is left as it was.
test('a list that excludes a harness an existing entry uses is refused, file unchanged', () => {
  const f = fixture()
  write(userFile(f), REVIEWED)
  const before = read(userFile(f))
  const outcome = declareHarnesses({ tier: 'user', harnesses: ['pi'] }, f.config)
  const refusal = refused(outcome)
  assert.match(refusal.reason, /harness 'codex' is not one of this file's harnesses/)
  assert.equal(read(userFile(f)), before)
})

// The list constrains only its own file: writing the project tier leaves the user tier's file and
// list exactly as they were, and a second write replaces the list whole rather than merging.
test('a write lands in the named tier only', () => {
  const f = fixture()
  write(userFile(f), 'version = 1\n')
  write(
    projectFile(f),
    `version = 1

harnesses = ["opencode"]

[provision.delta.opencode]
check = { file = "x" }
install = "y"
`,
  )
  declared(declareHarnesses({ tier: 'project', harnesses: ['opencode', 'pi', 'codex'] }, f.config))
  assert.deepEqual(listHarnesses(f.config), { user: [], project: ['opencode', 'pi', 'codex'] })
  assert.equal(read(userFile(f)), 'version = 1\n')
  // And a second write replaces the list whole rather than merging — here narrowing to the one
  // harness the file's entry still uses.
  declared(declareHarnesses({ tier: 'project', harnesses: ['opencode'] }, f.config))
  assert.deepEqual(listHarnesses({ tier: 'project' }, f.config), ['opencode'])
})

// A file the loader already refuses is not one to add a list to: the refusal is the loader's own.
test('a declaration on a refused file answers the file\'s refusal', () => {
  const f = fixture()
  write(userFile(f), 'version = 2\n')
  const before = read(userFile(f))
  const outcome = declareHarnesses({ tier: 'user', harnesses: ['pi'] }, f.config)
  const refusal = refused(outcome)
  assert.match(refusal.reason, /version 2 is not supported/)
  assert.equal(read(userFile(f)), before)
})

// A tier outside the closed list names no file: the declaration fails with a reason rather than
// throwing.
test('a tier outside the closed list fails with a reason', () => {
  const f = fixture()
  // SAFETY: the point of the test is a tier the closed list does not hold, so the request is
  // spelled past the type on purpose.
  const outcome = declareHarnesses({ tier: 'local' as EnvironmentTier, harnesses: ['pi'] }, f.config)
  assert.equal(outcome.kind, 'failed')
})
