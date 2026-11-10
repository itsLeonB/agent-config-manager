import test from 'node:test'
import assert from 'node:assert'
import { parse as parseToml } from 'smol-toml'
import { stripJsonc } from './adapters/opencode/read.ts'
import { parses, splitPointer, writePointer } from './edit.ts'
import type { NativeValue } from './native-value.ts'

function json(text: string, pointer: string, value: NativeValue): string {
  const result = writePointer(text, 'json', pointer.split('.'), value)
  assert.equal(result.kind, 'ok', result.kind === 'failed' ? result.reason : '')
  return result.kind === 'ok' ? result.text : ''
}

function toml(text: string, pointer: string, value: string | number): string {
  const result = writePointer(text, 'toml', pointer.split('.'), value)
  assert.equal(result.kind, 'ok', result.kind === 'failed' ? result.reason : '')
  return result.kind === 'ok' ? result.text : ''
}

test('splitPointer spells a quoted key and a numeric index, and refuses what it cannot split', () => {
  assert.deepEqual(splitPointer('mcp_servers."my.server"'), [
    { kind: 'key', name: 'mcp_servers' },
    { kind: 'key', name: 'my.server' },
  ])
  assert.deepEqual(splitPointer('plugins.0.name'), [
    { kind: 'key', name: 'plugins' },
    { kind: 'index', index: 0 },
    { kind: 'key', name: 'name' },
  ])
  assert.deepEqual(splitPointer('plugins."0"'), [
    { kind: 'key', name: 'plugins' },
    { kind: 'key', name: '0' },
  ])
  assert.throws(() => splitPointer(''), /a pointer has no segments/)
  assert.throws(() => splitPointer('a..b'), /a pointer segment is empty/)
  assert.throws(() => splitPointer('a."b'), /an unterminated quote/)
  assert.throws(() => splitPointer('a."b"c'), /a dot or the end was expected after a segment/)
  assert.throws(() => splitPointer('a.b!'), /a dot or the end was expected after a segment/)
})

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

test('a node of one kind is never replaced by another kind', () => {
  const before = `{ "a": { "b": 1 }, "c": [1, 2] }`
  // A table replaced by a table, and a list by a list: both are addresses the editor names itself.
  assert.deepEqual(JSON.parse(json(before, 'a', { b: 2, d: [3] })), { a: { b: 2, d: [3] }, c: [1, 2] })
  assert.deepEqual(JSON.parse(json(before, 'c', [3])), { a: { b: 1 }, c: [3] })
  // A table replaced by a scalar is the engine misreading the file, so it is refused.
  const refused = writePointer(before, 'json', ['a'], 'gone')
  assert.equal(refused.kind, 'failed')
  assert.match(refused.kind === 'failed' ? refused.reason : '', /holds a object/)
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
