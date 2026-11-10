import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

// The bin the package declares is what a harness pins, so the smoke test spawns that path rather
// than a source file of its own choosing: the assertion below is about the built bundle.
function binPath(): string {
  const manifest = z
    .object({ bin: z.object({ acm: z.string() }) })
    .parse(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')))
  const bin = fileURLToPath(new URL(`../../${manifest.bin.acm}`, import.meta.url))
  assert.ok(fs.existsSync(bin), `${bin} is missing: run \`bun run build:acm\` before the suite`)
  // A harness pins an absolute path to a file it can launch: the shebang names Node, so no Bun and
  // no interpreter flag has to be present for it to start.
  assert.equal(fs.readFileSync(bin, 'utf8').split('\n', 1)[0], '#!/usr/bin/env node')
  return bin
}

// The environment is emptied of this machine's own acm overrides, so what the bundle answers for is
// the fixture rather than a shell set up for something else.
function childEnv(): Record<string, string> {
  const boundary = new Set(['ACM_PROJECT_ROOT', 'ACM_HOME', 'ACM_STORE', 'CODEX_HOME', 'CLAUDE_PROJECT_DIR'])
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !boundary.has(entry[0]) && !entry[0].startsWith('ACM_'),
    ),
  )
}

async function connect(overrides: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    // A harness starts the built file on Node, so the smoke test does too: passing under Bun alone
    // would not say the bundle is a Node program.
    command: 'node',
    args: [binPath(), 'mcp', 'serve'],
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'acm-mcp-cwd-')),
    env: { ...childEnv(), ...overrides },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'acm-smoke', version: '0.0.0' })
  await client.connect(transport)
  return client
}

function somewhere(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acm-mcp-'))
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

// The environment a fixture home declares: one entry whose check passes and one whose check does
// not, so the tool's answer carries both kinds of row.
function installed(): string {
  const home = somewhere()
  write(
    path.join(home, 'agents_environ.toml'),
    `version = 1

[provision.opencode-no-claude.opencode]
check   = { file = "~/.zshrc", contains = "OPENCODE_DISABLE_CLAUDE_CODE" }
install = "./scripts/zshrc-export.sh OPENCODE_DISABLE_CLAUDE_CODE=1"

[provision.serena.pi]
check   = { file = "~/.pi/agent/mcp.json", contains = "serena" }
install = "pi plugin install serena"
`,
  )
  write(path.join(home, '.zshrc'), 'export OPENCODE_DISABLE_CLAUDE_CODE=1\n')
  return home
}

// The client's return type is a union with an index signature, so the answer is checked with the
// protocol's own schema before anything reads a field of it.
type ToolAnswer = Awaited<ReturnType<Client['callTool']>>

function answered(result: ToolAnswer): string {
  const [first] = CallToolResultSchema.parse(result).content
  if (first.type !== 'text') assert.fail('the tool did not answer text')
  return first.text
}

test('a client that initialises and lists tools sees the read-only status tool', async () => {
  const client = await connect()
  try {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => ({ name: tool.name, readOnly: tool.annotations?.readOnlyHint })),
      [{ name: 'list_provisions', readOnly: true }],
    )
  } finally {
    await client.close()
  }
})

test('list_provisions answers the Presence rows, filtered by harness', async () => {
  const client = await connect({ ACM_HOME: installed() })
  try {
    const all: unknown = JSON.parse(answered(await client.callTool({ name: 'list_provisions', arguments: {} })))
    assert.deepEqual(all, {
      provisions: [
        {
          name: 'opencode-no-claude',
          tags: [],
          harnesses: [{ harness: 'opencode', tier: 'user', presence: 'present', detail: null }],
        },
        {
          name: 'serena',
          tags: [],
          harnesses: [{ harness: 'pi', tier: 'user', presence: 'absent', detail: null }],
        },
      ],
    })
    const filtered: unknown = JSON.parse(
      answered(await client.callTool({ name: 'list_provisions', arguments: { harness: 'pi' } })),
    )
    assert.deepEqual(filtered, {
      provisions: [
        {
          name: 'serena',
          tags: [],
          harnesses: [{ harness: 'pi', tier: 'user', presence: 'absent', detail: null }],
        },
      ],
    })
  } finally {
    await client.close()
  }
})
