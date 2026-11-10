import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

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

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    // A harness starts the built file on Node, so the smoke test does too: passing under Bun alone
    // would not say the bundle is a Node program.
    command: 'node',
    args: [binPath(), 'mcp', 'serve'],
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'acm-mcp-cwd-')),
    env: childEnv(),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'acm-smoke', version: '0.0.0' })
  await client.connect(transport)
  return client
}

test('a client that initialises and lists tools sees an empty list', async () => {
  const client = await connect()
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools, [])
  } finally {
    await client.close()
  }
})
