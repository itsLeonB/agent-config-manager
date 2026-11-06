import test from 'node:test'
import assert from 'node:assert'
import { parse as parseToml } from 'smol-toml'
import { stripJsonc } from './adapters/opencode/read.ts'
import { parses, writePointer } from './edit.ts'

function json(text: string, pointer: string, value: string | number): string {
  const result = writePointer(text, 'json', pointer.split('.'), value)
  assert.equal(result.kind, 'ok', result.kind === 'failed' ? result.reason : '')
  return result.kind === 'ok' ? result.text : ''
}

function toml(text: string, pointer: string, value: string | number): string {
  const result = writePointer(text, 'toml', pointer.split('.'), value)
  assert.equal(result.kind, 'ok', result.kind === 'failed' ? result.reason : '')
  return result.kind === 'ok' ? result.text : ''
}

test('a JSON pointer write replaces the value and leaves the rest of the document alone', () => {
  const before = `{
  // keep me
  "a": { "b": 1, "untouched": [1, 2] },
  "c": "last"
}
`
  const after = json(before, 'a.b', 2)
  assert.match(after, /\/\/ keep me/)
  assert.deepEqual(JSON.parse(stripJsonc(after)), {
    a: { b: 2, untouched: [1, 2] },
    c: 'last',
  })
})

test('a JSON address that does not exist is created whole, indented like its siblings', () => {
  const after = json('{\n  "a": 1\n}\n', 'servers.name.command', 'run')
  assert.deepEqual(JSON.parse(after), { a: 1, servers: { name: { command: 'run' } } })
  assert.match(after, /\n {2}"servers": \{\n {4}"name"/)
  assert.equal(parses(after, 'json'), true)
})

test('a TOML pointer write into an existing table keeps the line it rewrites readable', () => {
  const before = `[mcp_servers.serena]
command = "old" # this comment is a human's
args = ["x"]
`
  const after = toml(before, 'mcp_servers.serena.command', 'new')
  assert.equal(after, `[mcp_servers.serena]
command = "new" # this comment is a human's
args = ["x"]
`)
})

test('a TOML table that does not exist is appended once and then extended in place', () => {
  const first = toml('# top\nmodel = "gpt-5"\n', 'mcp_servers.serena.env.API', 'one')
  const second = toml(first, 'mcp_servers.serena.env.TOKEN', 'two')
  assert.deepEqual(parseToml(second), {
    model: 'gpt-5',
    mcp_servers: { serena: { env: { API: 'one', TOKEN: 'two' } } },
  })
  assert.equal(second.match(/\[mcp_servers\.serena\.env\]/g)?.length, 1)
})

test('an address this writer cannot reach fails instead of writing something else', () => {
  const inline = writePointer('env = { A = "1" }\n', 'toml', ['env', 'B'], '2')
  assert.equal(inline.kind, 'failed')
  assert.match(inline.kind === 'failed' ? inline.reason : '', /inline table/)
  const missing = writePointer('{\n}\n', 'json', ['a', 'b'], 'x')
  assert.equal(missing.kind, 'ok')
})
