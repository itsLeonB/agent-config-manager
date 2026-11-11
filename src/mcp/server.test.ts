import test from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Check } from '../environ/types.ts'
import type { NativeValue } from '../engine/native-value.ts'
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

// A token shaped like a GitHub credential: the classifier knows it wherever it sits, so the answer
// can be told from one that simply never carried the value.
const TOKEN = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'

function answered(result: ToolAnswer): string {
  const [first] = CallToolResultSchema.parse(result).content
  if (first.type !== 'text') assert.fail('the tool did not answer text')
  return first.text
}

test('a client that initialises and lists tools sees every tool, with the writer not read-only', async () => {
  const client = await connect()
  try {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => ({ name: tool.name, readOnly: tool.annotations?.readOnlyHint })),
      [
        { name: 'list_provisions', readOnly: true },
        { name: 'read_native_config', readOnly: true },
        { name: 'define_provision', readOnly: false },
      ],
    )
  } finally {
    await client.close()
  }
})

test('read_native_config answers a native location with a credential withheld', async () => {
  const home = somewhere()
  write(
    path.join(home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: TOKEN } } } }),
  )
  const client = await connect({ ACM_HOME: home })
  try {
    const answeredText = answered(
      await client.callTool({ name: 'read_native_config', arguments: { harness: 'pi', tier: 'pi:user' } }),
    )
    assert.match(answeredText, /"pointer": "mcpServers\.github"/)
    assert.match(answeredText, /\[withheld: secret\]/)
    assert.equal(answeredText.includes(TOKEN), false, 'the credential reached the tool result')
  } finally {
    await client.close()
  }
})

test('list_provisions answers the Presence rows, filtered by harness', async () => {
  const home = installed()
  const client = await connect({ ACM_HOME: home })
  try {
    const all: unknown = JSON.parse(answered(await client.callTool({ name: 'list_provisions', arguments: {} })))
    assert.deepEqual(all, {
      provisions: [
        {
          name: 'opencode-no-claude',
          tags: [],
          harnesses: [{ harness: 'opencode', tier: 'user', source: path.join(home, 'agents_environ.toml'), presence: 'present', detail: null }],
        },
        {
          name: 'serena',
          tags: [],
          harnesses: [
            {
              harness: 'pi',
              tier: 'user',
              source: path.join(home, 'agents_environ.toml'),
              presence: 'absent',
              detail: `${path.join(home, '.pi', 'agent', 'mcp.json')} is not there`,
            },
          ],
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
          harnesses: [
            {
              harness: 'pi',
              tier: 'user',
              source: path.join(home, 'agents_environ.toml'),
              presence: 'absent',
              detail: `${path.join(home, '.pi', 'agent', 'mcp.json')} is not there`,
            },
          ],
        },
      ],
    })
  } finally {
    await client.close()
  }
})

// The definition the tool answers with, checked by the protocol's own answer rather than cast: the
// bundle has to land bytes in the fixture's project-local file and name the pointer it wrote.
const DEFINED = z.object({
  kind: z.literal('defined'),
  tier: z.literal('project-local'),
  file: z.string(),
  pointer: z.literal('provision.serena.opencode'),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
})

const LOCAL = `version = 1

[provision.serena.opencode]
check = { file = "~/.config/opencode/opencode.json", contains = "serena" }
install = "opencode mcp add serena"
`

// `install` is required in the tool's own schema, not only in the loader: a definition that named
// only the Check would land a subtree the loader refuses and, on an existing entry, would silently
// keep the old command while its answer said the entry had been replaced.
test('define_provision refuses a definition with no Install command, before writing anything', async () => {
  const project = somewhere()
  const client = await connect({ ACM_PROJECT_ROOT: project })
  try {
    const result = await client.callTool({
      name: 'define_provision',
      arguments: {
        name: 'serena',
        harness: 'opencode',
        check: { file: '~/.config/opencode/opencode.json', contains: 'serena' },
      },
    })
    assert.equal(CallToolResultSchema.parse(result).isError, true)
    assert.match(answered(result), /install/i)
    assert.equal(fs.existsSync(path.join(project, 'agents_environ.local.toml')), false, 'the refusal wrote the file')
  } finally {
    await client.close()
  }
})

test('define_provision writes the entry into the project-local file and answers its pointer', async () => {
  const project = somewhere()
  const client = await connect({ ACM_PROJECT_ROOT: project })
  try {
    const defined = DEFINED.parse(
      JSON.parse(
        answered(
          await client.callTool({
            name: 'define_provision',
            arguments: {
              name: 'serena',
              harness: 'opencode',
              check: { file: '~/.config/opencode/opencode.json', contains: 'serena' },
              install: 'opencode mcp add serena',
            },
          }),
        ),
      ),
    )
    const file = path.join(project, 'agents_environ.local.toml')
    assert.equal(defined.file, file)
    assert.equal(fs.readFileSync(file, 'utf8'), LOCAL)

    // A definition the loader would refuse is an error the caller fixes, and the file is untouched.
    const refusedResult = await client.callTool({
      name: 'define_provision',
      arguments: { name: 'serena', harness: 'gemini', check: { file: '~/.gemini/settings.json' }, install: 'x' },
    })
    assert.equal(CallToolResultSchema.parse(refusedResult).isError, true)
    assert.match(answered(refusedResult), /unknown harness 'gemini'/)
    assert.equal(fs.readFileSync(file, 'utf8'), LOCAL, 'the refused definition changed the file')
  } finally {
    await client.close()
  }
})

// The same rows as data, from the CLI the way a human reads them: the round trip the ticket
// demands is defined through the tool and read back by `acm status`, so the smoke test spawns the
// bundle a second time rather than reusing the MCP answer. Parsed at the boundary, so a document
// the test compares comes back as the domain shape rather than an untyped blob.
const STATUS_ROW = z.object({
  name: z.string(),
  tags: z.array(z.string()),
  harnesses: z.array(
    z.object({
      harness: z.string(),
      tier: z.string(),
      source: z.string(),
      presence: z.enum(['present', 'absent', 'unknown']),
      detail: z.string().nullable(),
    }),
  ),
})

function statusJson(overrides: Record<string, string>): z.infer<typeof STATUS_ROW>[] {
  const result = spawnSync(process.execPath, [binPath(), 'status', '--json'], {
    cwd: somewhere(),
    // The fixture owns its PATH: the host's own may hold an entry the evaluator cannot search,
    // which would answer `unknown` for a name that is simply not there.
    env: { ...childEnv(), PATH: '/usr/bin:/bin', ...overrides },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return z.object({ provisions: z.array(STATUS_ROW) }).parse(JSON.parse(result.stdout)).provisions
}

// The tool's own schema is what a client reads to know what a definition accepts: tools/list has
// to spell every predicate and every install form, each with the description naming what it
// answers, so writing a Provision does not mean reading the evaluator to guess at the shape.
test('tools/list spells every predicate and every install form in the definition schema', async () => {
  const client = await connect()
  try {
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'define_provision')
    assert.ok(tool !== undefined, 'define_provision is not registered')
    // The schema is the shape: check is the union of the six predicates, checks the list spelling,
    // and install the union of the three forms. The parse is the assertion.
    const schema = z
      .object({
        properties: z
          .object({
            check: z.object({ anyOf: z.array(z.object({}).passthrough()).length(6) }).passthrough(),
            checks: z.object({ type: z.literal('array') }).passthrough(),
            install: z.object({ anyOf: z.array(z.object({}).passthrough()).length(3) }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(tool.inputSchema)
    for (const description of [
      'answers whether the file exists',
      "answers whether the file's text matches the contains pattern",
      'answers whether the value at the pointer equals the value given, or that a value sits there when equals is omitted',
      'answers whether the array at the pointer includes the value',
      "answers whether the Section of the file holds the Payload's text",
      'answers whether the name is an executable file on PATH',
      'the Install command text, the only text ACM ever executes',
      'a Payload: the file the command text lives in, resolved like a Check path, with the arguments that reach it as argv',
      'a Section write: the Payload rewrites one Section of the native file',
    ]) {
      assert.ok(JSON.stringify(schema).includes(description), `the schema does not say: ${description}`)
    }
  } finally {
    await client.close()
  }
})

// One accepted definition per predicate: the six shapes of the union, each written as the file
// spells it and read back as a row rather than a file that refuses to load.
interface AcceptedCase {
  readonly what: string
  // The domain type is the closed predicate set itself, which is what this table pins.
  readonly check: Check
  readonly checkLine: string
  readonly detail: string
}

function acceptedCases(home: string): readonly AcceptedCase[] {
  const missing = (file: string) => `${path.join(home, file)} is not there`
  return [
    {
      what: 'the file-exists predicate',
      check: { file: '~/.codex/config.toml' },
      checkLine: 'check = { file = "~/.codex/config.toml" }',
      detail: missing('.codex/config.toml'),
    },
    {
      what: 'the contains predicate',
      check: { file: '~/.codex/config.toml', contains: 'mcp_servers.serena' },
      checkLine: 'check = { file = "~/.codex/config.toml", contains = "mcp_servers.serena" }',
      detail: missing('.codex/config.toml'),
    },
    {
      what: 'the pointer-with-equals predicate',
      check: { file: '~/.codex/config.toml', pointer: 'mcp_servers.serena', equals: { command: 'uvx' } },
      checkLine: 'check = { file = "~/.codex/config.toml", pointer = "mcp_servers.serena", equals = { command = "uvx" } }',
      detail: missing('.codex/config.toml'),
    },
    {
      what: 'the pointer-with-includes predicate',
      check: { file: '~/.config/opencode/opencode.json', pointer: 'plugins', includes: 'i-have-adhd' },
      checkLine: 'check = { file = "~/.config/opencode/opencode.json", pointer = "plugins", includes = "i-have-adhd" }',
      detail: missing('.config/opencode/opencode.json'),
    },
    {
      what: 'the section predicate',
      check: { file: '~/.pi/agent/AGENTS.md', section: 'instructions/output-style.md' },
      checkLine: 'check = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }',
      detail: missing('.pi/agent/AGENTS.md'),
    },
    {
      what: 'the onPath predicate',
      check: { onPath: 'acm-definitely-not-a-command' },
      checkLine: 'check = { onPath = "acm-definitely-not-a-command" }',
      detail: 'acm-definitely-not-a-command is not on PATH',
    },
  ]
}

const DELTA_DEFINED = z.object({
  kind: z.literal('defined'),
  tier: z.literal('project-local'),
  file: z.string(),
  pointer: z.string(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
})

test('one accepted definition per predicate: each lands in the file and acm status reads it back', async () => {
  const home = somewhere()
  for (const sample of acceptedCases(home)) {
    const project = somewhere()
    const client = await connect({ ACM_PROJECT_ROOT: project, ACM_HOME: home })
    try {
      const defined = DELTA_DEFINED.parse(
        JSON.parse(
          answered(
            await client.callTool({
              name: 'define_provision',
              arguments: { name: 'delta', harness: 'pi', check: sample.check, install: 'x' },
            }),
          ),
        ),
      )
      const file = path.join(project, 'agents_environ.local.toml')
      assert.equal(defined.file, file, sample.what)
      assert.equal(defined.pointer, 'provision.delta.pi', sample.what)
      assert.equal(
        fs.readFileSync(file, 'utf8'),
        `version = 1\n\n[provision.delta.pi]\n${sample.checkLine}\ninstall = "x"\n`,
        sample.what,
      )
      // The written form is one the loader accepts: the row carries the Presence the Check answers.
      assert.deepEqual(
        statusJson({ ACM_PROJECT_ROOT: project, ACM_HOME: home }),
        [
          {
            name: 'delta',
            tags: [],
            harnesses: [
              { harness: 'pi', tier: 'project-local', source: file, presence: 'absent', detail: sample.detail },
            ],
          },
        ],
        sample.what,
      )
    } finally {
      await client.close()
    }
  }
})

// The round trip the ticket demands: an entry with several Checks, a Payload with arguments, and a
// Section write are each definable through the tool and then readable by `acm status`.
test('several Checks, a Payload with arguments, and a Section write each round-trip through the tool', async () => {
  const project = somewhere()
  const home = somewhere()
  const client = await connect({ ACM_PROJECT_ROOT: project, ACM_HOME: home })
  const file = path.join(project, 'agents_environ.local.toml')
  try {
    const several = DELTA_DEFINED.parse(
      JSON.parse(
        answered(
          await client.callTool({
            name: 'define_provision',
            arguments: {
              name: 'delta',
              harness: 'pi',
              checks: [
                { file: '~/AGENTS.md', contains: '^@RTK' },
                { file: '~/AGENTS.md', contains: '^## Output style' },
              ],
              install: 'npx rtk init --quiet',
            },
          }),
        ),
      ),
    )
    assert.equal(several.file, file)
    assert.equal(several.pointer, 'provision.delta.pi')
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      `version = 1

[provision.delta.pi]
checks = [{ file = "~/AGENTS.md", contains = "^@RTK" }, { file = "~/AGENTS.md", contains = "^## Output style" }]
install = "npx rtk init --quiet"
`,
    )
    assert.deepEqual(
      statusJson({ ACM_PROJECT_ROOT: project, ACM_HOME: home }),
      [
        {
          name: 'delta',
          tags: [],
          harnesses: [
            {
              harness: 'pi',
              tier: 'project-local',
              source: file,
              presence: 'absent',
              detail: `${path.join(home, 'AGENTS.md')} is not there; ${path.join(home, 'AGENTS.md')} is not there`,
            },
          ],
        },
      ],
    )
  } finally {
    await client.close()
  }

  const payloadProject = somewhere()
  const payloadHome = somewhere()
  const payloadClient = await connect({ ACM_PROJECT_ROOT: payloadProject, ACM_HOME: payloadHome })
  const payloadFile = path.join(payloadProject, 'agents_environ.local.toml')
  try {
    DELTA_DEFINED.parse(
      JSON.parse(
        answered(
          await payloadClient.callTool({
            name: 'define_provision',
            arguments: {
              name: 'delta',
              harness: 'codex',
              check: { file: '~/.codex/config.toml', contains: 'serena' },
              install: { payload: 'install/codex-mcp.sh', args: ['serena'] },
            },
          }),
        ),
      ),
    )
    assert.equal(
      fs.readFileSync(payloadFile, 'utf8'),
      `version = 1

[provision.delta.codex]
check = { file = "~/.codex/config.toml", contains = "serena" }
install = { payload = "install/codex-mcp.sh", args = ["serena"] }
`,
    )
    assert.deepEqual(
      statusJson({ ACM_PROJECT_ROOT: payloadProject, ACM_HOME: payloadHome }),
      [
        {
          name: 'delta',
          tags: [],
          harnesses: [
            {
              harness: 'codex',
              tier: 'project-local',
              source: payloadFile,
              presence: 'absent',
              detail: `${path.join(payloadHome, '.codex', 'config.toml')} is not there`,
            },
          ],
        },
      ],
    )
  } finally {
    await payloadClient.close()
  }

  const sectionProject = somewhere()
  const sectionHome = somewhere()
  const sectionClient = await connect({ ACM_PROJECT_ROOT: sectionProject, ACM_HOME: sectionHome })
  const sectionFile = path.join(sectionProject, 'agents_environ.local.toml')
  try {
    DELTA_DEFINED.parse(
      JSON.parse(
        answered(
          await sectionClient.callTool({
            name: 'define_provision',
            arguments: {
              name: 'delta',
              harness: 'pi',
              check: { file: '~/.pi/agent/AGENTS.md', section: 'instructions/output-style.md' },
              install: { file: '~/.pi/agent/AGENTS.md', section: 'instructions/output-style.md' },
            },
          }),
        ),
      ),
    )
    assert.equal(
      fs.readFileSync(sectionFile, 'utf8'),
      `version = 1

[provision.delta.pi]
check = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }
install = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }
`,
    )
    assert.deepEqual(
      statusJson({ ACM_PROJECT_ROOT: sectionProject, ACM_HOME: sectionHome }),
      [
        {
          name: 'delta',
          tags: [],
          harnesses: [
            {
              harness: 'pi',
              tier: 'project-local',
              source: sectionFile,
              presence: 'absent',
              detail: `${path.join(sectionHome, '.pi', 'agent', 'AGENTS.md')} is not there`,
            },
          ],
        },
      ],
    )
  } finally {
    await sectionClient.close()
  }
})

// A refused definition is a failure the caller fixes, and the reason is the parser's own — the
// one the next read of that file would report. One case per refusal reason a definition written
// through the tool can reach, each naming the request and the reason the loader gives back.
// A refusal case deliberately names a Check or Install shape no domain type spells, so the request
// is typed as far as the domain can say and the rest is the file's own value domain.
// A type alias, not an interface: the alias's implicit index signature is what lets a request be
// handed to callTool, whose arguments are the protocol's own open dictionary.
type DefineArguments = {
  name: string
  harness: string
  tier?: string
  check?: Record<string, NativeValue>
  checks?: Record<string, NativeValue>[]
  install: string | Record<string, NativeValue>
  tags?: string[]
}

interface RefusalCase {
  readonly what: string
  readonly request: DefineArguments
  // The refusal the loader gives for the file this request would write, pinned whole: the tool's
  // answer is the loader's own line, column, and reason, not a second verdict of its own.
  readonly line: number
  readonly column: number
  readonly reason: string
}

function refusalCases(): readonly RefusalCase[] {
  const check = { file: '~/.x' }
  return [
    {
      what: 'an unknown harness',
      request: { name: 'delta', harness: 'gemini', check: { file: '~/.gemini/settings.json' }, install: 'x' },
      line: 3,
      column: 1,
      reason: "unknown harness 'gemini'",
    },
    {
      what: 'an unknown predicate',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', grep: 'serena' }, install: 'x' },
      line: 4,
      column: 26,
      reason: "unknown predicate 'grep'",
    },
    {
      what: 'an onPath beside another key',
      request: { name: 'delta', harness: 'pi', check: { onPath: 'uvx', file: '~/.x' }, install: 'x' },
      line: 4,
      column: 27,
      reason: "onPath takes no other key, and 'file' is one",
    },
    {
      what: 'an empty onPath',
      request: { name: 'delta', harness: 'pi', check: { onPath: '' }, install: 'x' },
      line: 4,
      column: 11,
      reason: 'onPath is empty',
    },
    {
      what: 'an empty file',
      request: { name: 'delta', harness: 'pi', check: { file: '' }, install: 'x' },
      line: 4,
      column: 11,
      reason: 'file is empty',
    },
    {
      what: 'an empty contains',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', contains: '' }, install: 'x' },
      line: 4,
      column: 26,
      reason: 'contains is empty',
    },
    {
      what: 'contains beside pointer',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', contains: 'y', pointer: 'p' }, install: 'x' },
      line: 4,
      column: 42,
      reason: 'a check holds contains or pointer, not both',
    },
    {
      what: 'equals beside includes',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', pointer: 'p', equals: 1, includes: 'y' }, install: 'x' },
      line: 4,
      column: 53,
      reason: 'a check holds equals or includes, not both',
    },
    {
      what: 'contains beside includes',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', contains: 'y', includes: 'y' }, install: 'x' },
      line: 4,
      column: 42,
      reason: 'a check holds contains or includes, not both',
    },
    {
      what: 'a key beside section',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', section: 's', contains: 'y' }, install: 'x' },
      line: 4,
      column: 41,
      reason: 'a check holds section or contains, not both',
    },
    {
      what: 'an empty section',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', section: '' }, install: 'x' },
      line: 4,
      column: 26,
      reason: 'section is empty',
    },
    {
      what: 'an empty pointer',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', pointer: '' }, install: 'x' },
      line: 4,
      column: 26,
      reason: 'pointer is empty',
    },
    {
      what: 'a pointer that cannot be spelled',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', pointer: 'mcp_servers."my.server' }, install: 'x' },
      line: 4,
      column: 26,
      reason: 'pointer cannot be spelled: an unterminated quote',
    },
    {
      what: 'includes without a pointer',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', includes: 'y' }, install: 'x' },
      line: 4,
      column: 26,
      reason: 'includes needs a pointer',
    },
    {
      what: 'equals without a pointer',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x', equals: 1 }, install: 'x' },
      line: 4,
      column: 26,
      reason: 'equals needs a pointer',
    },
    {
      what: 'no Check at all',
      request: { name: 'delta', harness: 'pi', install: 'x' },
      line: 3,
      column: 1,
      reason: 'missing check',
    },
    {
      what: 'check and checks both',
      request: { name: 'delta', harness: 'pi', check: { file: '~/.x' }, checks: [{ file: '~/.y' }], install: 'x' },
      line: 5,
      column: 1,
      reason: 'an entry holds check or checks, not both',
    },
    {
      what: 'an empty checks list',
      request: { name: 'delta', harness: 'pi', checks: [], install: 'x' },
      line: 4,
      column: 1,
      reason: 'checks is empty',
    },
    {
      what: 'an empty payload',
      request: { name: 'delta', harness: 'pi', check, install: { payload: '' } },
      line: 5,
      column: 13,
      reason: 'payload is empty',
    },
    {
      what: 'an unknown install key',
      request: { name: 'delta', harness: 'pi', check, install: { payload: 'x', bogus: 1 } },
      line: 5,
      column: 28,
      reason: "unknown install key 'bogus'",
    },
    {
      what: 'an argument beside a section write',
      request: { name: 'delta', harness: 'pi', check, install: { file: '~/.x', section: 's', args: ['a'] } },
      line: 5,
      column: 43,
      reason: 'a section install holds file and section, not args',
    },
    {
      what: 'an empty install file',
      request: { name: 'delta', harness: 'pi', check, install: { file: '', section: 's' } },
      line: 4,
      column: 11,
      reason: 'file is empty',
    },
    {
      what: 'an empty install section',
      request: { name: 'delta', harness: 'pi', check, install: { file: '~/.x', section: '' } },
      line: 5,
      column: 28,
      reason: 'section is empty',
    },
  ]
}

// One client and one project: every case is refused before the write, so the file the tier owns
// never appears, and the definition the existing tests pinned stays the one they assert.
test('one refused definition per refusal reason: the loader\'s line, column and reason, nothing written', async () => {
  const project = somewhere()
  const file = path.join(project, 'agents_environ.local.toml')
  const client = await connect({ ACM_PROJECT_ROOT: project })
  try {
    for (const sample of refusalCases()) {
      const result = await client.callTool({ name: 'define_provision', arguments: sample.request })
      assert.equal(CallToolResultSchema.parse(result).isError, true, sample.what)
      assert.equal(answered(result), `not defined: ${sample.line}:${sample.column}: ${sample.reason}`, sample.what)
      assert.equal(fs.existsSync(file), false, `${sample.what} wrote the file`)
    }
  } finally {
    await client.close()
  }
})
