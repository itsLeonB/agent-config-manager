import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import {
  declaresWritePath,
  writePaths,
  type Adapter,
  type HarnessId,
  type Tier,
} from './adapters/types.ts'
import { pointerSegments } from './adapters/mcp-facts.ts'
import type { EngineConfig } from './config.ts'
import { digestOfPath } from './digest.ts'
import { formatOf, parses, writePointer } from './edit.ts'
import { z } from 'zod'
import {
  canonicalJson,
  planGrade,
  readPointer,
  type RiskCondition,
  type MirrorPlan,
  type PlanManualStep,
  type PlanValue,
  type PlanWrite,
} from './plan.ts'

type PointerWrite = Extract<PlanWrite, { op: 'writeAtPointer' }>
type WholeWrite = Exclude<PlanWrite, { op: 'writeAtPointer' }>

export type ApplyOutcome = 'applied' | 'partial' | 'refused' | 'stale' | 'busy' | 'declined'

// What authorised this apply. `client-policy` is the harness's own permission configuration; the
// engine never records consent it did not obtain. A human's own answer (`elicitation`) arrives with
// the MCP surface, because only a client can render that dialog.
export type ConsentBasis = 'client-policy' | 'elicitation'

export interface ApplyOptions {
  // Overwriting a value a human already wrote at the same address is a named act, never the default.
  onConflict?: 'abort' | 'replace'
  // A human's own answer, obtained through the client's own dialog. Only the MCP face can set it:
  // no flag, environment variable, or stored approval reaches this.
  consent?: 'elicitation'
}

// One write that reached disk, with the digest of the file it reached it in, so a caller can see
// what landed without re-reading every target itself. `pointer` is null for a whole-file write.
export interface LandedWrite {
  file: string
  pointer: string | null
  digest: string
}

export interface FailedWrite {
  file: string
  pointer: string | null
  reason: string
}

export type VerifyOutcome = 'verified' | 'unverified' | 'failed'

export interface AssertResult {
  file: string
  // Null for a whole-file or whole-directory assertion, which has no address inside the file.
  pointer: string | null
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
  // The grade apply itself computed, which is the stricter of the document's own and its facts.
  grade: 'safe' | 'risky' | null
  consent: ConsentBasis | null
  landed: LandedWrite[]
  failed: FailedWrite | null
  verification: VerifyResult | null
  manualSteps: PlanManualStep[]
}

// A plan is verified by re-reading the files it asserted, never by asking a harness: an executable
// write and any pending manual step both mean the result cannot claim more than `unverified`. A
// whole-file or whole-directory assertion is its digest, which is how a copied skill is checked
// without copying it back.
export function verifyPlan(plan: MirrorPlan): VerifyResult {
  const asserts = plan.verify.asserts.map((assert): AssertResult => {
    if ('digest' in assert) {
      const actual = digestOfPath(assert.file)
      return {
        file: assert.file,
        pointer: null,
        expected: assert.digest,
        actual,
        holds: actual === assert.digest,
      }
    }
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

// Executes exactly the given writes: they are never re-derived, so what lands is what was approved.
// The grade is re-computed rather than trusted. Every refusal happens before the first byte.
export function executePlan(
  config: EngineConfig,
  adapters: readonly Adapter[],
  plan: MirrorPlan,
  options: ApplyOptions = {},
): ApplyResult {
  // A document is self-addressed and `planIdOf` is public, so the grade on it is a claim: the gate is
  // computed here, from the writes about to be performed, and the stricter of the two wins.
  const { grade, gated: flagged } = planGate(plan)
  const refusal = (outcome: ApplyOutcome, reason: string, steps = plan.manualSteps): ApplyResult => ({
    outcome,
    planId: plan.planId,
    reason,
    grade,
    // A refusal is not an authorisation, whatever it refuses for.
    consent: null,
    landed: [],
    failed: null,
    verification: null,
    manualSteps: steps,
  })
  const owned = ownedTier(adapters, plan)
  if (owned === undefined) return refusal('refused', `${plan.target.tierId} is not a declared tier`)
  if (owned.harness !== plan.target.harness) {
    return refusal('refused', `${plan.target.tierId} belongs to ${owned.harness}, not ${plan.target.harness}`)
  }
  if (owned.tier.writability !== 'writable') {
    return refusal('refused', `${owned.tier.id} is ${owned.tier.writability}: a mirror target must be writable`)
  }
  // Preflight every address before the first byte: containment, then whether the file can be
  // written at all. An unwritable target is refused here rather than discovered half way through.
  const fault =
    containmentFault(config, adapters, plan) ?? mixedOpsFault(plan) ?? preflightFault(plan)
  if (fault !== null) return refusal('refused', fault)
  // A write flagged executable, secret-bearing, or irreversible needs a human's own answer. Without
  // one those writes become manual steps; with one (`consent: elicitation`) they land.
  const gated = options.consent === 'elicitation' ? [] : flagged
  const safe = options.consent === 'elicitation' ? plan.writes : plan.writes.filter((write) => !isGated(write))
  const steps = [...plan.manualSteps, ...gated.map(gatedStep)]
  // Nothing in this plan can land without an answer nobody gave, so it is refused with the steps
  // rather than reported as applied with an empty landed set.
  if (plan.writes.length > 0 && safe.length === 0) {
    return refusal(
      'refused',
      `every write in this plan needs a human's own answer (${gated.map(writeAddress).join(', ')}) and this client cannot ask for one; nothing was written and they are returned as manual steps`,
      steps,
    )
  }
  const effective: MirrorPlan =
    gated.length === 0
      ? plan
      : {
          ...plan,
          writes: safe,
          manualSteps: steps,
          // Only the writes that can land are asserted: an assertion on a gated write would report a
          // verified target as failed.
          verify: {
            asserts: plan.verify.asserts.filter((assertion) =>
              safe.some(
                (write) =>
                  write.file === assertion.file &&
                  writeAddress(write) === ('pointer' in assertion ? assertion.pointer : null),
              ),
            ),
          },
        }
  const lock = acquireLock(config.storePath)
  if (lock === null) return refusal('busy', 'another apply is in flight for this store')
  try {
    const stale = staleCondition(effective)
    if (stale !== null) return refusal('stale', stale)
    // A differing target is a conflict until the caller names replacement: both values are shown, so
    // nothing on disk is overwritten silently. It runs after the digests, because what a human reads
    // here is the current value, not the planning-time one.
    if (effective.conflicts.length > 0 && options.onConflict !== 'replace') {
      const shown = effective.conflicts
        .map(
          (conflict) =>
            `${conflict.pointer}: ${JSON.stringify(conflict.current)} holds now, this plan would write ${JSON.stringify(conflict.proposed)}`,
        )
        .join('; ')
      return refusal(
        'refused',
        `${effective.conflicts.length} value(s) in ${plan.target.nativeLocation} disagree with this plan (${shown}); nothing was written, pass onConflict: replace to overwrite them`,
      )
    }
    // A conflict no write answers cannot be replaced: this slice has no op that removes what is
    // there, so reporting success would claim a replacement that never happened.
    const unanswered = effective.conflicts.filter(
      (conflict) => !effective.writes.some((write) => write.file === conflict.file),
    )
    if (unanswered.length > 0) {
      return refusal(
        'refused',
        `${unanswered.map((conflict) => conflict.file).join(', ')} already holds something this plan does not write, so replacing it is not an op: remove it by hand and plan again`,
      )
    }
    const { landed, failed } = landWrites(effective)
    const verification = verifyPlan(effective)
    return {
      outcome: failed === null ? 'applied' : 'partial',
      planId: plan.planId,
      reason: failed === null ? null : `writing ${failed.pointer} failed; the writes before it were left in place`,
      grade,
      consent: options.consent ?? 'client-policy',
      landed,
      failed,
      // A run that stopped short cannot claim the target is verified, however many of its own
      // assertions happen to hold.
      verification: failed === null ? verification : { ...verification, outcome: 'failed' },
      manualSteps: effective.manualSteps,
    }
  } finally {
    lock()
  }
}

// The grade a document really carries, and the writes that need a human's own answer: one table, so
// apply and the MCP face which asks the human cannot disagree about what the dialog is for.
// A conflict is gated separately, by `onConflict`. File ops are performed here and graded risky, so
// a client that can ask a human still asks; `runCommand` is the op the engine refuses.
export function planGate(plan: MirrorPlan) {
  return {
    grade: planGrade(plan) === 'risky' || plan.security.grade === 'risky' ? 'risky' : 'safe',
    gated: plan.writes.filter(isGated),
  } satisfies { grade: 'safe' | 'risky'; gated: PlanWrite[] }
}

function isGated(write: PlanWrite): boolean {
  return write.executable || write.secretValues || write.irreversible
}

// What a human is handed: a pointer for an addressed write, and the file itself for a whole-file one.
export function writeAddress(write: PlanWrite): string | null {
  return write.op === 'writeAtPointer' ? write.pointer : null
}

// The flags a human is asked about, in the order the dialog shows them.
export const CONSENT_FLAGS = ['executable', 'secretValues', 'irreversible'] as const

export type ConsentFlag = (typeof CONSENT_FLAGS)[number]

// Why this write needs a human's own answer.
export function writeFlags(write: PlanWrite): ConsentFlag[] {
  return CONSENT_FLAGS.filter((flag) => write[flag])
}

// A gated write is handed to the human as an address, never as its value: a withheld one is a marker,
// and the rest is what they asked the engine to do in the first place.
const RISK_FLAG_WORDS = {
  executable: 'runs a command at harness runtime',
  secretValues: 'carries a credential value',
  irreversible: 'cannot be undone',
  copyFile: 'copies a file',
  symlink: 'creates a link',
  runCommand: 'runs a command',
  newTargetFile: 'creates its target file',
  conflict: 'overwrites a value',
  elevation: 'needs elevation',
} satisfies Record<RiskCondition, string>

function gatedStep(write: PlanWrite): PlanManualStep {
  return {
    step: `write ${write.op === 'writeAtPointer' ? write.pointer : write.file} in place by hand`,
    why: `this write ${writeFlags(write)
      .map((flag) => RISK_FLAG_WORDS[flag])
      .join(' and ')}: it needs a human's own answer, and nothing was written`,
  }
}

// Where a plan may point, for the files it writes and the files it asserts alike: a credential
// location, a symlink on the way to one, or a path outside the engine's own roots is never a mirror
// target, however the plan describes it.
const CREDENTIAL_LOCATIONS = ['.ssh', '.gnupg', '.aws', path.join('.config', 'gh')]

export function containmentFault(
  config: EngineConfig,
  adapters: readonly Adapter[],
  plan: MirrorPlan,
): string | null {
  const owned = ownedTier(adapters, plan)
  if (owned === undefined) {
    return `${plan.target.tierId} is not a tier ${plan.target.harness} declares`
  }
  // Two writes name a final component that is not a regular file on purpose: a link (which
  // verification resolves), and a copied directory (which is what a skill is). Every other path is
  // held to the same rule.
  const linked = new Set(
    plan.writes.filter((write) => write.op === 'symlink').map((write) => write.file),
  )
  const copied = new Set(
    plan.writes.filter((write) => write.op === 'copyFile').map((write) => write.file),
  )
  const files = new Set([
    ...plan.writes.map((write) => write.file),
    ...plan.verify.asserts.map((assert) => assert.file),
  ])
  for (const file of files) {
    if (!declaresWritePath(owned.tier, plan.category, file)) {
      const declared = writePaths(owned.tier, plan.category).join(', ') || 'nothing'
      return `${file} is not one of the paths ${owned.tier.id} declares for ${plan.category} (${declared})`
    }
    const fault = pathFault(config, file, linked.has(file), copied.has(file))
    if (fault !== null) return fault
  }
  // A copy reads bytes from somewhere too, and a plan is the only thing that names where. The source
  // is judged where it really is, not where its path claims to be: a link is the one way a declared
  // path can stand for a file somewhere else.
  for (const write of plan.writes) {
    if (write.op !== 'copyFile' && write.op !== 'symlink') continue
    let source: string
    try {
      source = realpathSync(write.source)
    } catch {
      return `${write.source} cannot be resolved, so what this plan would copy is unknown`
    }
    const fault = rootFault(config, source)
    if (fault !== null) return fault
    // A copied tree keeps its links, so each one is a path this mirror would put on disk: it has to
    // be held to the same rule as the write that carries it.
    if (write.op === 'copyFile') {
      const inside = treeFault(config, source)
      if (inside !== null) return inside
    }
  }
  return null
}

// Every link inside a directory a plan copies, resolved and held to the roots. A link to a directory
// is not followed: a copy reproduces the link, not the tree beyond it.
function treeFault(config: EngineConfig, dir: string, chain = new Set<string>()): string | null {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return `${dir} cannot be resolved, so what this plan would copy is unknown`
  }
  if (chain.has(real)) return null
  const next = new Set(chain).add(real)
  let entries
  try {
    entries = readdirSync(real, { withFileTypes: true })
  } catch {
    return `${dir} cannot be listed, so what this plan would copy is unknown`
  }
  for (const entry of entries) {
    const child = path.join(real, entry.name)
    if (entry.isSymbolicLink()) {
      let resolved: string
      try {
        resolved = realpathSync(child)
      } catch {
        return `${child} cannot be resolved, so what this plan would copy is unknown`
      }
      const fault = rootFault(config, resolved)
      if (fault !== null) return `${child} links to ${resolved}, and ${fault}`
      continue
    }
    if (!entry.isDirectory()) continue
    const fault = treeFault(config, child, next)
    if (fault !== null) return fault
  }
  return null
}

export function ownedTier(
  adapters: readonly Adapter[],
  plan: MirrorPlan,
): { harness: HarnessId; tier: Tier } | undefined {
  return adapters
    .flatMap((adapter) => adapter.tiers.map((tier) => ({ harness: adapter.harness, tier })))
    .find((entry) => entry.tier.id === plan.target.tierId)
}

// Spec §5's checks for one path, in order: inside a root, not a credential location, no symlink
// anywhere on the way to it, and a regular file if it already exists.
function pathFault(
  config: EngineConfig,
  file: string,
  allowFinalSymlink: boolean,
  allowFinalDirectory: boolean,
): string | null {
  const lexical = path.resolve(file)
  const fault = rootFault(config, lexical)
  if (fault !== null) return fault
  // `lstat`, not `exists`: a dangling symlink is a way out of the path it appears to be.
  const existing = deepestExisting(lexical)
  let resolved: string
  try {
    resolved = realpathSync(existing)
  } catch {
    return `${existing} cannot be resolved, so ${file} has no trustworthy location`
  }
  const finalLink =
    allowFinalSymlink && existing === lexical && lstatSync(lexical).isSymbolicLink()
  if (resolved !== existing && !finalLink) {
    return `${existing} resolves through a symlink, so ${file} would land somewhere else`
  }
  if (finalLink) {
    const through = rootFault(config, resolved)
    return through === null ? null : `${file} links to ${resolved}, and ${through}`
  }
  if (existing !== lexical) return null
  if (allowFinalDirectory && lstatSync(lexical).isDirectory()) return null
  if (!lstatSync(lexical).isFile()) return `${file} is not a regular file`
  return null
}

// The two checks that apply to any path the engine touches: inside its own roots, and never a
// credential location. Where it points is checked separately.
function rootFault(config: EngineConfig, file: string): string | null {
  const lexical = path.resolve(file)
  const roots = [config.home, config.projectRoot].map((root) => path.resolve(root))
  if (!roots.some((root) => lexical === root || lexical.startsWith(`${root}${path.sep}`))) {
    return `${file} is outside the home directory and the project root`
  }
  // A credential location is refused by where it is, not by what its values look like.
  const fromHome = path.relative(path.resolve(config.home), lexical)
  const credential = CREDENTIAL_LOCATIONS.some(
    (location) => fromHome === location || fromHome.startsWith(`${location}${path.sep}`),
  )
  return credential ? `${file} is a credential location` : null
}

function deepestExisting(lexical: string): string {
  let candidate = lexical
  for (;;) {
    try {
      lstatSync(candidate)
      return candidate
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return candidate
      candidate = parent
    }
  }
}

// One file either takes several addressed leaves or one whole-file write: a plan that asks for both
// at one address is refused before its first byte, because no executor can honour both.
export function mixedOpsFault(plan: MirrorPlan): string | null {
  const byFile = new Map<string, PlanWrite['op']>()
  for (const write of plan.writes) {
    const seen = byFile.get(write.file)
    if (seen !== undefined && seen !== write.op) {
      return `${write.file} would be written two ways by one plan (${seen} and ${write.op}), which cannot be applied as one document`
    }
    byFile.set(write.file, write.op)
  }
  return null
}

// Whether the bytes could be written at all, asked before any of them are: a read-only target is
// refused up front instead of being discovered half way through a run. A target under a directory
// that does not exist yet is checked at the nearest ancestor that does, because a copy creates the
// path it needs.
export function preflightFault(plan: MirrorPlan): string | null {
  for (const file of new Set(plan.writes.map((write) => write.file))) {
    const existing = deepestExisting(file)
    const checked = existing === file ? file : existing
    try {
      accessSync(checked, constants.W_OK)
    } catch {
      return `${file} cannot be written: ${checked} is read-only`
    }
  }
  return null
}

// Every target is read once, before the first write: a file someone else edited since planning
// makes the whole plan stale, and a stale plan writes nothing at all. A copy names its source too,
// and that is the half that can be a credential — so it is checked by digest, never re-planned.
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
    const digest = digestOfPath(write.file)
    if (digest !== write.precondition.digest) {
      return `${write.file} changed since the plan was built`
    }
  }
  for (const write of plan.writes) {
    if (write.op !== 'copyFile' && write.op !== 'symlink') continue
    if (digestOfPath(write.source) !== write.sourceDigest) {
      return `${write.source} changed since the plan was built`
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
    const head = writes[0]
    if (head === undefined) continue
    const outcome =
      head.op === 'writeAtPointer'
        ? editPointers(
            file,
            writes.filter((write): write is PointerWrite => write.op === 'writeAtPointer'),
          )
        : writeWhole(file, head)
    landed.push(...outcome.landed)
    if (outcome.failed !== null) return { landed, failed: outcome.failed }
  }
  return { landed, failed: null }
}

// Several leaves in one file: each edit re-reads the document the previous one produced, and the
// edited text is re-parsed before the file is touched.
function editPointers(file: string, writes: PointerWrite[]): Landed {
  const landed: LandedWrite[] = []
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
    try {
      writeFileSync(file, text)
    } catch (caught) {
      // Preflight said this was writable, so this is a race, not a prediction: nothing of this file
      // landed, and the files before it stay where they are.
      return {
        landed,
        failed: {
          file,
          pointer: writes[0]?.pointer ?? '',
          reason: caught instanceof Error ? caught.message : 'the write failed',
        },
      }
    }
    const digest = digestOf(readFileSync(file))
    for (const write of writes.slice(0, applied)) landed.push({ file, pointer: write.pointer, digest })
  }
  return { landed, failed: failure }
}

// One whole file or directory. The bytes are the plan's own for `writeFile`, and the source's for a
// copy — re-read here, so a plan never carries them.
function writeWhole(file: string, write: WholeWrite): Landed {
  const landed: LandedWrite[] = []
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    if (write.op === 'writeFile') writeFileSync(file, write.content)
    else if (write.op === 'copyFile') {
      // The root is resolved, so a skill installed as a symlink lands as a real directory: a linked
      // skill directory is the form none of the three harnesses verifies. Links *inside* the tree
      // are copied as links, which is what the source holds.
      cpSync(realpathSync(write.source), file, { recursive: true, force: true })
    } else symlinkSync(write.source, file)
  } catch (caught) {
    return {
      landed,
      failed: {
        file,
        pointer: null,
        reason: caught instanceof Error ? caught.message : 'the write failed',
      },
    }
  }
  // A link's digest is its target's, so it reads back as the bytes it shows.
  const digest = digestOfPath(file)
  if (digest === null) {
    return { landed, failed: { file, pointer: null, reason: 'the write landed but could not be read back' } }
  }
  landed.push({ file, pointer: null, digest })
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
