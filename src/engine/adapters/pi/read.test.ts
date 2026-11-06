import test from 'node:test'
import assert from 'node:assert'
import { factsDigest, knownFieldsForStorage } from '../mcp-facts.ts'
import type { McpFacts } from '../mcp-facts.ts'
import { readPiMcpJson } from './read.ts'

function factsOf(text: string, name: string): McpFacts {
  const read = readPiMcpJson(text)
  if (read.kind !== 'ok') throw new Error(`expected a readable mcp.json: ${read.detail}`)
  const server = read.entries.find((candidate) => candidate.name === name)
  if (server === undefined) throw new Error(`${name} was not read`)
  return server.facts
}

test('transport is inferred from url first, then command, matching Pi', () => {
  assert.equal(factsOf('{"mcpServers":{"a":{"command":"x"}}}', 'a').transport, 'stdio')
  assert.equal(factsOf('{"mcpServers":{"a":{"url":"https://x.test"}}}', 'a').transport, 'http')
  assert.equal(
    factsOf('{"mcpServers":{"a":{"command":"x","url":"https://x.test"}}}', 'a').transport,
    'http',
  )
  assert.equal(factsOf('{"mcpServers":{"a":{"enabled":false}}}', 'a').transport, undefined)
})

test('a file that does not parse is invalid rather than empty', () => {
  assert.equal(readPiMcpJson('{ "mcpServers": ').kind, 'invalid')
  assert.equal(readPiMcpJson('{"mcpServers":{"a":{"args":"not-an-array"}}}').kind, 'invalid')
  assert.deepEqual(readPiMcpJson('{}'), { kind: 'ok', entries: [] })
})

test('credential-pointer values are withheld from what reaches the store', () => {
  const facts = factsOf(
    JSON.stringify({
      mcpServers: {
        a: {
          command: 'x',
          env: { GITHUB_TOKEN: 'ghp_realtokenvalue' },
          headers: { Authorization: 'Bearer sk-realtokenvalue' },
          url: 'https://user:pass@example.test/mcp',
        },
      },
    }),
    'a',
  )
  const stored = JSON.stringify(knownFieldsForStorage(facts))

  assert.equal(stored.includes('realtokenvalue'), false)
  assert.equal(stored.includes('user:pass'), false)
  assert.equal(stored.includes('example.test'), true)
  assert.equal(knownFieldsForStorage(facts).env?.GITHUB_TOKEN, '[withheld]')
  assert.equal(knownFieldsForStorage(facts).headers?.Authorization, '[withheld]')
})

test('a url this process cannot parse is withheld rather than kept verbatim', () => {
  const facts = factsOf('{"mcpServers":{"a":{"url":"nonsense user:pass@host/mcp"}}}', 'a')
  assert.equal(knownFieldsForStorage(facts).url, '[withheld]')
  const plain = factsOf('{"mcpServers":{"a":{"url":"nonsense-host/mcp"}}}', 'a')
  assert.equal(knownFieldsForStorage(plain).url, 'nonsense-host/mcp')
})

test('the digest tracks known fields and is stable across key order', () => {
  const one = factsOf('{"mcpServers":{"a":{"command":"x","args":["1"],"env":{"A":"1","B":"2"}}}}', 'a')
  const same = factsOf('{"mcpServers":{"a":{"env":{"B":"2","A":"1"},"args":["1"],"command":"x"}}}', 'a')
  const edited = factsOf('{"mcpServers":{"a":{"command":"x","args":["2"]}}}', 'a')

  assert.equal(factsDigest(one), factsDigest(same))
  assert.notEqual(factsDigest(one), factsDigest(edited))
})
