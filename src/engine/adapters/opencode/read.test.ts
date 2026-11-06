import test from 'node:test'
import assert from 'node:assert'
import { readOpenCodeMcpJsonc } from './read.ts'
import { knownFieldsForStorage } from '../mcp-facts.ts'
import type { McpFacts } from '../mcp-facts.ts'

function factsOf(text: string, name: string): McpFacts {
  const read = readOpenCodeMcpJsonc(text)
  if (read.kind !== 'ok') throw new Error(`expected readable JSONC: ${read.detail}`)
  const entry = read.entries.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`${name} was not read`)
  return entry.facts
}

test('JSONC comments and trailing commas are read, not rejected', () => {
  const text = `{
    // the local server
    "mcp": {
      "servers": {
        "local": {
          /* one command array is split into command plus args */
          "type": "local",
          "command": ["npx", "-y", "@example/server"],
          "environment": { "API_HOST": "{env:API_HOST}" },
        },
      },
    },
  }`
  const facts = factsOf(text, 'local')
  assert.equal(facts.transport, 'stdio')
  assert.equal(facts.command, 'npx')
  assert.deepEqual(facts.args, ['-y', '@example/server'])
  assert.deepEqual(facts.env, { API_HOST: '{env:API_HOST}' })
})

test('V2 disabled is inverted into the canonical enabled, and a silent document stays unknown', () => {
  assert.equal(factsOf('{"mcp":{"servers":{"a":{"command":["x"],"disabled":true}}}}', 'a').enabled, false)
  assert.equal(factsOf('{"mcp":{"servers":{"a":{"command":["x"]}}}}', 'a').enabled, undefined)
})

test('server timeouts are milliseconds in the file and seconds in the facts', () => {
  const facts = factsOf(
    '{"mcp":{"servers":{"a":{"command":["x"],"timeout":{"startup":30000,"execution":60000}}}}}',
    'a',
  )
  assert.equal(facts.timeoutStartup, 30)
  assert.equal(facts.timeoutRequest, 60)
})

test('a remote server carries its url and headers, and an OAuth secret is not a fact', () => {
  const facts = factsOf(
    JSON.stringify({
      mcp: {
        servers: {
          remote: {
            type: 'remote',
            url: 'https://user:pass@example.test/mcp',
            headers: { Authorization: 'Bearer sk-fixturetoken' },
            oauth: { client_id: 'fixture', client_secret: 'sk-fixtureclientsecret' },
          },
        },
      },
    }),
    'remote',
  )
  assert.equal(facts.transport, 'http')
  assert.deepEqual(facts.headers, { Authorization: 'Bearer sk-fixturetoken' })
  assert.equal(JSON.stringify(facts).includes('fixtureclientsecret'), false)

  const stored = JSON.stringify(knownFieldsForStorage(facts))
  assert.equal(stored.includes('sk-fixturetoken'), false)
  assert.equal(stored.includes('user:pass'), false)
})

test('the legacy flat V1 shape is read next to V2 servers, and a global timeout is not a server', () => {
  const text = `{
    "mcp": {
      "timeout": { "startup": 30000, "catalog": 30000 },
      "legacy": { "type": "local", "command": ["x"], "enabled": true, "timeout": 30000 },
      "servers": { "modern": { "type": "local", "command": ["y"] } },
    },
  }`
  assert.equal(factsOf(text, 'legacy').enabled, true)
  assert.equal(factsOf(text, 'legacy').timeoutStartup, 30)
  assert.equal(factsOf(text, 'modern').command, 'y')
  const read = readOpenCodeMcpJsonc(text)
  assert.deepEqual(read.kind === 'ok' ? read.entries.map((entry) => entry.name) : [], [
    'modern',
    'legacy',
  ])
})

test('a non-server key under mcp neither invents a server nor makes the tier unreadable', () => {
  const read = readOpenCodeMcpJsonc(
    '{"mcp":{"timeout":30000,"servers":{"a":{"type":"local","command":["x"]}}}}',
  )
  assert.equal(read.kind, 'ok')
  assert.deepEqual(read.kind === 'ok' ? read.entries.map((entry) => entry.name) : [], ['a'])
  // A real server of the wrong shape still fails the whole tier.
  assert.equal(
    readOpenCodeMcpJsonc('{"mcp":{"a":{"type":"local","command":"not-an-array"}}}').kind,
    'invalid',
  )
})

test('a comma followed by a comment and a closing bracket is a trailing comma', () => {
  const text = `{
    "mcp": {
      "servers": {
        "a": { "type": "local", "command": ["x"], }, // https://example.test is not a comment
      }, /* and neither is this /* */
    },
  }`
  assert.deepEqual(
    readOpenCodeMcpJsonc(text).kind === 'ok' ? readOpenCodeMcpJsonc(text) : null,
    { kind: 'ok', entries: [{ name: 'a', pointerPrefix: 'mcp.servers', facts: factsOf(text, 'a') }] },
  )
})

test('an unterminated block comment is invalid, not a document that lost its tail', () => {
  assert.equal(readOpenCodeMcpJsonc('{ "mcp": {} } /* oops').kind, 'invalid')
})

test('a remote server with no url is invalid, and a malformed legacy value is too', () => {
  assert.equal(readOpenCodeMcpJsonc('{"mcp":{"servers":{"a":{"type":"remote"}}}}').kind, 'invalid')
  assert.equal(readOpenCodeMcpJsonc('{"mcp":{"legacy":null}}').kind, 'invalid')
  // A reserved global key stays exempt.
  assert.equal(readOpenCodeMcpJsonc('{"mcp":{"timeout":30000}}').kind, 'ok')
})

test('JSONC that does not parse, or an entry of the wrong shape, is invalid rather than empty', () => {
  assert.equal(readOpenCodeMcpJsonc('{ "mcp": { ').kind, 'invalid')
  assert.equal(readOpenCodeMcpJsonc('{"mcp":{"servers":{"a":{"command":"not-an-array"}}}}').kind, 'invalid')
  assert.deepEqual(readOpenCodeMcpJsonc('{ /* nothing */ }'), { kind: 'ok', entries: [] })
})
