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
      entries: [
        {
          harness: 'codex',
          check: { file: '~/.codex/config.toml', contains: '^\\[mcp_servers.serena\\]' },
          install: 'python3 scripts/merge-codex-mcp.py serena',
        },
        { harness: 'pi', check: { file: '~/.pi/agent/mcp.json' }, install: 'pi plugin install serena' },
      ],
    },
  ])
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

test('an unknown harness id refuses the file at the table that names it', () => {
  assert.deepEqual(refusalOf('version = 1\n\n[provision.serena.gpt]\ncheck = { file = "y" }\ninstall = "x"\n'), {
    line: 3,
    column: 1,
    reason: "unknown harness 'gpt'",
  })
})

test('a missing install command refuses the file at the entry table', () => {
  assert.deepEqual(refusalOf('version = 1\n\n[provision.serena.codex]\ncheck = { file = "~/.codex/config.toml" }\n'), {
    line: 3,
    column: 1,
    reason: 'missing install',
  })
})

// The predicate set is closed: 07 widens it, and until then a `pointer` check is a typo rather than
// a predicate the parser silently ignores.
test('an unknown predicate refuses the file at that predicate', () => {
  assert.deepEqual(
    refusalOf(
      'version = 1\n\n[provision.serena.codex]\ncheck = { file = "~/.codex/config.toml", pointer = "mcp_servers.serena" }\ninstall = "x"\n',
    ),
    { line: 4, column: 42, reason: "unknown predicate 'pointer'" },
  )
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
