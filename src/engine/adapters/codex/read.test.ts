import test from 'node:test'
import assert from 'node:assert'
import { readCodexMcpToml } from './read.ts'
import { knownFieldsForStorage } from '../mcp-facts.ts'
import type { McpFacts } from '../mcp-facts.ts'

function factsOf(text: string, name: string): McpFacts {
  const read = readCodexMcpToml(text)
  if (read.kind !== 'ok') throw new Error(`expected readable TOML: ${read.detail}`)
  const entry = read.entries.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`${name} was not read`)
  return entry.facts
}

test('a stdio server table becomes the same facts Pi reports', () => {
  const facts = factsOf(
    `
[mcp_servers.serena]
command = "serena"
args = ["start-mcp-server", "--context", "ide-assistant"]

[mcp_servers.serena.env]
GITHUB_TOKEN = "ghp_fixturetoken"
`,
    'serena',
  )
  assert.equal(facts.transport, 'stdio')
  assert.equal(facts.command, 'serena')
  assert.deepEqual(facts.args, ['start-mcp-server', '--context', 'ide-assistant'])
  assert.deepEqual(facts.env, { GITHUB_TOKEN: 'ghp_fixturetoken' })
})

test('an HTTP server table carries its headers and bearer variable name', () => {
  const facts = factsOf(
    `
[mcp_servers.remote]
url = "https://example.test/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"

[mcp_servers.remote.http_headers]
Authorization = "Bearer sk-fixturetoken"
`,
    'remote',
  )
  assert.equal(facts.transport, 'http')
  assert.equal(facts.url, 'https://example.test/mcp')
  assert.equal(facts.bearerTokenEnvVar, 'EXAMPLE_TOKEN')
  assert.deepEqual(facts.headers, { Authorization: 'Bearer sk-fixturetoken' })

  // The bearer variable is a name, not a secret: a reader has to carry it, so it stays readable
  // while the header beside it is withheld.
  const stored = knownFieldsForStorage(facts)
  assert.equal(stored.bearerTokenEnvVar, 'EXAMPLE_TOKEN')
  assert.equal(stored.headers?.Authorization, '[withheld: secret]')
})

test('Codex-native fields are read under their canonical names, seconds kept as seconds', () => {
  const facts = factsOf(
    `
[mcp_servers.serena]
command = "serena"
env_vars = ["HOME"]
enabled = false
startup_timeout_sec = 30.0
tool_timeout_sec = 120
required = true
disabled_tools = ["danger"]
supports_parallel_tool_calls = false
default_tools_approval_mode = "auto"
`,
    'serena',
  )
  assert.deepEqual(facts.envPassthrough, ['HOME'])
  assert.equal(facts.enabled, false)
  assert.equal(facts.timeoutStartup, 30)
  assert.equal(facts.timeoutRequest, 120)
  assert.equal(facts.required, true)
  assert.deepEqual(facts.disabledTools, ['danger'])
  assert.equal(facts.supportsParallelToolCalls, false)
  assert.equal(facts.approvalMode, 'auto')
})

test('an OAuth client secret and an executable header helper never become facts', () => {
  const facts = factsOf(
    `
[mcp_servers.remote]
url = "https://example.test/mcp"
http_headers_helper = "print-headers"

[mcp_servers.remote.oauth]
client_id = "fixture-client"
client_secret = "sk-fixtureclientsecret"
`,
    'remote',
  )
  assert.equal(JSON.stringify(facts).includes('fixtureclientsecret'), false)
  assert.equal(JSON.stringify(facts).includes('print-headers'), false)
})

test('a quoted table name stays one server name', () => {
  const facts = factsOf('[mcp_servers."a.b"]\ncommand = "x"\n', 'a.b')
  assert.equal(facts.command, 'x')
})

test('a syntax error does not echo the source lines into the diagnostic', () => {
  const read = readCodexMcpToml('[mcp_servers.a]\ncommand = "x\ntoken = "sk-fixturetoken\n')
  assert.equal(read.kind, 'invalid')
  const detail = read.kind === 'invalid' ? read.detail : ''
  assert.equal(detail.includes('fixturetoken'), false)
  assert.equal(detail.includes('command'), false)
})

test('TOML that does not parse, or an entry of the wrong shape, is invalid rather than empty', () => {
  assert.equal(readCodexMcpToml('[mcp_servers.serena\ncommand = "x"').kind, 'invalid')
  assert.equal(readCodexMcpToml('[mcp_servers.serena]\nargs = "not-an-array"\n').kind, 'invalid')
  assert.deepEqual(readCodexMcpToml('[features]\nhooks = true\n'), { kind: 'ok', entries: [] })
})
