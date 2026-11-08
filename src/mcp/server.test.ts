import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { parse as parseToml } from 'smol-toml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { EngineConfig } from '../engine/config.ts'
import type { Json } from '../types/dashboard'

interface PiServerFixture {
  command?: string
  args?: string[]
  env?: Record<string, string>
}

// The answers a tool may return, parsed rather than asserted into shape: a test that reads them
// through a schema fails on a changed document, not on a type the compiler was told to believe.
// A plan document travels whole: the test sends back exactly what it received, and reads its two
// fields through a schema of their own.
const planDocument = z.record(z.string(), z.json())

const planFields = z.object({ planId: z.string(), security: z.object({ grade: z.string() }) })

type ToolArguments = { [key: string]: Json }

const listingSchema = z.object({
  installations: z.array(
    z.object({ id: z.string(), name: z.string(), category: z.string(), nativeFile: z.string() }),
  ),
})

const inspectionSchema = z.object({
  inspection: z.object({
    installation: z.object({ category: z.string(), name: z.string(), nativeFile: z.string() }),
    leaves: z.array(z.object({ pointer: z.string(), value: z.string() })),
  }),
})

const mirrorAnswerSchema = z.object({
  kind: z.string(),
  reason: z.string().optional(),
  plan: z.json().optional(),
})

const applySchema = z.looseObject({
  outcome: z.string(),
  planId: z.string().nullable(),
  reason: z.string().nullable(),
  consent: z.string().nullable(),
  landed: z.array(z.unknown()),
  manualSteps: z.array(z.object({ step: z.string(), why: z.string() })),
  verification: z.object({ outcome: z.string() }).nullable(),
})

const verifyAnswerSchema = z.object({
  kind: z.string(),
  reason: z.string().optional(),
  verification: z.object({ outcome: z.string() }).optional(),
})

const codexWrittenSchema = z.object({
  mcp_servers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()).optional() })),
})

const piWrittenSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({ command: z.string().optional(), env: z.record(z.string(), z.string()).optional() }),
  ),
})

// A fixture home, a fixture project, and a temporary database are the whole environment. Nothing
// here is this machine's own config.
function fixture(): EngineConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-mcp-test-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  for (const dir of [
    [home, '.pi', 'agent'],
    [projectRoot, '.pi'],
    [home, '.codex'],
    [projectRoot, '.codex'],
    [home, '.config', 'opencode'],
    [projectRoot, '.opencode'],
  ]) {
    fs.mkdirSync(path.join(...dir), { recursive: true })
  }
  return { home, projectRoot, storePath: path.join(root, 'dashboard.db') }
}

function piServers(config: EngineConfig, servers: Record<string, PiServerFixture>): void {
  fs.writeFileSync(
    path.join(config.home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: servers }),
  )
}

function piSourceFile(config: EngineConfig): string {
  return path.join(config.home, '.pi', 'agent', 'mcp.json')
}

function childEnv(config: EngineConfig) {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )
  return Object.fromEntries([
    ...inherited,
    ['ACM_HOME', config.home],
    ['ACM_PROJECT_ROOT', config.projectRoot],
    ['ACM_STORE', config.storePath],
    ['CODEX_HOME', path.join(config.home, '.codex')],
  ])
}

interface Connection {
  client: Client
  // How many times the client was asked to render a dialog, so a test can assert the absence too.
  asked: () => number
  close: () => Promise<void>
}

// The spawned face: the bin a harness pins, with the server arguments, a working directory that is
// neither the home nor the project, and every root handed over by the environment.
async function connect(
  config: EngineConfig,
  answer?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>,
): Promise<Connection> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-mcp-cwd-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../cli/main.ts', import.meta.url)), 'mcp', 'serve'],
    cwd,
    env: childEnv(config),
    stderr: 'pipe',
  })
  const client = new Client(
    { name: 'acm-smoke', version: '0.0.0' },
    { capabilities: answer === undefined ? {} : { elicitation: {} } },
  )
  let asked = 0
  if (answer !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked++
      return answer(request)
    })
  }
  await client.connect(transport)
  return {
    client,
    asked: () => asked,
    close: async () => {
      await client.close()
    },
  }
}

// A tool answers with one JSON document, parsed through the schema the test reads it with.
async function call<S extends z.ZodType>(
  client: Client,
  name: string,
  args: ToolArguments,
  schema: S,
): Promise<z.infer<S>> {
  const result = await client.callTool({ name, arguments: args })
  const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(result.content)
  const text = content.find((item) => item.type === 'text')?.text
  assert.ok(text !== undefined, 'a tool call must answer with one text document')
  return schema.parse(JSON.parse(text))
}

test('a client that initialises and lists tools sees exactly the five settled tools', async () => {
  const config = fixture()
  const { client, close } = await connect(config)
  try {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['apply_plan', 'inspect_installation', 'list_installations', 'plan_mirror', 'verify_plan'],
    )
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]))

    // The read-only four declare it, and the apply tool declares what it does.
    for (const readOnly of ['list_installations', 'inspect_installation', 'plan_mirror', 'verify_plan']) {
      assert.equal(byName.get(readOnly)?.annotations?.readOnlyHint, true, readOnly)
    }
    assert.equal(byName.get('apply_plan')?.annotations?.readOnlyHint, false)
    assert.equal(byName.get('apply_plan')?.annotations?.destructiveHint, true)

    // The agreed inputs, on every client: what to read, what to plan, the document to apply.
    const schemaOf = z.object({ properties: z.record(z.string(), z.unknown()).optional() })
    const propertiesOf = (name: string): string[] =>
      Object.keys(schemaOf.parse(byName.get(name)?.inputSchema).properties ?? {}).sort()
    assert.deepEqual(propertiesOf('list_installations'), ['category', 'fresh', 'harness', 'scope'])
    assert.deepEqual(propertiesOf('inspect_installation'), ['installationId'])
    assert.deepEqual(propertiesOf('plan_mirror'), ['installationId', 'target'])
    assert.deepEqual(propertiesOf('apply_plan'), ['onConflict', 'plan'])
    assert.deepEqual(propertiesOf('verify_plan'), ['plan'])
  } finally {
    await close()
  }
})

function sourceId(listing: z.infer<typeof listingSchema>, config: EngineConfig): string {
  const source = listing.installations.find(
    (row) => row.name === 'serena' && row.nativeFile === piSourceFile(config),
  )
  assert.ok(source, 'the scan must find the fixture server')
  return source.id
}

test('a plan document round-trips from plan to apply to verify, and the target changes', async () => {
  const config = fixture()
  const codexFile = path.join(config.home, '.codex', 'config.toml')
  fs.writeFileSync(codexFile, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena', args: ['start-mcp-server'] } })
  const { client, close } = await connect(config)
  try {
    const id = sourceId(await call(client, 'list_installations', { fresh: true }, listingSchema), config)

    const inspected = await call(client, 'inspect_installation', { installationId: id }, inspectionSchema)
    assert.equal(inspected.inspection.installation.category, 'mcp')
    assert.equal(inspected.inspection.installation.name, 'serena')
    assert.ok(inspected.inspection.leaves.some((leaf) => leaf.pointer === 'command' && leaf.value === 'serena'))

    const planned = await call(client, 'plan_mirror', { installationId: id, target: 'codex:user' }, mirrorAnswerSchema)
    assert.equal(planned.kind, 'plan', String(planned.reason ?? ''))
    const plan = planDocument.parse(planned.plan)
    assert.equal(planFields.parse(plan).security.grade, 'safe')

    const applied = await call(client, 'apply_plan', { plan }, applySchema)
    assert.equal(applied.outcome, 'applied', String(applied.reason ?? ''))
    assert.equal(applied.planId, planFields.parse(plan).planId)
    assert.equal(applied.consent, 'client-policy')

    // The bytes on disk are the observable change, not the report.
    const written = codexWrittenSchema.parse(parseToml(fs.readFileSync(codexFile, 'utf8')))
    assert.equal(written.mcp_servers.serena?.command, 'serena')
    assert.deepEqual(written.mcp_servers.serena?.args, ['start-mcp-server'])

    // Carrying the same document back is the whole re-check: nothing was stored to look up.
    const verified = await call(client, 'verify_plan', { plan }, verifyAnswerSchema)
    assert.equal(verified.kind, 'ok', String(verified.reason ?? ''))
    assert.equal(verified.verification?.outcome, 'verified')
  } finally {
    await close()
  }
})

// A Pi entry whose env value runs a command: the one write in this fixture that needs a human.
const commandRetrieval = { serena: { command: 'serena', env: { TOKEN: '!op read op://vault/token' } } }

// The risky plan every consent test applies, into a target file that does not exist yet.
async function riskyPlan(
  client: Client,
  config: EngineConfig,
): Promise<z.infer<typeof planDocument>> {
  const id = sourceId(await call(client, 'list_installations', { fresh: true }, listingSchema), config)
  const answer = await call(client, 'plan_mirror', { installationId: id, target: 'pi:project' }, mirrorAnswerSchema)
  assert.equal(answer.kind, 'plan', String(answer.reason ?? ''))
  const plan = planDocument.parse(answer.plan)
  assert.equal(planFields.parse(plan).security.grade, 'risky')
  return plan
}

test('a client that cannot be asked applies the safe writes and hands the risky one back', async () => {
  const config = fixture()
  piServers(config, commandRetrieval)
  const { client, asked, close } = await connect(config)
  try {
    const applied = await call(client, 'apply_plan', { plan: await riskyPlan(client, config) }, applySchema)

    assert.equal(applied.outcome, 'applied', String(applied.reason ?? ''))
    assert.equal(applied.consent, 'client-policy')
    assert.equal(asked(), 0, 'no dialog is sent to a client that declared no elicitation')
    assert.ok(applied.manualSteps.some((step) => step.step.includes('mcpServers.serena.env.TOKEN')))

    const written = piWrittenSchema.parse(
      JSON.parse(fs.readFileSync(path.join(config.projectRoot, '.pi', 'mcp.json'), 'utf8')),
    )
    assert.equal(written.mcpServers.serena?.command, 'serena')
    // The flagged write is an address in the steps, never a value in the target.
    assert.equal(written.mcpServers.serena?.env, undefined)
    assert.equal(applied.verification?.outcome, 'unverified')
  } finally {
    await close()
  }
})

test('a client that declared elicitation is asked once, and its answer decides the write', async () => {
  const config = fixture()
  piServers(config, commandRetrieval)
  const projectFile = path.join(config.projectRoot, '.pi', 'mcp.json')

  const accepting = await connect(config, () => ({ action: 'accept', content: { executable: true } }))
  try {
    const applied = await call(
      accepting.client,
      'apply_plan',
      { plan: await riskyPlan(accepting.client, config) },
      applySchema,
    )
    assert.equal(applied.outcome, 'applied', String(applied.reason ?? ''))
    assert.equal(applied.consent, 'elicitation')
    assert.equal(accepting.asked(), 1)
    assert.deepEqual(applied.manualSteps, [])
    const written = piWrittenSchema.parse(JSON.parse(fs.readFileSync(projectFile, 'utf8')))
    assert.equal(written.mcpServers.serena?.env?.TOKEN, '!op read op://vault/token')
  } finally {
    await accepting.close()
  }

  // A second fixture: the accepted write is in the first one's target now, so a re-plan there would
  // find the target already matching and ask nothing.
  const declined = fixture()
  piServers(declined, commandRetrieval)
  const declining = await connect(declined, () => ({ action: 'decline' }))
  try {
    const applied = await call(
      declining.client,
      'apply_plan',
      { plan: await riskyPlan(declining.client, declined) },
      applySchema,
    )
    assert.equal(applied.outcome, 'declined', String(applied.reason ?? ''))
    assert.equal(applied.consent, null)
    assert.equal(declining.asked(), 1)
    assert.deepEqual(applied.landed, [])
    assert.equal(fs.existsSync(path.join(declined.projectRoot, '.pi', 'mcp.json')), false)
  } finally {
    await declining.close()
  }
})
