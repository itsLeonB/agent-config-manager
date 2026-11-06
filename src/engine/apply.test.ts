import test from 'node:test'
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { stripJsonc } from './adapters/opencode/read.ts'

const codexDocument = z.object({
  mcp_servers: z.record(z.string(), z.object({ command: z.string().optional() })),
})

const applyReport = z.object({ outcome: z.string(), planId: z.string() })

const verifyReport = z.object({ outcome: z.string() })

const openCodeDocument = z.object({
  theme: z.string(),
  mcp: z.object({
    servers: z.record(z.string(), z.object({ type: z.string(), command: z.array(z.string()).optional() })),
  }),
})
import type { EngineConfig } from './config.ts'
import {
  planIdOf,
  planObjectSchema,
  planValueSchema,
  type MirrorPlan,
  type PlanValue,
  type PlanWrite,
} from './plan.ts'
import {
  applyPlan,
  discover,
  listInstallations,
  planMirror,
  verifyPlanDocument,
} from './service.ts'
import { listOperations } from './repo.ts'

function fixture(): EngineConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-apply-test-'))
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

interface PiServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
  timeout?: number
}

function piServers(config: EngineConfig, servers: Record<string, PiServer>): void {
  fs.writeFileSync(
    path.join(config.home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: servers }),
  )
}

function codexFile(config: EngineConfig): string {
  return path.join(config.home, '.codex', 'config.toml')
}

function codexFile_(config: EngineConfig, toml: string): void {
  fs.writeFileSync(codexFile(config), toml)
}

function onlyId(config: EngineConfig, name: string): string {
  const row = listInstallations(config, {}).installations.find((candidate) => candidate.name === name)
  assert.ok(row, `${name} was not discovered`)
  return row.id
}

function plan(config: EngineConfig, name: string, target: string): MirrorPlan {
  const result = planMirror(config, onlyId(config, name), target)
  assert.equal(result.kind, 'plan', result.kind === 'refused' ? result.reason : '')
  return result.kind === 'plan' ? result.plan : assert.fail('unreachable')
}

// A plan is self-identifying, so a plan built by hand here is stamped the way the planner stamps
// one: the same integrity check apply runs, never a bypass of it.
function resign(planned: MirrorPlan, writes: PlanWrite[]): MirrorPlan {
  const body: Record<string, PlanValue> = JSON.parse(JSON.stringify({ ...planned, writes }))
  delete body.planId
  return { ...planned, writes, planId: planIdOf(body) }
}

function verifyOutcome(planned: MirrorPlan): string {
  const result = verifyPlanDocument(planned)
  return result.kind === 'ok' ? result.verification.outcome : `refused: ${result.reason}`
}

function digestOfFile(file: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function setPointer(document: PlanValue, segments: string[], value: PlanValue): PlanValue {
  const object = planObjectSchema.parse(document)
  const [head, ...rest] = segments
  if (head === undefined) return value
  if (rest.length === 0) return { ...object, [head]: value }
  return { ...object, [head]: setPointer(object[head] ?? {}, rest, value) }
}

// The document the plan says should exist: the original with only the addressed pointers changed.
function expectedDocument(before: string, planned: MirrorPlan): PlanValue {
  const document = planValueSchema.parse(parseToml(before))
  return planned.writes.reduce(
    (edited, write) => setPointer(edited, write.pointer.split('.'), write.value),
    document,
  )
}

test('a safe plan changes only the pointers it addresses, keeping comments and siblings', () => {
  const config = fixture()
  const before = `# Codex user config, written by hand.
model = "gpt-5"

# a sibling server this plan never mentions
[mcp_servers.other]
command = "other"
args = ["--flag"]
startup_timeout_sec = 12 # leave this number alone

[projects."/tmp/example"]
trust_level = "trusted"
`
  codexFile_(config, before)
  piServers(config, { serena: { command: 'serena', args: ['start-mcp-server'], timeout: 30 } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  assert.equal(planned.security.grade, 'safe')
  const result = applyPlan(config, planned)

  assert.equal(result.outcome, 'applied', result.reason ?? '')
  assert.equal(result.failed, null)
  assert.equal(result.landed.length, planned.writes.length)
  const text = fs.readFileSync(codexFile(config), 'utf8')
  // Only the addressed pointers moved: everything the plan did not name is byte-identical in meaning.
  assert.deepEqual(parseToml(text), expectedDocument(before, planned))
  // And the comments are still somebody's comments.
  assert.match(text, /# Codex user config, written by hand\./)
  assert.match(text, /# a sibling server this plan never mentions/)
  assert.match(text, /startup_timeout_sec = 12 # leave this number alone/)
})

test('applying into a commented JSON config keeps the comments and the sibling entry', () => {
  const config = fixture()
  codexFile_(
    config,
    `[mcp_servers.local]
command = "codex-local"
args = ["--stdio"]
`,
  )
  const target = path.join(config.projectRoot, 'opencode.jsonc')
  const before = `{
  // hand-written; this comment has to survive a mirror
  "theme": "dark",
  "mcp": {
    "servers": {
      "other": { "type": "local", "command": ["other"] } // a sibling
    }
  }
}
`
  fs.writeFileSync(target, before)
  discover(config)

  const planned = plan(config, 'local', 'oc:project')
  const result = applyPlan(config, planned)
  assert.equal(result.outcome, 'applied', result.reason ?? '')

  const text = fs.readFileSync(target, 'utf8')
  assert.match(text, /\/\/ hand-written; this comment has to survive a mirror/)
  assert.match(text, /\/\/ a sibling/)
  const document = openCodeDocument.parse(JSON.parse(stripJsonc(text)))
  assert.equal(document.theme, 'dark')
  assert.deepEqual(document.mcp?.servers?.other, { type: 'local', command: ['other'] })
  assert.deepEqual(document.mcp?.servers?.local?.command, ['codex-local', '--stdio'])
})

test('verification re-reads the target and reports every assertion', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena', args: ['start-mcp-server'] } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  assert.deepEqual(planned.manualSteps, [])
  const result = applyPlan(config, planned)
  const verification = result.verification
  assert.ok(verification)
  assert.equal(verification.outcome, 'verified')
  assert.equal(verification.asserts.length, planned.verify.asserts.length)
  for (const assertion of verification.asserts) {
    assert.equal(assertion.holds, true, assertion.pointer)
    assert.equal(assertion.file, codexFile(config))
    assert.deepEqual(assertion.actual, assertion.expected)
  }
  // A later re-assert reads the file again, and lands on the same answer.
  assert.equal(verifyOutcome(planned), 'verified')
})

test('a target edited after planning is stale, and nothing is written', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  const edited = `${fs.readFileSync(codexFile(config), 'utf8')}\n# a human was here\n`
  fs.writeFileSync(codexFile(config), edited)

  const result = applyPlan(config, planned)
  assert.equal(result.outcome, 'stale')
  assert.deepEqual(result.landed, [])
  assert.equal(fs.readFileSync(codexFile(config), 'utf8'), edited)
})

test('a write that fails mid-plan is partial: the earlier writes stay, with their digests', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena', args: ['start-mcp-server'] } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  const blocked: PlanWrite = {
    op: 'writeAtPointer',
    file: codexFile(config),
    // `args` is a list by the time this runs, so it cannot be written into element by element.
    pointer: `mcp_servers.serena.args.0`,
    value: 'element',
    precondition: { exists: true, digest: digestOfFile(codexFile(config)) },
    reversible: true,
    priorValue: null,
    executable: false,
    secretValues: false,
    irreversible: false,
  }
  const result = applyPlan(config, resign(planned, [...planned.writes, blocked]))

  assert.equal(result.outcome, 'partial')
  assert.equal(result.failed?.pointer, blocked.pointer)
  assert.equal(result.landed.length, planned.writes.length)
  for (const landed of result.landed) assert.equal(landed.digest, digestOfFile(codexFile(config)))
  // No rollback: what landed before the failure is still on disk.
  const document = codexDocument.parse(parseToml(fs.readFileSync(codexFile(config), 'utf8')))
  assert.equal(document.mcp_servers.serena?.command, 'serena')
  assert.equal(result.verification?.outcome, 'failed')
})

test('a second apply while one is in flight is busy, and a stale lock is not a wedge', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  const before = fs.readFileSync(codexFile(config), 'utf8')
  const lock = `${config.storePath}.apply.lock`
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))

  const busy = applyPlan(config, planned)
  assert.equal(busy.outcome, 'busy')
  assert.equal(fs.readFileSync(codexFile(config), 'utf8'), before)

  // A lock whose owner has exited is broken rather than waited on forever.
  const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  fs.writeFileSync(lock, JSON.stringify({ pid: gone.pid, at: new Date().toISOString() }))
  assert.equal(applyPlan(config, planned).outcome, 'applied')
  assert.equal(fs.existsSync(lock), false)
})

test('a plan with pending manual steps lands unverified, records the operation, and reports them', () => {
  const config = fixture()
  fs.writeFileSync(path.join(config.projectRoot, '.codex', 'config.toml'), '')
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:project')
  assert.ok(planned.manualSteps.length > 0)
  const result = applyPlan(config, planned)

  assert.equal(result.outcome, 'applied', result.reason ?? '')
  assert.equal(result.verification?.outcome, 'unverified')
  assert.deepEqual(result.verification?.manualSteps, planned.manualSteps)
  assert.deepEqual(result.manualSteps, planned.manualSteps)
  assert.ok(result.verification?.asserts.every((assertion) => assertion.holds))

  const operations = listOperations(config.storePath)
  assert.equal(operations.length, 1)
  const [operation] = operations
  assert.equal(operation?.planId, planned.planId)
  assert.equal(operation?.grade, planned.security.grade)
  assert.equal(operation?.outcome, 'applied')
  assert.equal(operation?.sourceInstallationId, planned.source.installationId)
  assert.deepEqual(operation?.landed, result.landed)

  // The target's own row now carries the verification the plan's asserts produced.
  const target = listInstallations(config, { harness: 'codex' }).installations.find(
    (row) => row.nativeFile === path.join(config.projectRoot, '.codex', 'config.toml'),
  )
  assert.ok(target)
  assert.equal(target.id, operation?.targetInstallationId)
  assert.equal(target.bindings[0]?.verificationStatus, 'unverified')
})

test('a tampered plan and a write outside the declared tier are both refused', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  const edited = structuredClone(planned)
  edited.writes[0] = { ...edited.writes[0], value: 'something-else' }
  const refused = applyPlan(config, edited)
  assert.equal(refused.outcome, 'refused')
  assert.match(refused.reason ?? '', /does not hash to its planId/)
  // Verifying a document nobody applied is refused the same way, before any file is read.
  assert.match(verifyOutcome(edited), /^refused: /)

  const elsewhere = structuredClone(planned.writes[0])
  const outside = applyPlan(
    config,
    resign(planned, [{ ...elsewhere, file: path.join(config.home, '.ssh', 'config') }]),
  )
  assert.equal(outside.outcome, 'refused')
  assert.match(outside.reason ?? '', /is not a path codex:user declares/)

  assert.deepEqual(fs.readFileSync(codexFile(config), 'utf8'), '# empty codex config\n')
})

function cli(config: EngineConfig, args: string[], stdin?: string) {
  const cliPath = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      ACM_HOME: config.home,
      ACM_PROJECT_ROOT: config.projectRoot,
      ACM_STORE: config.storePath,
      CODEX_HOME: path.join(config.home, '.codex'),
    },
  })
}

test('acm apply and acm verify are faces over the same document', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  const planFile = path.join(path.dirname(config.storePath), 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify(planned))

  const applied = cli(config, ['apply', planFile])
  assert.equal(applied.status, 0, applied.stderr)
  const appliedResult = applyReport.parse(JSON.parse(applied.stdout))
  assert.equal(appliedResult.outcome, 'applied')
  assert.equal(appliedResult.planId, planned.planId)

  const verified = cli(config, ['verify', '-'], JSON.stringify(planned))
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(verifyReport.parse(JSON.parse(verified.stdout)).outcome, 'verified')

  // The same document applied twice is stale, not a second write.
  const replayed = cli(config, ['apply', planFile])
  assert.equal(replayed.status, 1)
  assert.equal(applyReport.parse(JSON.parse(replayed.stdout)).outcome, 'stale')
})
