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

// A fixture can hold the same server in two tiers; the Pi user file is the source these tests read.
function piId(config: EngineConfig, name: string): string {
  const row = listInstallations(config, {}).installations.find(
    (candidate) =>
      candidate.name === name && candidate.nativeFile === path.join(config.home, '.pi', 'agent', 'mcp.json'),
  )
  assert.ok(row, `${name} was not discovered in the Pi user tier`)
  return row.id
}

function planFrom(config: EngineConfig, id: string, target: string): MirrorPlan {
  const result = planMirror(config, id, target)
  assert.equal(result.kind, 'plan', result.kind === 'refused' ? result.reason : '')
  return result.kind === 'plan' ? result.plan : assert.fail('unreachable')
}

// A plan is self-identifying, so a plan built by hand here is stamped the way the planner stamps
// one: the same integrity check apply runs, never a bypass of it.
function resign(
  planned: MirrorPlan,
  change: Partial<Pick<MirrorPlan, 'writes' | 'verify' | 'security'>>,
): MirrorPlan {
  const body: Record<string, PlanValue> = JSON.parse(JSON.stringify({ ...planned, ...change }))
  delete body.planId
  return { ...planned, ...change, planId: planIdOf(body) }
}

function verifyOutcome(config: EngineConfig, planned: MirrorPlan): string {
  const result = verifyPlanDocument(config, planned)
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
  // Nothing was asked of a human: the harness's own permission configuration authorised this.
  assert.equal(result.consent, 'client-policy')
  assert.equal(result.grade, 'safe')
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

test('a write that needs a human answer is a manual step, even when the document claims safe', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena', args: ['start-mcp-server'] } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  const [first] = planned.writes
  assert.ok(first)
  // The flag is what the planner sets for a value that runs at harness runtime; the grade it carries
  // here is a claim a forged document can make, so apply must not trust it.
  const gated: PlanWrite = { ...first, executable: true }
  const forged = resign(planned, {
    writes: [gated, ...planned.writes.slice(1)],
    security: { ...planned.security, grade: 'safe' },
  })

  const result = applyPlan(config, forged)

  assert.equal(result.outcome, 'applied', result.reason ?? '')
  assert.equal(result.grade, 'risky')
  // `client-policy` authorises the safe remainder, never the write nobody answered for.
  assert.equal(result.consent, 'client-policy')
  assert.equal(result.landed.some((landed) => landed.pointer === gated.pointer), false)
  assert.equal(result.landed.length, planned.writes.length - 1)
  assert.ok(result.manualSteps.some((step) => step.step.includes(gated.pointer)))
  assert.equal(result.verification?.outcome, 'unverified')
  assert.ok(result.verification?.asserts.every((assertion) => assertion.pointer !== gated.pointer))
  // The gated pointer is the one value the file does not hold.
  const written = parseToml(fs.readFileSync(codexFile(config), 'utf8'))
  const entry = z.record(z.string(), z.unknown()).parse(written.mcp_servers).serena
  const held = z.record(z.string(), z.unknown()).parse(entry)
  assert.equal(held.command, undefined)
  assert.deepEqual(held.args, ['start-mcp-server'])

  // The audit row carries the grade apply computed, not the one the document claimed.
  const [operation] = listOperations(config.storePath)
  assert.equal(operation?.grade, 'risky')
})

test('a plan whose every write needs a human answer is refused, and nothing is written', () => {
  const config = fixture()
  const before = '# empty codex config\n'
  codexFile_(config, before)
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  const gated = resign(planned, {
    writes: planned.writes.map((write) => ({ ...write, secretValues: true })),
  })
  const result = applyPlan(config, gated)

  assert.equal(result.outcome, 'refused')
  assert.match(result.reason ?? '', /needs a human's own answer/)
  assert.deepEqual(result.landed, [])
  assert.equal(result.consent, null)
  // The steps are handed back so a human can still do the work, by hand.
  assert.equal(result.manualSteps.length, planned.writes.length)
  assert.equal(fs.readFileSync(codexFile(config), 'utf8'), before)
})

test('a differing target refuses by default, shows both values, and replaces only when asked', () => {
  const config = fixture()
  const target = codexFile(config)
  const before = ['[mcp_servers.serena]', "command = 'serena-old'", ''].join('\n')
  codexFile_(config, before)
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = planFrom(config, piId(config, 'serena'), 'codex:user')
  const refused = applyPlan(config, planned)

  assert.equal(refused.outcome, 'refused')
  assert.match(refused.reason ?? '', /serena-old/)
  assert.match(refused.reason ?? '', /"serena"/)
  assert.deepEqual(refused.landed, [])
  assert.equal(fs.readFileSync(target, 'utf8'), before)
  // Nothing was stored by the refusal: the next call refuses on the same grounds.
  assert.equal(applyPlan(config, planned).outcome, 'refused')

  const replaced = applyPlan(config, planned, { onConflict: 'replace' })
  assert.equal(replaced.outcome, 'applied', replaced.reason ?? '')
  assert.equal(replaced.landed.length, planned.writes.length)
  const document = codexDocument.parse(parseToml(fs.readFileSync(target, 'utf8')))
  assert.equal(document.mcp_servers.serena?.command, 'serena')
})

test('a plan with nothing to write applies without touching the target', () => {
  const config = fixture()
  const before = ['[mcp_servers.serena]', "command = 'serena'", ''].join('\n')
  codexFile_(config, before)
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = planFrom(config, piId(config, 'serena'), 'codex:user')
  assert.equal(planned.disposition.kind, 'alreadyPresent')
  const result = applyPlan(config, planned)

  assert.equal(result.outcome, 'applied', result.reason ?? '')
  assert.deepEqual(result.landed, [])
  assert.equal(result.verification?.outcome, 'verified')
  assert.equal(fs.readFileSync(codexFile(config), 'utf8'), before)
})

test('a legacy flat OpenCode block is normalised on apply and left as one shape', () => {
  const config = fixture()
  piServers(config, { local: { command: 'pi-local', args: ['--stdio'] } })
  const target = path.join(config.home, '.config', 'opencode', 'opencode.json')
  const before = JSON.stringify(
    {
      theme: 'dark',
      mcp: { other: { type: 'local', command: ['other'], enabled: true, timeout: 30_000 } },
    },
    null,
    2,
  )
  fs.writeFileSync(target, before)
  discover(config)

  const planned = plan(config, 'local', 'oc:user')
  // The block rewrite replaces bytes that are already there, so it is a conflict until replacement is
  // asked for by name.
  assert.equal(applyPlan(config, planned).outcome, 'refused')
  const result = applyPlan(config, planned, { onConflict: 'replace' })

  assert.equal(result.outcome, 'applied', result.reason ?? '')
  assert.equal(result.verification?.outcome, 'unverified')
  assert.ok(result.verification?.asserts.every((assertion) => assertion.holds))
  // One shape: the legacy key is gone, and the sibling it named now lives under `servers`.
  const document = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.deepEqual(Object.keys(document), ['theme', 'mcp'])
  assert.deepEqual(Object.keys(document.mcp), ['servers'])
  assert.deepEqual(document, {
    theme: 'dark',
    mcp: {
      servers: {
        other: { type: 'local', command: ['other'], disabled: false, timeout: { startup: 30_000, execution: 30_000 } },
        local: { type: 'local', command: ['pi-local', '--stdio'] },
      },
    },
  })
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
  assert.equal(verifyOutcome(config, planned), 'verified')
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
  const result = applyPlan(config, resign(planned, { writes: [...planned.writes, blocked] }))

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
  assert.match(verifyOutcome(config, edited), /^refused: /)

  const elsewhere = structuredClone(planned.writes[0])
  const outside = applyPlan(
    config,
    resign(planned, { writes: [{ ...elsewhere, file: path.join(config.home, '.ssh', 'config') }] }),
  )
  assert.equal(outside.outcome, 'refused')
  assert.match(outside.reason ?? '', /is not one of the paths codex:user declares/)

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

test('a target that resolves through a symlink is refused, and nothing outside it is written', () => {
  const config = fixture()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-outside-'))
  const real = path.join(elsewhere, 'config.toml')
  fs.writeFileSync(real, '# somebody else\'s file\n')
  fs.symlinkSync(real, codexFile(config))
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  const result = applyPlan(config, planned)

  assert.equal(result.outcome, 'refused')
  assert.match(result.reason ?? '', /resolves through a symlink/)
  assert.deepEqual(result.landed, [])
  assert.equal(fs.readFileSync(real, 'utf8'), "# somebody else's file\n")
})

test('a read-only target is refused before a byte of it is written', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena' } })
  discover(config)

  const planned = plan(config, 'serena', 'codex:user')
  fs.chmodSync(codexFile(config), 0o444)
  const result = applyPlan(config, planned)
  fs.chmodSync(codexFile(config), 0o644)

  assert.equal(result.outcome, 'refused')
  assert.match(result.reason ?? '', /read-only/)
  assert.equal(fs.readFileSync(codexFile(config), 'utf8'), '# empty codex config\n')
})

test('verify refuses a document whose assertions name a path the tier does not declare', () => {
  const config = fixture()
  codexFile_(config, '# empty codex config\n')
  piServers(config, { serena: { command: 'serena' } })
  discover(config)
  const aws = path.join(config.home, '.aws')
  fs.mkdirSync(aws, { recursive: true })
  const credentials = path.join(aws, 'credentials.json')
  fs.writeFileSync(credentials, '{"aws_secret_access_key":"abc123"}')

  const planned = plan(config, 'serena', 'codex:user')
  const sneaky = resign(planned, {
    verify: { asserts: [{ file: credentials, pointer: 'aws_secret_access_key', equals: 'abc123' }] },
  })
  const result = verifyPlanDocument(config, sneaky)

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /not one of the paths/)
  assert.doesNotMatch(JSON.stringify(result), /abc123/)
})
