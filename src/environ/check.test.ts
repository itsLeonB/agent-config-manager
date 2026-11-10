import test from 'node:test'
import assert from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkInputsOf, evaluateCheck } from './check.ts'
import type { CheckInputs } from './check.ts'
import type { Check } from './types.ts'

// Seam B: the evaluator is a pure function of what it is handed, so the fixtures are strings and a
// temp directory standing in for PATH. The filesystem enters only where a Check names it — a Check's
// own file is read by the caller, and a directory that is not there is a cause of `unknown`.

function over(bytes: string | null, pathDirs: readonly string[] = []): CheckInputs {
  return { file: bytes === null ? { kind: 'absent' } : { kind: 'read', bytes }, pathDirs }
}

function presenceOf(check: Check, bytes: string | null) {
  return evaluateCheck(check, over(bytes)).presence
}

test('an exists check is present when the file was read and absent when it is not there', () => {
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc' }, over('export PATH=$PATH:/bin\n')), {
    presence: 'present',
    detail: null,
  })
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc' }, over(null)), { presence: 'absent', detail: null })
})

test('a contains check finds an export in a shell profile', () => {
  const profile = 'export PATH="$HOME/.bun/bin:$PATH"\nexport OPENCODE_DISABLE_CLAUDE_CODE=1\n'
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc', contains: 'OPENCODE_DISABLE_CLAUDE_CODE' }, over(profile)), {
    presence: 'present',
    detail: null,
  })
})

test('a contains check reports absent when the pattern is not in the file', () => {
  const profile = 'export PATH="$HOME/.bun/bin:$PATH"\n'
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc', contains: 'OPENCODE_DISABLE_CLAUDE_CODE' }, over(profile)), {
    presence: 'absent',
    detail: null,
  })
})

// The pattern is a multiline regular expression, which is what lets a markdown block be addressed by
// its heading rather than by the whole file: `^` has to mean the start of a line.
test('a contains pattern with an anchor matches per line, not only at the start of the file', () => {
  const agents = '# AGENTS\n\n## Output style\n\nBe terse.\n'
  assert.deepEqual(evaluateCheck({ file: '/home/ann/AGENTS.md', contains: '^## Output style' }, over(agents)), {
    presence: 'present',
    detail: null,
  })
})

// A pattern that is not a regex is not the same as an absence: the file may be fine and the pattern
// broken, so the answer says it could not be decided and why.
test('a pattern that does not compile is unknown with the reason', () => {
  const answer = evaluateCheck({ file: '/home/ann/.zshrc', contains: 'OPENCODE(' }, over('x\n'))
  assert.equal(answer.presence, 'unknown')
  assert.match(answer.detail ?? '', /OPENCODE\(/)
})

// One address, three file formats: the format is the extension and the address is spelled the same
// way in all of them, which is what lets one Provision's check be written once for JSON and TOML.
const ADDRESS = 'mcp_servers.serena'
const TOML_CONFIG = '[mcp_servers.serena]\ncommand = "uvx"\nargs = ["--from", "serena"]\n'
const JSON_CONFIG = '{"mcp_servers": {"serena": {"command": "uvx", "args": ["--from", "serena"]}}}\n'
// Trailing commas are legal in JSONC and OpenCode writes them, so the fixture carries one in an
// array and one in an object, the second with a comment between the comma and the brace.
const JSONC_CONFIG = `{
  // the serena server
  "mcp_servers": {
    "serena": { /* pinned */ "command": "uvx", "args": ["--from", "serena",] },
    // the last member, and a comma after it
  }
}
`

test('a pointer check addresses the same path in TOML, JSON, and JSONC', () => {
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer: ADDRESS }, TOML_CONFIG), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: ADDRESS }, JSON_CONFIG), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.config/opencode/opencode.jsonc', pointer: ADDRESS }, JSONC_CONFIG), 'present')
})

test('a pointer check reports absent when the address is not in the document', () => {
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer: 'mcp_servers.rtk' }, TOML_CONFIG), 'absent')
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: 'mcp_servers.rtk' }, JSON_CONFIG), 'absent')
  // A value below a leaf is as missing as a leaf below a value: neither document addresses it.
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: 'mcp_servers.serena.command.flag' }, JSON_CONFIG), 'absent')
})

// `equals` is the reason the predicate has a second form: an entry that is in the file but switched
// off is not installed, so the value has to be the one the Provision means, not merely present.
test('an equals check reports absent for an entry the file disables', () => {
  const disabled = '[mcp_servers.serena]\ncommand = "uvx"\ndisabled = true\n'
  const pointer = 'mcp_servers.serena.disabled'
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer }, disabled), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer, equals: true }, disabled), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer, equals: false }, disabled), 'absent')
})

test('an equals check compares a whole value by deep equality, whatever the format', () => {
  const expected = { command: 'uvx', args: ['--from', 'serena'] }
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer: ADDRESS, equals: expected }, TOML_CONFIG), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: ADDRESS, equals: expected }, JSON_CONFIG), 'present')
  // A nested value that differs is a value that differs, and an array's order is part of it.
  const reordered = { command: 'uvx', args: ['serena', '--from'] }
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: ADDRESS, equals: reordered }, JSON_CONFIG), 'absent')
  const otherCommand = { command: 'serena', args: ['--from', 'serena'] }
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: ADDRESS, equals: otherCommand }, JSON_CONFIG), 'absent')
  // A scalar is not the table it would be a member of.
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer: ADDRESS, equals: 'uvx' }, TOML_CONFIG), 'absent')
})

test('a file that does not parse is unknown, with the file and the reason', () => {
  const brokenToml = evaluateCheck({ file: '/home/ann/.codex/config.toml', pointer: ADDRESS }, over('[mcp_servers.serena\n'))
  assert.equal(brokenToml.presence, 'unknown')
  assert.match(brokenToml.detail ?? '', /^\/home\/ann\/\.codex\/config\.toml could not be read: /)
  const brokenJson = evaluateCheck({ file: '/home/ann/.pi/mcp.json', pointer: ADDRESS }, over('{"mcp_servers": '))
  assert.equal(brokenJson.presence, 'unknown')
  assert.match(brokenJson.detail ?? '', /\/home\/ann\/\.pi\/mcp\.json could not be read: /)
})

// A missing file is an answer — nothing is there — while a file that cannot be read is not. This is
// the distinction the fourth Presence value exists for, and it holds for both file predicates.
test('a missing file is absent, addressing the file itself or a value inside it', () => {
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.pi/mcp.json', pointer: ADDRESS }, over(null)), {
    presence: 'absent',
    detail: null,
  })
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.pi/mcp.json' }, over(null)), { presence: 'absent', detail: null })
})

// The read error that is not `ENOENT` is the case this pins: a directory passes an existence test and
// fails the read on every uid, so the fixture does not depend on a permission bit root may ignore.
// Before this, every error was folded into `null` and answered `absent` — an unanswered question
// reported as an absence, for all three file predicates.
test('a file that cannot be read is unknown with the cause, whatever predicate asks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'acm-check-unreadable-'))
  for (const check of [
    { file: directory },
    { file: directory, contains: 'serena' },
    { file: directory, pointer: ADDRESS },
  ] satisfies Check[]) {
    const answer = evaluateCheck(check, checkInputsOf(check))
    assert.equal(answer.presence, 'unknown')
    assert.match(answer.detail ?? '', /could not be read: /)
    assert.ok((answer.detail ?? '').includes(directory), 'the detail does not name the file')
  }
  // The path that is genuinely not there is still an absence, not an unknown.
  const missing = join(directory, 'not-there.toml')
  assert.deepEqual(evaluateCheck({ file: missing, pointer: ADDRESS }, checkInputsOf({ file: missing })), {
    presence: 'absent',
    detail: null,
  })
})

function pathWith(files: { name: string; mode: number }[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'acm-path-'))
  for (const file of files) {
    writeFileSync(join(directory, file.name), '#!/bin/sh\n')
    chmodSync(join(directory, file.name), file.mode)
  }
  return directory
}

test('an onPath check finds a regular executable file', () => {
  const directory = pathWith([{ name: 'serena', mode: 0o755 }])
  assert.deepEqual(evaluateCheck({ onPath: 'serena' }, over(null, [directory])), { presence: 'present', detail: null })
  // A later directory answers when an earlier one does not hold the name.
  assert.equal(evaluateCheck({ onPath: 'serena' }, over(null, ['/nonexistent', directory])).presence, 'present')
})

test('an onPath check is absent for a name that is missing or not executable', () => {
  const directory = pathWith([
    { name: 'notes', mode: 0o644 },
    { name: 'rtk', mode: 0o644 },
  ])
  assert.deepEqual(evaluateCheck({ onPath: 'notes' }, over(null, [directory])), { presence: 'absent', detail: null })
  assert.deepEqual(evaluateCheck({ onPath: 'nothing-here' }, over(null, [directory])), { presence: 'absent', detail: null })
  assert.deepEqual(evaluateCheck({ onPath: 'serena' }, over(null, [])), { presence: 'absent', detail: null })
  // A directory that carries the name is not the regular file a shell would run.
  mkdirSync(join(directory, 'opencode'))
  assert.equal(evaluateCheck({ onPath: 'opencode' }, over(null, [directory])).presence, 'absent')
})

// A PATH entry that cannot be searched is a question that was not answered: the name may be inside
// it, so saying absent would be a guess.
test('a PATH directory that is not there is unknown, with the directory named', () => {
  const answer = evaluateCheck({ onPath: 'serena' }, over(null, ['/home/ann/empty-bin']))
  assert.equal(answer.presence, 'unknown')
  assert.match(answer.detail ?? '', /\/home\/ann\/empty-bin/)
})

test('a PATH entry that is not a directory is unknown too', () => {
  const directory = pathWith([{ name: 'plain-file', mode: 0o755 }])
  const answer = evaluateCheck({ onPath: 'serena' }, over(null, [join(directory, 'plain-file')]))
  assert.equal(answer.presence, 'unknown')
  assert.match(answer.detail ?? '', /is not a directory/)
})
