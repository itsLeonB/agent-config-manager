import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digestOfBytes } from './digest.ts'
import { verifyPlan } from './apply.ts'
import { createAdapters } from './adapters/registry.ts'
import type { EngineConfig } from './config.ts'
import type { MirrorPlan, PlanValue } from './plan.ts'
import { applyPlan, discover, listInstallations, planMirror } from './service.ts'

// A fixture home, a fixture project, and a temporary database: the whole environment these tests
// need. The hooks locations are the real ones, under the fixture home.
function fixture(): EngineConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-hooks-test-'))
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

function hooksFile(config: EngineConfig, where: 'codex-user' | 'codex-project' | 'pi-user' | 'pi-project'): string {
  if (where === 'codex-user') return path.join(config.home, '.codex', 'hooks.json')
  if (where === 'codex-project') return path.join(config.projectRoot, '.codex', 'hooks.json')
  if (where === 'pi-user') return path.join(config.home, '.pi', 'agent', 'hooks.json')
  return path.join(config.projectRoot, '.pi', 'hooks.json')
}

interface CodexHook {
  event: string
  matcher?: string
  command: string
  timeout?: number
}

interface CodexHandlerFixture {
  type: 'command'
  command: string
  timeout?: number
}

interface CodexGroupFixture {
  matcher?: string
  hooks: CodexHandlerFixture[]
}

interface CodexHooksDocument {
  hooks: Record<string, CodexGroupFixture[]>
}

// A Codex hooks file in its own three-level form: event → matcher group → handlers.
function writeCodexHooks(config: EngineConfig, hooks: CodexHook[]): string {
  const file = hooksFile(config, 'codex-user')
  const grouped = new Map<string, CodexGroupFixture[]>()
  for (const hook of hooks) {
    const handler: CodexHandlerFixture = { type: 'command', command: hook.command }
    if (hook.timeout !== undefined) handler.timeout = hook.timeout
    const group: CodexGroupFixture = { hooks: [handler] }
    if (hook.matcher !== undefined) group.matcher = hook.matcher
    grouped.set(hook.event, [...(grouped.get(hook.event) ?? []), group])
  }
  const document: CodexHooksDocument = { hooks: Object.fromEntries(grouped) }
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`)
  return file
}

interface PiEntryFixture {
  command: string
  timeout?: number
}

interface PiHooksDocument {
  hooks: Record<string, (PiEntryFixture | string)[]>
}

// Pi's bridge reads a flat list per event, where one entry is one command.
function writePiHooks(config: EngineConfig, event: string, entries: (PiEntryFixture | string)[]): string {
  const file = hooksFile(config, 'pi-user')
  const document: PiHooksDocument = { hooks: { [event]: entries } }
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`)
  return file
}

function hookPlan(
  config: EngineConfig,
  nativeFile: string,
  target: string,
  nativePointer?: string,
): MirrorPlan {
  const row = listInstallations(config, { category: 'hooks' }).installations.find(
    (candidate) =>
      candidate.nativeFile === nativeFile &&
      (nativePointer === undefined || candidate.nativePointer === nativePointer),
  )
  assert.ok(row, `nothing discovered at ${nativeFile}`)
  const result = planMirror(config, row.id, target)
  assert.equal(result.kind, 'plan', result.kind === 'refused' ? result.reason : '')
  return result.kind === 'plan' ? result.plan : assert.fail('unreachable')
}

function stepsOf(plan: MirrorPlan): string {
  return plan.manualSteps.map((step) => `${step.step} ${step.why}`).join('\n')
}

// Puts a plan's own writes on disk the way apply would, so verification is asked about a target that
// really holds them: the point of the executable flag is that even then it cannot read as verified.
function land(planned: MirrorPlan): void {
  for (const write of planned.writes) {
    if (write.op === 'writeFile') {
      fs.mkdirSync(path.dirname(write.file), { recursive: true })
      fs.writeFileSync(write.file, write.content)
      continue
    }
    if (write.op !== 'writeAtPointer') continue
    const document: Record<string, PlanValue> = {}
    const segments = write.pointer.split('.')
    let node = document
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        node[segment] = write.value
        return
      }
      const child: Record<string, PlanValue> = {}
      node[segment] = child
      node = child
    })
    fs.writeFileSync(write.file, `${JSON.stringify(document, null, 2)}\n`)
  }
}

test('a Codex hook lands as a pointer write into native hook config, with enablement and trust as steps', () => {
  const config = fixture()
  const source = writeCodexHooks(config, [
    { event: 'PreToolUse', matcher: '*', command: 'serena-hooks remind --client=codex', timeout: 5 },
  ])
  discover(config)

  const planned = hookPlan(config, source, 'codex:project')

  assert.equal(planned.category, 'hooks')
  assert.equal(planned.writes.length, 1)
  const [write] = planned.writes
  assert.ok(write !== undefined && write.op === 'writeAtPointer')
  assert.equal(write.file, hooksFile(config, 'codex-project'))
  assert.equal(write.pointer, 'hooks.PreToolUse')
  // The target's own three-level form, the source's timeout in the unit Codex reads.
  assert.deepEqual(write.value, [
    { matcher: '*', hooks: [{ type: 'command', command: 'serena-hooks remind --client=codex', timeout: 5 }] },
  ])
  // The event was renamed, so it is a mapping and not a carried field.
  assert.deepEqual(planned.equivalence.mapped, [
    { transform: 'rename', fields: ['event'], targetField: 'PreToolUse' },
  ])
  // The two switches only a human can throw.
  const steps = stepsOf(planned)
  assert.match(steps, /\[features\] hooks = true/)
  assert.match(steps, /\/hooks/)
  assert.equal(planned.permissions.trust, 'required')
  // A command runs at harness runtime, so the write is executable and the plan is risky.
  assert.equal(write.executable, true)
  assert.equal(planned.security.grade, 'risky')
  assert.deepEqual(planned.security.executables, [
    { file: hooksFile(config, 'codex-project'), why: 'the hook runs a command at harness runtime' },
  ])

  // A client that cannot ask a human hands an executable write back rather than performing it.
  const applied = applyPlan(config, planned)
  assert.equal(applied.outcome, 'refused')
  assert.match(applied.reason ?? '', /human's own answer/)
  assert.deepEqual(applied.landed, [])
  assert.equal(fs.existsSync(hooksFile(config, 'codex-project')), false)
})

test('a Pi hook lands as a pointer write, with the bridge install and a restart as steps', () => {
  const config = fixture()
  const source = writeCodexHooks(config, [
    { event: 'PreToolUse', command: 'serena-hooks remind --client=codex', timeout: 5 },
  ])
  discover(config)

  const planned = hookPlan(config, source, 'pi:project')

  assert.equal(planned.writes.length, 1)
  const [write] = planned.writes
  assert.ok(write !== undefined && write.op === 'writeAtPointer')
  assert.equal(write.file, hooksFile(config, 'pi-project'))
  // The event is the bridge's own name, and its list holds one command per entry.
  assert.equal(write.pointer, 'hooks.tool_call')
  assert.deepEqual(write.value, [{ command: 'serena-hooks remind --client=codex', timeout: 5000 }])
  assert.deepEqual(planned.equivalence.mapped, [
    { transform: 'rename', fields: ['event'], targetField: 'tool_call' },
    { transform: 'unit', fields: ['handlers.timeout'], targetField: 'timeout' },
  ])
  const steps = stepsOf(planned)
  assert.match(steps, /pi install npm:@vahor\/pi-hooks/)
  assert.match(steps, /restart Pi/)
  // Pi gates its own project config behind a trust decision, and hooks.json is that config.
  assert.equal(planned.permissions.trust, 'required')
  assert.match(steps, /trust this project in Pi/)
})

test('a Codex hook targeting OpenCode lands as generated plugin code, executable and never verified', () => {
  const config = fixture()
  const source = writeCodexHooks(config, [
    { event: 'PreToolUse', command: 'serena-hooks remind --client=codex', timeout: 5 },
  ])
  discover(config)

  const planned = hookPlan(config, source, 'oc:project')

  assert.equal(planned.writes.length, 1)
  const [write] = planned.writes
  assert.ok(write !== undefined && write.op === 'writeFile')
  assert.equal(write.file, path.join(config.projectRoot, '.opencode', 'plugins', 'acm-codex-pre-tool-use.ts'))
  // The event became a plugin hook, and the command it runs is in the generated module.
  assert.match(write.content, /await ctx\.tool\.hook\("execute\.before"/)
  assert.match(write.content, /serena-hooks remind --client=codex/)
  assert.equal(write.executable, true)
  assert.equal(planned.security.grade, 'risky')
  assert.match(stepsOf(planned), /restart OpenCode/)
  // The assertion is the module's own digest, and the module can never read as verified even once
  // every assertion holds.
  assert.deepEqual(planned.verify.asserts, [
    { file: write.file, digest: digestOfBytes(Buffer.from(write.content, 'utf8')) },
  ])
  land(planned)
  const verification = verifyPlan(planned)
  assert.ok(verification.asserts.every((assertion) => assertion.holds))
  assert.equal(verification.outcome, 'unverified')
})

test('a generated module registers the callback OpenCode documents for that hook', () => {
  const config = fixture()
  const source = writeCodexHooks(config, [
    { event: 'PreToolUse', command: 'serena-hooks remind' },
    { event: 'PreModelRequest', command: 'serena-hooks plan-context' },
  ])
  discover(config)

  // A tool hook observes the call; the command's output cannot change it, so the callback is a call.
  const tool = hookPlan(config, source, 'oc:project', 'hooks.PreToolUse.0')
  const [toolWrite] = tool.writes
  assert.ok(toolWrite !== undefined && toolWrite.op === 'writeFile')
  assert.match(toolWrite.content, /ctx\.tool\.hook\("execute\.before", \(\) => \{/)

  // The context hook owns the request's own parts, so the command's output becomes one of them.
  const context = hookPlan(config, source, 'oc:project', 'hooks.PreModelRequest.0')
  const [contextWrite] = context.writes
  assert.ok(contextWrite !== undefined && contextWrite.op === 'writeFile')
  assert.match(contextWrite.content, /ctx\.session\.hook\("context", \(event\) => \{/)
  assert.match(contextWrite.content, /event\.system\.push\(\{ type: 'text', text: execSync\(command, \{ timeout, encoding: 'utf8' \}\) \}\)/)
})

test('event names are mapped per target, and an unmapped event is a gap with no write', () => {
  const config = fixture()
  const source = writeCodexHooks(config, [{ event: 'SubagentStop', command: 'serena-hooks reset' }])
  discover(config)

  const planned = hookPlan(config, source, 'pi:user')

  assert.deepEqual(planned.writes, [])
  assert.deepEqual(planned.equivalence.gaps, [
    { field: 'event', reason: 'fieldAbsent', replacement: 'dropped' },
  ])
  assert.match(stepsOf(planned), /author this SubagentStop hook in pi by hand/)
  assert.equal(verifyPlan(planned).outcome, 'unverified')

  // And the table works the other way: a Pi event name reaches Codex's own.
  const piSource = writePiHooks(config, 'tool_call', [{ command: 'serena-hooks remind', timeout: 5000 }])
  discover(config)
  const toCodex = hookPlan(config, piSource, 'codex:user')
  const [write] = toCodex.writes
  assert.ok(write !== undefined && write.op === 'writeAtPointer')
  assert.equal(write.pointer, 'hooks.PreToolUse')
  assert.deepEqual(write.value, [
    { hooks: [{ type: 'command', command: 'serena-hooks remind', timeout: 5 }] },
  ])
})

test('a non-wildcard matcher is its own gap rather than a silently broadened hook', () => {
  const config = fixture()
  const source = writeCodexHooks(config, [
    { event: 'PreToolUse', matcher: 'Bash', command: 'serena-hooks remind' },
  ])
  discover(config)

  for (const target of ['pi:user', 'oc:project']) {
    const planned = hookPlan(config, source, target)
    assert.deepEqual(planned.writes, [], target)
    assert.deepEqual(planned.equivalence.gaps, [
      { field: 'matcher', reason: 'fieldAbsent', replacement: 'dropped' },
    ])
    assert.match(stepsOf(planned), /"Bash" by hand/)
  }
})

test('OpenCode is a hook target but never a hook source', () => {
  const adapters = createAdapters(fixture())

  const opencode = adapters.find((adapter) => adapter.harness === 'opencode')
  assert.ok(opencode)
  assert.equal(opencode.claimedCategories.includes('hooks'), false)
  assert.equal(opencode.handlers.hooks, undefined)
  // A target all the same: the write surface is what the planner branches on.
  assert.equal(opencode.hookWrite?.kind, 'generated')

  for (const harness of ['pi', 'codex']) {
    const adapter = adapters.find((candidate) => candidate.harness === harness)
    assert.ok(adapter)
    assert.equal(adapter.claimedCategories.includes('hooks'), true)
    assert.equal(adapter.hookWrite?.kind, 'pointer')
  }
})

test('a plan carrying a command or generated code lands unverified, its assertions aside', () => {
  const config = fixture()
  const source = writeCodexHooks(config, [{ event: 'PreToolUse', command: 'serena-hooks remind' }])
  discover(config)

  for (const target of ['codex:user', 'pi:project', 'oc:user']) {
    const planned = hookPlan(config, source, target)
    land(planned)
    const verification = verifyPlan(planned)
    assert.ok(verification.asserts.every((assertion) => assertion.holds), target)
    assert.equal(verification.outcome, 'unverified', target)
  }
})

test('a hook whose command carries a credential is a gap, and nothing is written', () => {
  const config = fixture()
  const source = writeCodexHooks(config, [
    { event: 'PreToolUse', command: 'curl -H "Authorization: Bearer ghp_012345678901234567890123456789012345"' },
  ])
  discover(config)

  const planned = hookPlan(config, source, 'pi:user')

  assert.deepEqual(planned.writes, [])
  assert.deepEqual(planned.equivalence.gaps, [
    { field: 'handlers.0.command', reason: 'credential', replacement: 'dropped' },
  ])
  assert.deepEqual(planned.security.secrets, [{ pointer: 'handlers.0.command', verdict: 'secret' }])
})
