import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import type { Adapter } from './adapters/types.ts'
import { pointerSegments } from './adapters/mcp-facts.ts'
import type { EngineConfig } from './config.ts'
import { formatOf, parses, writePointer } from './edit.ts'
import { z } from 'zod'
import {
  canonicalJson,
  readPointer,
  type MirrorPlan,
  type PlanManualStep,
  type PlanValue,
  type PlanWrite,
} from './plan.ts'

export type ApplyOutcome = 'applied' | 'partial' | 'refused' | 'stale' | 'busy'

// One write that reached disk, with the digest of the file it reached it in, so a caller can see
// what landed without re-reading every target itself.
export interface LandedWrite {
  file: string
  pointer: string
  digest: string
}

export interface FailedWrite {
  file: string
  pointer: string
  reason: string
}

export type VerifyOutcome = 'verified' | 'unverified' | 'failed'

export interface AssertResult {
  file: string
  pointer: string
  expected: PlanValue
  actual: PlanValue | null
  holds: boolean
}

export interface VerifyResult {
  outcome: VerifyOutcome
  asserts: AssertResult[]
  // Reported verbatim: a caller has to be able to hand them to a human unchanged.
  manualSteps: PlanManualStep[]
}

export interface ApplyResult {
  outcome: ApplyOutcome
  // Null when no document was accepted, so nothing can name a plan that never validated.
  planId: string | null
  reason: string | null
  landed: LandedWrite[]
  failed: FailedWrite | null
  verification: VerifyResult | null
  manualSteps: PlanManualStep[]
}

// A plan is verified by re-reading the files it asserted, never by asking a harness: an executable
// write and any pending manual step both mean the result cannot claim more than `unverified`.
export function verifyPlan(plan: MirrorPlan): VerifyResult {
  const asserts = plan.verify.asserts.map((assert): AssertResult => {
    const read = readPointer(assert.file, assert.pointer)
    const actual = read.kind === 'ok' ? (read.value ?? null) : null
    const holds =
      read.kind === 'ok' &&
      read.value !== undefined &&
      canonicalJson(read.value) === canonicalJson(assert.equals)
    return { file: assert.file, pointer: assert.pointer, expected: assert.equals, actual, holds }
  })
  const pending = plan.manualSteps.length > 0 || plan.writes.some((write) => write.executable)
  return {
    outcome: asserts.some((assert) => !assert.holds)
      ? 'failed'
      : pending
        ? 'unverified'
        : 'verified',
    asserts,
    manualSteps: plan.manualSteps,
  }
}

// Executes exactly the given writes: the plan is never re-derived, so what lands is what was
// approved. Every refusal happens before the first byte.
export function executePlan(
  config: EngineConfig,
  adapters: readonly Adapter[],
  plan: MirrorPlan,
): ApplyResult {
  const refusal = (outcome: ApplyOutcome, reason: string): ApplyResult => ({
    outcome,
    planId: plan.planId,
    reason,
    landed: [],
    failed: null,
    verification: null,
    manualSteps: plan.manualSteps,
  })
  const owned = adapters
    .flatMap((adapter) => adapter.tiers.map((tier) => ({ harness: adapter.harness, tier })))
    .find((entry) => entry.tier.id === plan.target.tierId)
  if (owned === undefined) return refusal('refused', `${plan.target.tierId} is not a declared tier`)
  if (owned.harness !== plan.target.harness) {
    return refusal('refused', `${plan.target.tierId} belongs to ${owned.harness}, not ${plan.target.harness}`)
  }
  if (owned.tier.writability !== 'writable') {
    return refusal('refused', `${owned.tier.id} is ${owned.tier.writability}: a mirror target must be writable`)
  }
  // Containment, in one rule: a write may only reach a path the target tier declares. Nothing else
  // is reachable, so no credential store or symlinked directory is even an option.
  const outside = plan.writes.find((write) => !owned.tier.configPaths.includes(write.file))
  if (outside !== undefined) {
    return refusal('refused', `${outside.file} is not a path ${owned.tier.id} declares`)
  }
  const lock = acquireLock(config.storePath)
  if (lock === null) return refusal('busy', 'another apply is in flight for this store')
  try {
    const stale = staleCondition(plan)
    if (stale !== null) return refusal('stale', stale)
    const { landed, failed } = landWrites(plan)
    const verification = verifyPlan(plan)
    return {
      outcome: failed === null ? 'applied' : 'partial',
      planId: plan.planId,
      reason: failed === null ? null : `writing ${failed.pointer} failed; the writes before it were left in place`,
      landed,
      failed,
      // A run that stopped short cannot claim the target is verified, however many of its own
      // assertions happen to hold.
      verification: failed === null ? verification : { ...verification, outcome: 'failed' },
      manualSteps: plan.manualSteps,
    }
  } finally {
    lock()
  }
}

// Every target is read once, before the first write: a file someone else edited since planning
// makes the whole plan stale, and a stale plan writes nothing at all.
function staleCondition(plan: MirrorPlan): string | null {
  const checked = new Set<string>()
  for (const write of plan.writes) {
    if (checked.has(write.file)) continue
    checked.add(write.file)
    const present = existsSync(write.file)
    if (present !== write.precondition.exists) {
      return `${write.file} ${present ? 'appeared' : 'is gone'} since the plan was built`
    }
    if (!present) continue
    const digest = digestOf(readFileSync(write.file))
    if (digest !== write.precondition.digest) {
      return `${write.file} changed since the plan was built`
    }
  }
  return null
}

interface Landed {
  landed: LandedWrite[]
  failed: FailedWrite | null
}

// One file at a time, one write at a time. A failure stops the run and leaves everything already
// written where it is — rollback is described on the write, never performed.
function landWrites(plan: MirrorPlan): Landed {
  const landed: LandedWrite[] = []
  const byFile = new Map<string, PlanWrite[]>()
  for (const write of plan.writes) {
    byFile.set(write.file, [...(byFile.get(write.file) ?? []), write])
  }
  for (const [file, writes] of byFile) {
    const format = formatOf(file)
    // A target that does not exist yet starts from an empty document of its own format, so the first
    // write creates it the same way the last one extends an existing file.
    let text = existsSync(file) ? readFileSync(file, 'utf8') : format === 'toml' ? '' : EMPTY_JSON
    let failure: FailedWrite | null = null
    let applied = 0
    for (const write of writes) {
      const result = writePointer(text, format, pointerSegments(write.pointer), write.value)
      if (result.kind === 'failed') {
        failure = { file, pointer: write.pointer, reason: result.reason }
        break
      }
      if (!parses(result.text, format)) {
        failure = { file, pointer: write.pointer, reason: 'the edited file would not parse' }
        break
      }
      text = result.text
      applied += 1
    }
    // Only what was actually addressed is written: a file whose every write failed is not touched.
    if (applied > 0) {
      writeFileSync(file, text)
      const digest = digestOf(readFileSync(file))
      for (const write of writes.slice(0, applied)) landed.push({ file, pointer: write.pointer, digest })
    }
    if (failure !== null) return { landed, failed: failure }
  }
  return { landed, failed: null }
}

// A new target starts as an empty document that already reads as pretty-printed, so the whole
// subtree the plan creates lands indented instead of on one long line.
const EMPTY_JSON = '{\n}\n'

export function digestOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

const lockRecord = z.object({ pid: z.number(), at: z.string() })

// One in-flight apply per store, across processes: an exclusive create is the mutual exclusion, and
// a lock whose owner is gone is broken instead of wedging apply forever.
function acquireLock(storePath: string): (() => void) | null {
  const lockPath = `${storePath}.apply.lock`
  mkdirSync(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      closeSync(fd)
      return () => rmSync(lockPath, { force: true })
    } catch {
      if (attempt === 0 && !ownerAlive(lockPath)) {
        rmSync(lockPath, { force: true })
        continue
      }
      return null
    }
  }
  return null
}

function ownerAlive(lockPath: string): boolean {
  let holder: z.infer<typeof lockRecord>
  try {
    const parsed = lockRecord.safeParse(JSON.parse(readFileSync(lockPath, 'utf8')))
    // A lock nobody can read is not one worth waiting for.
    if (!parsed.success) return false
    holder = parsed.data
  } catch {
    return false
  }
  try {
    process.kill(holder.pid, 0)
    return true
  } catch (error) {
    // ESRCH: the process is gone. Anything else (EPERM) means it exists and is not ours.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}
