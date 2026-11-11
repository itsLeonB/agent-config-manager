import test from 'node:test'
import assert from 'node:assert'
import { parseEnvironmentFile } from './parse.ts'
import type { ProvisionDeclaration } from './types.ts'

// Seam B: the parser is a pure function of the file's text, so every refusal is asserted as a place
// in that text. The TOML below is hand-written and small on purpose: the position of the fault is
// the assertion, and a larger fixture would hide which line moved.

function refusalOf(text: string) {
  const result = parseEnvironmentFile(text)
  if (result.ok) assert.fail('the file loaded instead of being refused')
  return result.refusal
}

function provisionsOf(text: string): ProvisionDeclaration[] {
  const result = parseEnvironmentFile(text)
  if (!result.ok) assert.fail(`refused at ${result.refusal.line}:${result.refusal.column} ${result.refusal.reason}`)
  return result.provisions
}

const SERENA = `version = 1

[provision.serena]
tags = ["mcp"]

[provision.serena.codex]
check   = { file = "~/.codex/config.toml", contains = "^\\\\[mcp_servers.serena\\\\]" }
install = "python3 scripts/merge-codex-mcp.py serena"

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json" }
install = "pi plugin install serena"
`

test('a version and its Provision tables load, with tags and one entry per harness', () => {
  assert.deepEqual(provisionsOf(SERENA), [
    {
      name: 'serena',
      tags: ['mcp'],
      checks: [],
      install: null,
      entries: [
        {
          harness: 'codex',
          checks: [{ file: '~/.codex/config.toml', contains: '^\\[mcp_servers.serena\\]' }],
          install: 'python3 scripts/merge-codex-mcp.py serena',
        },
        { harness: 'pi', checks: [{ file: '~/.pi/agent/mcp.json' }], install: 'pi plugin install serena' },
      ],
    },
  ])
})

// `check = { … }` is the one-element spelling of `checks`, so a file written before this slice and
// one written with the list load as the same declaration.
test('a check key and a checks key with one element load the same entry', () => {
  const single = provisionsOf(`version = 1

[provision.serena.codex]
check   = { file = "~/.codex/config.toml", contains = "serena" }
install = "true"
`)
  const list = provisionsOf(`version = 1

[provision.serena.codex]
checks  = [{ file = "~/.codex/config.toml", contains = "serena" }]
install = "true"
`)
  assert.deepEqual(single, list)
})

// One entry, several Checks, each with its own predicate rules: a pointer with the value it must
// hold beside a name on PATH is one row's two questions.
test('checks loads several predicates, each its own table', () => {
  const [provision] = provisionsOf(`version = 1

[provision.serena.pi]
checks  = [
  { file = "~/.pi/agent/mcp.json", pointer = "mcpServers.serena", equals = { command = "uvx" } },
  { onPath = "serena" },
]
install = "true"
`)
  assert.deepEqual(provision.entries[0].checks, [
    { file: '~/.pi/agent/mcp.json', pointer: 'mcpServers.serena', equals: { command: 'uvx' } },
    { onPath: 'serena' },
  ])
})

// A Provision's own table carries the Checks and Install command every harness entry inherits:
// an entry may then be an empty table, which means the harness takes the shared declaration whole
// and exists so the Provision's rows show that harness.
test('shared checks and install load on the Provision, and an empty entry takes them whole', () => {
  const [provision] = provisionsOf(`version = 1

[provision.serena]
checks  = [{ file = "~/.local/bin/serena" }]
install = "uv tool install serena-agent"

[provision.serena.pi]

[provision.serena.opencode]
checks  = [{ file = "~/.config/opencode/opencode.json" }]
install = "opencode mcp add serena"
`)
  assert.deepEqual(provision.checks, [{ file: '~/.local/bin/serena' }])
  assert.equal(provision.install, 'uv tool install serena-agent')
  assert.deepEqual(provision.entries, [
    { harness: 'pi', checks: [], install: null },
    {
      harness: 'opencode',
      checks: [{ file: '~/.config/opencode/opencode.json' }],
      install: 'opencode mcp add serena',
    },
  ])
})

// `check = { … }` is the one-element spelling everywhere Checks are written, the Provision's own
// table included.
test('a shared check key loads as the one-element list', () => {
  const [provision] = provisionsOf(`version = 1

[provision.serena]
check   = { file = "~/.local/bin/serena" }
install = "true"

[provision.serena.pi]
`)
  assert.deepEqual(provision.checks, [{ file: '~/.local/bin/serena' }])
})

test('a shared check beside shared checks refuses the file at the checks key', () => {
  assert.deepEqual(
    refusalOf(
      'version = 1\n\n[provision.serena]\ncheck = { file = "y" }\nchecks = [{ file = "z" }]\ninstall = "x"\n\n[provision.serena.pi]\n',
    ),
    { line: 5, column: 1, reason: 'a provision holds check or checks, not both' },
  )
})

test('an empty shared checks list refuses the file at the key', () => {
  assert.deepEqual(
    refusalOf('version = 1\n\n[provision.serena]\nchecks = []\ninstall = "x"\n\n[provision.serena.pi]\n'),
    { line: 4, column: 1, reason: 'checks is empty' },
  )
})

// The file is refused when an entry would end up with no effective Check or no effective Install
// command once the shared declarations are applied — so a Provision with no shared install still
// needs one on every entry.
test('an entry with no effective Check refuses the file at its table', () => {
  assert.deepEqual(
    refusalOf('version = 1\n\n[provision.serena]\ninstall = "x"\n\n[provision.serena.pi]\n'),
    { line: 6, column: 1, reason: 'missing check' },
  )
  // Shared Checks cover every entry, so an empty entry is legal when they exist.
  const [provision] = provisionsOf(`version = 1

[provision.serena]
checks  = [{ file = "y" }]
install = "x"

[provision.serena.pi]
`)
  assert.equal(provision.entries.length, 1)
})

test('an entry with no effective Install command refuses the file at its table', () => {
  assert.deepEqual(
    refusalOf('version = 1\n\n[provision.serena.pi]\ncheck = { file = "y" }\n'),
    { line: 3, column: 1, reason: 'missing install' },
  )
  // A shared Install command is the effective one for an entry that declares none of its own.
  const [provision] = provisionsOf(`version = 1

[provision.serena]\ninstall = "x"\n\n[provision.serena.pi]\ncheck = { file = "y" }\n`)
  assert.equal(provision.entries[0].install, null)
})

// An entry spelled as an inline key rather than a table header refuses at that key, not at the
// top of the file.
test('an inline entry with no effective Install refuses at its key', () => {
  assert.deepEqual(refusalOf('version = 1\n\n[provision.serena]\npi = {}\n'), {
    line: 4,
    column: 1,
    reason: 'missing install',
  })
})

test('an empty checks list refuses the file at the key', () => {
  assert.deepEqual(refusalOf('version = 1\n\n[provision.serena.codex]\nchecks = []\ninstall = "x"\n'), {
    line: 4,
    column: 1,
    reason: 'checks is empty',
  })
})

test('a check beside checks refuses the file at the checks key', () => {
  assert.deepEqual(
    refusalOf(
      'version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\nchecks = [{ file = "z" }]\ninstall = "x"\n',
    ),
    { line: 5, column: 1, reason: 'an entry holds check or checks, not both' },
  )
})

// A Provision with no entry for a harness is legal: nothing is invented for the harnesses it skips.
test('a Provision declares only the harnesses it has entries for', () => {
  const [provision] = provisionsOf(`version = 1

[provision.opencode-no-claude.opencode]
check   = { file = "~/.zshrc", contains = "OPENCODE_DISABLE_CLAUDE_CODE" }
install = "./scripts/zshrc-export.sh OPENCODE_DISABLE_CLAUDE_CODE=1"
`)
  assert.deepEqual(
    provision.entries.map((entry) => entry.harness),
    ['opencode'],
  )
})

// The sixth predicate and the third Install shape: a Section named by a Payload, which is one text
// one Check compares and one Install rewrites.
test('a section check and a section install load as the pair they spell', () => {
  const declarations = provisionsOf(`version = 1

[provision.i-have-adhd.pi]
check   = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }
install = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }
`)
  assert.deepEqual(declarations[0].entries[0].checks, [
    { file: '~/.pi/agent/AGENTS.md', section: 'instructions/output-style.md' },
  ])
  assert.deepEqual(declarations[0].entries[0].install, {
    file: '~/.pi/agent/AGENTS.md',
    section: 'instructions/output-style.md',
  })
})

// `section` is a predicate of its own, so beside another it is two Checks spelled as one, the way
// `contains` beside `pointer` is.
test('a section check beside another predicate refuses the file at the other key', () => {
  const besidePointer = refusalOf(
    'version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "x", section = "s", pointer = "y" }\ninstall = "x"\n',
  )
  assert.equal(besidePointer.line, 4)
  assert.equal(besidePointer.reason, 'a check holds section or pointer, not both')

  const besideContains = refusalOf(
    'version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "x", section = "s", contains = "y" }\ninstall = "x"\n',
  )
  assert.equal(besideContains.reason, 'a check holds section or contains, not both')

  const besideEquals = refusalOf(
    'version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "x", section = "s", equals = true }\ninstall = "x"\n',
  )
  assert.equal(besideEquals.reason, 'a check holds section or equals, not both')

  const besideOnPath = refusalOf(
    'version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { onPath = "x", section = "s" }\ninstall = "x"\n',
  )
  assert.equal(besideOnPath.reason, "onPath takes no other key, and 'section' is one")
})

test('a section that is not a string or is empty refuses the file at it', () => {
  assert.equal(
    refusalOf('version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "x", section = 1 }\ninstall = "x"\n').reason,
    'section must be a string',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "x", section = "" }\ninstall = "x"\n').reason,
    'section is empty',
  )
})

// The Section shape is `{ file, section }`, nothing beside it: a Payload beside it contradicts, and
// either half without the other names nothing to write.
test('a malformed section install refuses the file at the offending key', () => {
  assert.equal(
    refusalOf('version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "y" }\ninstall = { section = "s" }\n').reason,
    'section needs a file',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "y" }\ninstall = { file = "x" }\n').reason,
    'install has no section',
  )
  assert.equal(
    refusalOf(
      'version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "y" }\ninstall = { file = "x", section = "s", payload = "p" }\n',
    ).reason,
    'a section install holds file and section, not payload',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "y" }\ninstall = { file = "", section = "s" }\n').reason,
    'file is empty',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.i-have-adhd.pi]\ncheck = { file = "y" }\ninstall = { file = "x", section = 1 }\n').reason,
    'section must be a string',
  )
})

test('an unknown version refuses the file where the version is written', () => {
  assert.deepEqual(refusalOf('version = 2\n'), { line: 1, column: 1, reason: 'version 2 is not supported' })
})

test('a missing version refuses the file at its start', () => {
  assert.deepEqual(refusalOf('[provision.serena.codex]\ninstall = "x"\ncheck = { file = "y" }\n'), {
    line: 1,
    column: 1,
    reason: 'version is missing',
  })
})

test('an unknown key refuses the file at that key', () => {
  assert.deepEqual(refusalOf('version = 1\nprovison = 2\n'), { line: 2, column: 1, reason: "unknown key 'provison'" })
  assert.deepEqual(refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\ninstall = "x"\nscope = "user"\n'), {
    line: 6,
    column: 1,
    reason: "unknown key 'scope'",
  })
})

test('an unknown harness name loads without refusal', () => {
  const declarations = provisionsOf('version = 1\n\n[provision.serena.gpt]\ncheck = { file = "y" }\ninstall = "x"\n')
  assert.equal(declarations[0].entries[0].harness, 'gpt')
})

// The harness list is the file's own constraint: when it declares one, an entry naming anything
// outside it is a fault in the file, refused at the entry's key rather than at load.
test('an entry outside the declared harnesses list refuses the file at its key', () => {
  assert.deepEqual(
    refusalOf(
      'version = 1\n\nharnesses = ["pi", "codex"]\n\n[provision.serena.gpt]\ncheck = { file = "y" }\ninstall = "x"\n',
    ),
    { line: 5, column: 1, reason: "harness 'gpt' is not one of this file's harnesses: pi, codex" },
  )
})

test('every spelling of an entry is checked against the list, inline keys included', () => {
  // An inline entry table is the same declaration as a header; the refusal names its key.
  assert.deepEqual(
    refusalOf(
      'version = 1\n\nharnesses = ["pi"]\n\n[provision.serena]\ninstall = "x"\ncodex = { check = { file = "y" } }\n',
    ),
    { line: 7, column: 1, reason: "harness 'codex' is not one of this file's harnesses: pi" },
  )
})

test('a file with no harnesses list accepts any non-empty, NUL-free harness name', () => {
  // No list is no constraint: the free-form label rule is unchanged for the files that spell none.
  const declarations = provisionsOf('version = 1\n\n[provision.serena.gpt]\ncheck = { file = "y" }\ninstall = "x"\n')
  assert.equal(declarations[0].entries[0].harness, 'gpt')
  // An empty list declares nothing either, so it constrains nothing.
  const listed = provisionsOf('version = 1\n\nharnesses = []\n\n[provision.serena.gpt]\ncheck = { file = "y" }\ninstall = "x"\n')
  assert.equal(listed[0].entries[0].harness, 'gpt')
})

test('a harness name that is empty or holds a NUL refuses before the list is consulted', () => {
  const empty = refusalOf('version = 1\n\nharnesses = ["pi"]\n\n[provision.serena]\ninstall = "x"\n"" = { check = { file = "y" } }\n')
  assert.equal(empty.reason, "harness '' must be non-empty and NUL-free")
})

test('the harnesses list loads as the file declares it', () => {
  const result = parseEnvironmentFile('version = 1\n\nharnesses = ["pi", "custom-agent"]\n')
  assert.ok(result.ok)
  assert.deepEqual(result.harnesses, ['pi', 'custom-agent'])
  // A file with no list declares no harnesses, not the default three.
  const none = parseEnvironmentFile('version = 1\n')
  assert.ok(none.ok)
  assert.deepEqual(none.harnesses, [])
})

test('a missing install command refuses the file at the entry table', () => {
  assert.deepEqual(refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "~/.codex/config.toml" }\n'), {
    line: 3,
    column: 1,
    reason: 'missing install',
  })
})

// The predicate set is closed: a fifth kind of Check is a schema change, so any other key is a typo
// rather than a predicate the parser silently ignores.
test('an unknown predicate refuses the file at that predicate', () => {
  assert.deepEqual(
    refusalOf(
      'version = 1\n\n[provision.serena.codex]\ncheck = { file = "~/.codex/config.toml", conatins = "x" }\ninstall = "x"\n',
    ),
    { line: 4, column: 42, reason: "unknown predicate 'conatins'" },
  )
})

// The other four predicates: an address inside a file, an address with the value it must hold, a
// value among the elements of an array at one, and a name on PATH. `equals` and `includes` are any
// TOML value, so a table with a list in it is spelled as one.
test('pointer, equals, includes, and onPath load as the Checks they spell', () => {
  const declarations = provisionsOf(`version = 1

[provision.serena.codex]
check   = { file = "~/.codex/config.toml", pointer = "mcp_servers.serena", equals = { command = "uvx", args = ["--from", "serena"] } }
install = "true"

[provision.serena.pi]
check   = { file = "~/.pi/mcp.json", pointer = "mcpServers.serena" }
install = "true"

[provision.i-have-adhd.opencode]
check   = { file = "~/.config/opencode/opencode.json", pointer = "plugins", includes = "i-have-adhd" }
install = "true"

[provision.rtk.pi]
check   = { onPath = "rtk" }
install = "true"
`)
  assert.deepEqual(
    declarations.map((provision) => provision.entries.flatMap((entry) => entry.checks)),
    [
      [
        {
          file: '~/.codex/config.toml',
          pointer: 'mcp_servers.serena',
          equals: { command: 'uvx', args: ['--from', 'serena'] },
        },
        { file: '~/.pi/mcp.json', pointer: 'mcpServers.serena' },
      ],
      [{ file: '~/.config/opencode/opencode.json', pointer: 'plugins', includes: 'i-have-adhd' }],
      [{ onPath: 'rtk' }],
    ],
  )
})

// A Check is one of the five, never two written to look like one: `equals` without an address has
// nothing to compare, `includes` is the same, and neither sits beside the other or beside `contains`,
// because each answers a different question and one Check has one answer.
test('a predicate that contradicts itself refuses the file at the offending key', () => {
  const withoutPointer = refusalOf(
    'version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", equals = true }\ninstall = "x"\n',
  )
  assert.equal(withoutPointer.line, 4)
  assert.equal(withoutPointer.reason, 'equals needs a pointer')

  const includesWithoutPointer = refusalOf(
    'version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", includes = "y" }\ninstall = "x"\n',
  )
  assert.deepEqual(includesWithoutPointer, { line: 4, column: 23, reason: 'includes needs a pointer' })

  const equalsAndIncludes = refusalOf(
    'version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", pointer = "p", equals = true, includes = "y" }\ninstall = "x"\n',
  )
  assert.equal(equalsAndIncludes.line, 4)
  assert.equal(equalsAndIncludes.reason, 'a check holds equals or includes, not both')

  const containsAndIncludes = refusalOf(
    'version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", contains = "y", includes = "z" }\ninstall = "x"\n',
  )
  assert.equal(containsAndIncludes.line, 4)
  assert.equal(containsAndIncludes.reason, 'a check holds contains or includes, not both')

  const both = refusalOf(
    'version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", contains = "y", pointer = "z" }\ninstall = "x"\n',
  )
  assert.equal(both.line, 4)
  assert.equal(both.reason, 'a check holds contains or pointer, not both')

  const onPathAndFile = refusalOf(
    'version = 1\n\n[provision.rtk.pi]\ncheck = { onPath = "rtk", file = "x" }\ninstall = "x"\n',
  )
  assert.equal(onPathAndFile.line, 4)
  assert.equal(onPathAndFile.reason, "onPath takes no other key, and 'file' is one")
})

test('a pointer that cannot be spelled refuses the file at the pointer key', () => {
  assert.deepEqual(
    refusalOf(
      'version = 1\n\n[provision.serena.codex]\ncheck   = { file = "~/.codex/config.toml", pointer = "mcp_servers.\\"my.server" }\ninstall = "x"\n',
    ),
    { line: 4, column: 44, reason: 'pointer cannot be spelled: an unterminated quote' },
  )
  // A stray character after a closed quote and an empty segment refuse the same way, and a pointer
  // that is spelled with quotes still loads when it can be split.
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", pointer = "a.\\"b\\"c" }\ninstall = "x"\n').reason,
    'pointer cannot be spelled: a dot or the end was expected after a segment',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", pointer = "a..b" }\ninstall = "x"\n').reason,
    'pointer cannot be spelled: a pointer segment is empty',
  )
  const quoted = provisionsOf(
    'version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", pointer = "mcp_servers.\\"my.server\\"" }\ninstall = "x"\n',
  )
  assert.deepEqual(quoted[0].entries[0].checks, [{ file: 'x', pointer: 'mcp_servers."my.server"' }])
})

test('a pointer that is not a string or is empty refuses the file at it', () => {
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", pointer = 1 }\ninstall = "x"\n').reason,
    'pointer must be a string',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "x", pointer = "" }\ninstall = "x"\n').reason,
    'pointer is empty',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.rtk.pi]\ncheck = { onPath = "" }\ninstall = "x"\n').reason,
    'onPath is empty',
  )
})

// The rules that are per Check stay per Check, wherever the Check is spelled: a predicate that
// contradicts itself refuses the file even as one member of a checks list.
test('per-check rules refuse a checks member at its offending key', () => {
  const both = refusalOf(
    'version = 1\n\n[provision.serena.codex]\nchecks = [{ file = "x", contains = "y", pointer = "z" }]\ninstall = "x"\n',
  )
  assert.equal(both.line, 4)
  assert.equal(both.reason, 'a check holds contains or pointer, not both')

  const withoutPointer = refusalOf(
    'version = 1\n\n[provision.serena.codex]\nchecks = [{ file = "x", equals = true }]\ninstall = "x"\n',
  )
  assert.equal(withoutPointer.line, 4)
  assert.equal(withoutPointer.reason, 'equals needs a pointer')
})

test('an empty contains refuses the file at the pattern', () => {
  assert.deepEqual(
    refusalOf(
      'version = 1\n\n[provision.opencode-no-claude.opencode]\ncheck = { file = "~/.zshrc", contains = "" }\ninstall = "x"\n',
    ),
    { line: 4, column: 30, reason: 'contains is empty' },
  )
})

// TOML's own complaints keep the parser's position: a reader who typed a broken document is told
// which line to fix, not that the file is unusable.
test('a file that is not TOML refuses at the parser\u2019s own line and column', () => {
  const refusal = refusalOf('version = 1\n[provision.serena\n')
  assert.equal(refusal.line, 2)
  assert.equal(refusal.column, 18)
  assert.match(refusal.reason, /^Invalid TOML document/)
})

// Every value an environment file may hold is a string, number, boolean, array, or table. TOML's own
// dates and big integers are outside that, and a file holding one is refused rather than half-read.
test('a value outside the schema refuses the file', () => {
  assert.deepEqual(refusalOf('version = 1\nwhen = 2024-01-01\n'), {
    line: 1,
    column: 1,
    reason: 'only strings, numbers, booleans, arrays, and tables are read',
  })
})

// `install` is a string or a Payload: the path the declared text lives in, and optionally the
// arguments that reach it as argv. Both forms are one Install command.
test('a payload install loads as its path and arguments, and a string install stays a string', () => {
  const declarations = provisionsOf(`version = 1

[provision.serena.codex]
check   = { file = "~/.codex/config.toml", contains = "serena" }
install = { payload = "install/codex-mcp.sh", args = ["serena", "--quiet"] }

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json" }
install = { payload = "~/install/serena.sh" }

[provision.rtk.pi]
check   = { onPath = "rtk" }
install = "npx rtk init"
`)
  assert.deepEqual(
    declarations.map((provision) => provision.entries.map((entry) => entry.install)),
    [
      [{ payload: 'install/codex-mcp.sh', args: ['serena', '--quiet'] }, { payload: '~/install/serena.sh' }],
      ['npx rtk init'],
    ],
  )
})

// Anything else in an install table is a typo rather than a shape the parser half-reads: an unknown
// key refuses the file, as does a Payload that is missing, not a string, or empty, and arguments
// that are not a list of strings.
test('a malformed payload install refuses the file at the offending key', () => {
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\ninstall = { payload = "x", wibble = 1 }\n')
      .reason,
    "unknown install key 'wibble'",
  )
  assert.deepEqual(refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\ninstall = { args = ["a"] }\n'), {
    line: 5,
    column: 1,
    reason: 'install has no payload',
  })
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\ninstall = { payload = 1 }\n').reason,
    'payload must be a string',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\ninstall = { payload = "" }\n').reason,
    'payload is empty',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\ninstall = { payload = "x", args = ["a", 1] }\n')
      .reason,
    'args must be an array of strings',
  )
  assert.equal(
    refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\ninstall = 3\n').reason,
    'install must be a string or a table',
  )
  // An empty command is a Provision that says nothing to do: a declaration the file does not mean.
  assert.deepEqual(refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "y" }\ninstall = ""\n'), {
    line: 5,
    column: 1,
    reason: 'install is empty',
  })
})
