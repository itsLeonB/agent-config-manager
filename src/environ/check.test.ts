import test from 'node:test'
import assert from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkInputsOf, evaluateCheck, foldAnswers } from './check.ts'
import type { CheckInputs, FileInput } from './check.ts'
import type { Check } from './types.ts'

// Seam B: the evaluator is a pure function of what it is handed, so the fixtures are strings and a
// temp directory standing in for PATH. The filesystem enters only where a Check names it — a Check's
// own file is read by the caller, and a directory that is not there is a cause of `unknown`.

function over(
  bytes: string | null,
  pathDirs: readonly string[] = [],
  payload: FileInput = { kind: 'absent' },
): CheckInputs {
  return { file: bytes === null ? { kind: 'absent' } : { kind: 'read', bytes }, payload, pathDirs }
}

function presenceOf(check: Check, bytes: string | null) {
  return evaluateCheck(check, over(bytes)).presence
}

test('an exists check is present when the file was read and absent when it is not there', () => {
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc' }, over('export PATH=$PATH:/bin\n')), {
    presence: 'present',
    detail: null,
  })
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc' }, over(null)), {
    presence: 'absent',
    detail: '/home/ann/.zshrc is not there',
  })
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
    detail: '/home/ann/.zshrc does not contain OPENCODE_DISABLE_CLAUDE_CODE',
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

// `includes` answers whether the array at an address holds a value, which is how a plugin list is
// addressed without a regex over the whole file.
const PLUGINS_JSON = '{"plugins": ["i-have-adhd", "serena"]}\n'
const PLUGINS_TOML = 'plugins = ["i-have-adhd", "serena"]\n'

test('an includes check answers whether an array holds a string', () => {
  const present = { file: '/home/ann/.config/opencode/opencode.json', pointer: 'plugins', includes: 'i-have-adhd' }
  assert.deepEqual(evaluateCheck(present, over(PLUGINS_JSON)), { presence: 'present', detail: null })
  assert.deepEqual(evaluateCheck({ ...present, file: '/home/ann/.codex/config.toml' }, over(PLUGINS_TOML)), {
    presence: 'present',
    detail: null,
  })
  const absent = evaluateCheck({ ...present, includes: 'rtk' }, over(PLUGINS_JSON))
  assert.deepEqual(absent, {
    presence: 'absent',
    detail: "/home/ann/.config/opencode/opencode.json's plugins does not include the declared value",
  })
  // The address being missing is the same absence, named the same way every missing pointer is.
  const missing = evaluateCheck({ ...present, pointer: 'hooks' }, over(PLUGINS_JSON))
  assert.deepEqual(missing, {
    presence: 'absent',
    detail: '/home/ann/.config/opencode/opencode.json has no hooks',
  })
})

test('an includes check compares array elements by deep equality, whatever the format', () => {
  const serversJson = '{"servers": [{"name": "serena", "command": "uvx"}, {"name": "rtk"}]}\n'
  const serversToml = '[[servers]]\nname = "serena"\ncommand = "uvx"\n\n[[servers]]\nname = "rtk"\n'
  const expected = { name: 'serena', command: 'uvx' }
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: 'servers', includes: expected }, serversJson), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer: 'servers', includes: expected }, serversToml), 'present')
  // A value that is a part of an element is not the element: equality, not containment.
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: 'servers', includes: { name: 'serena' } }, serversJson), 'absent')
})

test('a numeric segment indexes an array element, and a quoted one is a key', () => {
  assert.equal(presenceOf({ file: '/home/ann/.config/opencode/opencode.json', pointer: 'plugins.0', equals: 'i-have-adhd' }, PLUGINS_JSON), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.config/opencode/opencode.json', pointer: 'plugins.1', equals: 'serena' }, PLUGINS_JSON), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer: 'plugins.1' }, PLUGINS_TOML), 'present')
  // An index the array does not hold is as missing as a key the document does not hold.
  const outOfRange = evaluateCheck({ file: '/home/ann/.codex/config.toml', pointer: 'plugins.2' }, over(PLUGINS_TOML))
  assert.deepEqual(outOfRange, { presence: 'absent', detail: '/home/ann/.codex/config.toml has no plugins.2' })
  // The unquoted segment indexes, so on an object it names nothing; `"0"` is the key named 0.
  const objectWithZero = '{"plugins": {"0": "kept"}}\n'
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: 'plugins.0' }, objectWithZero), 'absent')
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: 'plugins."0"', equals: 'kept' }, objectWithZero), 'present')
})

test('a quoted key containing a dot addresses that key in JSON and TOML', () => {
  const dottedJson = '{"mcp_servers": {"my.server": {"command": "uvx"}}}\n'
  const dottedToml = '[mcp_servers."my.server"]\ncommand = "uvx"\n'
  const pointer = 'mcp_servers."my.server".command'
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer, equals: 'uvx' }, dottedJson), 'present')
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer, equals: 'uvx' }, dottedToml), 'present')
  // The unquoted spelling names a member `my`, which neither document holds.
  assert.equal(presenceOf({ file: '/home/ann/.pi/mcp.json', pointer: 'mcp_servers.my.server.command' }, dottedJson), 'absent')
  assert.equal(presenceOf({ file: '/home/ann/.codex/config.toml', pointer: 'mcp_servers.my.server.command' }, dottedToml), 'absent')
})

test('a pointer that cannot be spelled is unknown, never absent', () => {
  const answer = evaluateCheck({ file: '/home/ann/.codex/config.toml', pointer: 'mcp_servers."my.server' }, over('[mcp_servers."my.server"]\n'))
  assert.equal(answer.presence, 'unknown')
  assert.match(answer.detail ?? '', /cannot be spelled/)
})

test('an includes check on a value that is not an array is unknown with the reason', () => {
  const scalar = evaluateCheck({ file: '/home/ann/.config/opencode/opencode.json', pointer: 'plugins', includes: 'i-have-adhd' }, over('{"plugins": "i-have-adhd"}\n'))
  assert.deepEqual(scalar, {
    presence: 'unknown',
    detail: "/home/ann/.config/opencode/opencode.json's plugins is not an array",
  })
  const table = evaluateCheck({ file: '/home/ann/.config/opencode/opencode.json', pointer: 'plugins', includes: 'i-have-adhd' }, over('{"plugins": {"name": "x"}}\n'))
  assert.equal(table.presence, 'unknown')
  assert.match(table.detail ?? '', /is not an array/)
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
    detail: '/home/ann/.pi/mcp.json is not there',
  })
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.pi/mcp.json' }, over(null)), {
    presence: 'absent',
    detail: '/home/ann/.pi/mcp.json is not there',
  })
})

// A Section Check compares two texts: the Payload's is the Section's, heading included, and only
// trailing blank lines may differ between the two sides.
const AGENTS = `# AGENTS.md

## Output style

Be terse.

## Next heading

More text.
`
const INSTRUCTIONS = `## Output style

Be terse.
`
const SECTION_CHECK = { file: '/home/ann/.pi/agent/AGENTS.md', section: '/home/ann/.pi/agent/instructions/output-style.md' }

test('a section check is present when the Section matches the Payload, trailing blank lines apart', () => {
  assert.deepEqual(evaluateCheck(SECTION_CHECK, over(AGENTS, [], { kind: 'read', bytes: INSTRUCTIONS + '\n\n\n' })), {
    presence: 'present',
    detail: null,
  })
  // The blank lines may sit on the file's side instead.
  assert.deepEqual(
    evaluateCheck(SECTION_CHECK, over(AGENTS + '\n\n', [], { kind: 'read', bytes: INSTRUCTIONS })),
    { presence: 'present', detail: null },
  )
})

test('a section check is absent when the Section drifted from the Payload', () => {
  const drifted = AGENTS.replace('Be terse.', 'Be verbose.')
  const answer = evaluateCheck(SECTION_CHECK, over(drifted, [], { kind: 'read', bytes: INSTRUCTIONS }))
  assert.equal(answer.presence, 'absent')
  assert.match(answer.detail ?? '', /AGENTS\.md's ## Output style Section is not the declared text/)
})

test('a section check is absent when the file has no such Section', () => {
  const answer = evaluateCheck(
    SECTION_CHECK,
    over('# AGENTS.md\n\nNothing to style.\n', [], { kind: 'read', bytes: INSTRUCTIONS }),
  )
  assert.equal(answer.presence, 'absent')
  assert.match(answer.detail ?? '', /AGENTS\.md has no ## Output style Section/)
})

test('a section check is absent when the native file is missing', () => {
  assert.deepEqual(evaluateCheck(SECTION_CHECK, over(null, [], { kind: 'read', bytes: INSTRUCTIONS })), {
    presence: 'absent',
    detail: '/home/ann/.pi/agent/AGENTS.md is not there',
  })
})

// The fence the native files actually use: a `## ` line inside a three-backtick block is body text,
// so it neither starts a Section, ends one, nor shares a heading with one.
test('a fenced `## ` line neither starts nor ends a Section', () => {
  const payload = '## Output style\n\nBe terse.\n\n```\n## Not a heading\n```\n'
  const fenced = `${payload}\n## After the fence\n\nMore.\n`
  assert.deepEqual(evaluateCheck(SECTION_CHECK, over(fenced, [], { kind: 'read', bytes: payload })), {
    presence: 'present',
    detail: null,
  })
  // The heading fenced before the real Section is not a second Section sharing it.
  const fencedHeading = '```\n## Output style\n```\n\n' + AGENTS
  assert.equal(evaluateCheck(SECTION_CHECK, over(fencedHeading, [], { kind: 'read', bytes: INSTRUCTIONS })).presence, 'present')
})

test('a Payload with no `## ` heading answers unknown, with the Payload named', () => {
  const answer = evaluateCheck(SECTION_CHECK, over(AGENTS, [], { kind: 'read', bytes: 'no heading here\n' }))
  assert.equal(answer.presence, 'unknown')
  assert.match(answer.detail ?? '', /output-style\.md has no '## ' heading/)
})

test('two Sections sharing the Payload\u2019s heading answer unknown', () => {
  const twice = '## Output style\n\none\n\n## Output style\n\ntwo\n'
  const answer = evaluateCheck(SECTION_CHECK, over(twice, [], { kind: 'read', bytes: INSTRUCTIONS }))
  assert.equal(answer.presence, 'unknown')
  assert.match(answer.detail ?? '', /AGENTS\.md has two Sections headed ## Output style/)
})

test('a Payload that cannot be read answers unknown, with the Payload named', () => {
  const directory = mkdtempSync(join(tmpdir(), 'acm-section-payload-'))
  const native = join(directory, 'AGENTS.md')
  writeFileSync(native, '# AGENTS.md\n')
  const missing = join(directory, 'style.md')
  const answer = evaluateCheck({ file: native, section: missing }, checkInputsOf({ file: native, section: missing }))
  assert.equal(answer.presence, 'unknown')
  assert.match(answer.detail ?? '', /style\.md could not be read: it is not there/)
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
    { file: directory, section: ADDRESS },
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
    detail: `${missing} is not there`,
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
  assert.deepEqual(evaluateCheck({ onPath: 'notes' }, over(null, [directory])), {
    presence: 'absent',
    detail: 'notes is not on PATH',
  })
  assert.deepEqual(evaluateCheck({ onPath: 'nothing-here' }, over(null, [directory])), {
    presence: 'absent',
    detail: 'nothing-here is not on PATH',
  })
  assert.deepEqual(evaluateCheck({ onPath: 'serena' }, over(null, [])), {
    presence: 'absent',
    detail: 'serena is not on PATH',
  })
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

// The fold is the entry's answer: `absent` over `unknown` over `present`, and the detail names
// every Check that did not answer `present` with its own reason. The answers come from the same
// evaluator and the same fixture bytes as every other test in this file.
test('the fold answers absent when any Check is absent, and names the Check that failed', () => {
  const answers = [
    evaluateCheck({ file: '/home/ann/.pi/mcp.json', contains: 'serena' }, over('serena\n')),
    evaluateCheck({ file: '/home/ann/.zshrc' }, over(null)),
  ]
  assert.deepEqual(foldAnswers(answers), {
    presence: 'absent',
    detail: '/home/ann/.zshrc is not there',
  })
})

test('absent beats unknown: the fold answers absent and names both Checks', () => {
  const answers = [
    evaluateCheck({ file: '/home/ann/.zshrc' }, over(null)),
    evaluateCheck({ onPath: 'serena' }, over(null, ['/home/ann/empty-bin'])),
  ]
  const answer = foldAnswers(answers)
  assert.equal(answer.presence, 'absent')
  assert.match(answer.detail ?? '', /\/home\/ann\/\.zshrc is not there/)
  assert.match(answer.detail ?? '', /PATH could not be searched: \/home\/ann\/empty-bin/)
})

test('the fold answers unknown when a Check is unknown and none is absent, with that Check named', () => {
  const directory = pathWith([{ name: 'plain-file', mode: 0o755 }])
  const answers = [
    evaluateCheck({ file: '/home/ann/.pi/mcp.json', contains: 'serena' }, over('serena\n')),
    evaluateCheck({ onPath: 'serena' }, over(null, [join(directory, 'plain-file')])),
  ]
  assert.deepEqual(foldAnswers(answers), {
    presence: 'unknown',
    detail: `PATH could not be searched: ${join(directory, 'plain-file')} is not a directory`,
  })
})

test('the fold answers present only when every Check is present', () => {
  const answers = [
    evaluateCheck({ file: '/home/ann/.pi/mcp.json', contains: 'serena' }, over('serena\n')),
    evaluateCheck({ file: '/home/ann/.codex/config.toml', pointer: 'mcp_servers.serena' }, over('[mcp_servers.serena]\n')),
  ]
  assert.deepEqual(foldAnswers(answers), { presence: 'present', detail: null })
})
