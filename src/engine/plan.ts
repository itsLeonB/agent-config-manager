import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import type { Json } from '../types/dashboard'
import {
  MCP_CREDENTIAL_POINTERS,
  MCP_FIELDS,
  factsFromKnownFields,
  pointerSegment,
  pointerSegments,
  urlVerdict,
  withheldVerdict,
  type McpFacts,
  type McpValue,
} from './adapters/mcp-facts.ts'
import {
  TRANSFORMS,
  matchRule,
  ruleValue,
  type McpWriteSurface,
} from './adapters/mcp-write.ts'
import { normaliseLegacyMcp, stripJsonc } from './adapters/opencode/read.ts'
import type { HookCarried, HookHandlerField, HookWriteSurface } from './adapters/hook-write.ts'
import { hookFactsSchema, type HookHandler } from './adapters/hooks.ts'
import { SKILL_FIELDS } from './adapters/skills.ts'
import {
  HARNESSES,
  WRITABILITIES,
  declaresReadPath,
  mirrorTarget,
  type Adapter,
  type Category,
  type HarnessId,
  type ScopeBucket,
  type Tier,
} from './adapters/types.ts'
import { digestOfBytes, digestOfPath } from './digest.ts'
import { planObjectSchema, planValueSchema, type PlanValue } from './plan-value.ts'
import {
  VERDICTS,
  classify,
  classifyWholeFile,
  storedVerdict,
  withheldMarker,
  type CredentialPointer,
  type Verdict,
} from './secret.ts'

export { planObjectSchema, planValueSchema, type PlanValue } from './plan-value.ts'

// shortcut: a plan records the tool version that built it so an old blob can be told from a new one.
// A constant until a build stamps the real one.
export const TOOL_VERSION = '0.1.0'

// The document, and the only place its shape is written down: the types below are inferred from the
// schemas, so a field added to the plan cannot be missing from what apply validates.
const mappedFieldSchema = z.object({
  transform: z.enum(TRANSFORMS),
  fields: z.array(z.string()),
  // Null when the target carries the fact through another field's presence (`transport`).
  targetField: z.string().nullable(),
  template: z.string().optional(),
})

// The closed five, and one policy table that says what each of them does to the plan. A sixth
// reason is a schema change; an adapter cannot invent a gap the planner has no rule for.
export const GAP_REASONS = [
  'fieldAbsent',
  'shapeOnly',
  'credential',
  'executable',
  'categoryAbsent',
] as const
export type GapReason = (typeof GAP_REASONS)[number]
export type GapDisposition = 'planApplies' | 'manualStep' | 'notTranslatable'

export const GAP_DISPOSITIONS = {
  fieldAbsent: 'planApplies',
  // Quoted because this reason's spelling is the gap vocabulary's, not a name chosen here.
  'shapeOnly': 'planApplies',
  credential: 'manualStep',
  executable: 'manualStep',
  categoryAbsent: 'notTranslatable',
} satisfies Record<GapReason, GapDisposition>

// Indexed through a map so a reason that arrived from outside the type is a throw, not an undefined
// disposition that travels to a human ungraded.
const DISPOSITIONS_BY_REASON = new Map<string, GapDisposition>(
  Object.entries(GAP_DISPOSITIONS),
)

export function gapDisposition(reason: string): GapDisposition {
  const rule = DISPOSITIONS_BY_REASON.get(reason)
  if (rule === undefined) throw new Error(`no disposition is declared for the gap reason ${reason}`)
  return rule
}

const planGapSchema = z.object({
  field: z.string(),
  reason: z.enum(GAP_REASONS),
  replacement: z.enum(['renamed', 'inverted', 'dropped']),
})

const planConflictSchema = z.object({
  file: z.string(),
  pointer: z.string(),
  current: planValueSchema,
  proposed: planValueSchema,
})

const planManualStepSchema = z.object({ step: z.string(), why: z.string() })

const planAssertSchema = z.union([
  z.object({ file: z.string(), pointer: z.string(), equals: planValueSchema }),
  // A whole file or a directory tree has no pointer to assert at, so it is asserted by the digest
  // of what the write put there — which is also how a copy is verified without copying it back.
  z.object({ file: z.string(), digest: z.string() }),
])

// The fields every write carries, whatever it does: where it lands, what it is allowed to overwrite,
// and which risk flags it raises.
const writeCommon = {
  file: z.string(),
  precondition: z.object({ exists: z.boolean(), digest: z.string().nullable() }),
  reversible: z.boolean(),
  priorValue: planValueSchema,
  executable: z.boolean(),
  secretValues: z.boolean(),
  irreversible: z.boolean(),
}

export const planWriteSchema = z.discriminatedUnion('op', [
  // One typed leaf in a parsed config, addressed by pointer.
  z.object({
    op: z.literal('writeAtPointer'),
    pointer: z.string(),
    value: planValueSchema,
    ...writeCommon,
  }),
  // A whole markdown file, its body in the document.
  z.object({ op: z.literal('writeFile'), content: z.string(), ...writeCommon }),
  // A copy carries no bytes in the document: the plan names the source and its digest, and apply
  // re-reads it, so a credential in the tree never travels inside a plan. `copyFile` covers a
  // directory, which is what a skill is.
  z.object({
    op: z.literal('copyFile'),
    source: z.string(),
    sourceDigest: z.string(),
    ...writeCommon,
  }),
  // A link is used only where the spec permits one: same scope bucket, an absent target, and a
  // source whose content the target then shows. Verification resolves the link.
  z.object({
    op: z.literal('symlink'),
    source: z.string(),
    sourceDigest: z.string(),
    ...writeCommon,
  }),
])

export type MappedField = z.infer<typeof mappedFieldSchema>
export type PlanGap = z.infer<typeof planGapSchema>
export type PlanConflict = z.infer<typeof planConflictSchema>
export type PlanManualStep = z.infer<typeof planManualStepSchema>
export type PlanAssert = z.infer<typeof planAssertSchema>
export type PlanWrite = z.infer<typeof planWriteSchema>

// What became of the target, in the one vocabulary the spec's disposition table uses: a mirror to
// write, a target that already matches, or a target that is the source.
export const dispositionSchema = z.object({
  kind: z.enum(['mirror', 'alreadyPresent', 'alreadyShared']),
  reason: z.string().nullable(),
})
export type Disposition = z.infer<typeof dispositionSchema>

const equivalenceSchema = z.object({
  carried: z.array(z.string()),
  mapped: z.array(mappedFieldSchema),
  gaps: z.array(planGapSchema),
  preserved: z.array(z.string()),
})

const prerequisitesSchema = z.array(z.object({ check: z.string(), detail: z.string() }))

const permissionsSchema = z.object({
  tierWritability: z.enum(WRITABILITIES),
  elevationRequired: z.boolean(),
  trust: z.enum(['notRequired', 'required']),
})

const securitySchema = z.object({
  grade: z.enum(['safe', 'risky']),
  secrets: z.array(z.object({ pointer: z.string(), verdict: z.enum(VERDICTS) })),
  executables: z.array(z.object({ file: z.string(), why: z.string() })),
})

// The engine grades the plan, not the caller, and apply re-grades the document it is handed rather
// than trusting the grade on it: `planIdOf` is public, so a forged document can claim `safe`.
// One table, so a condition cannot be graded into existence by an adapter or forgotten by apply.
export const RISK_CONDITIONS = [
  'executable',
  'secretValues',
  'irreversible',
  'copyFile',
  'symlink',
  'runCommand',
  'newTargetFile',
  'conflict',
  'elevation',
] as const
export type RiskCondition = (typeof RISK_CONDITIONS)[number]

// Everything a plan already carries, so one function grades a document whether the planner built it
// or a hand-edited one arrived at apply.
export interface RiskFacts {
  writes: readonly {
    op: string
    executable: boolean
    secretValues: boolean
    irreversible: boolean
    precondition: { exists: boolean }
  }[]
  conflicts: readonly unknown[]
  permissions: { elevationRequired: boolean }
}

export function riskConditions(facts: RiskFacts): RiskCondition[] {
  const found = new Set<RiskCondition>()
  for (const write of facts.writes) {
    if (write.executable) found.add('executable')
    if (write.secretValues) found.add('secretValues')
    if (write.irreversible) found.add('irreversible')
    if (write.op === 'copyFile') found.add('copyFile')
    if (write.op === 'symlink') found.add('symlink')
    if (write.op === 'runCommand') found.add('runCommand')
    // A file that does not exist yet is a directory entry this plan creates.
    if (!write.precondition.exists) found.add('newTargetFile')
  }
  if (facts.conflicts.length > 0) found.add('conflict')
  if (facts.permissions.elevationRequired) found.add('elevation')
  return [...found]
}

export function planGrade(facts: RiskFacts): 'safe' | 'risky' {
  return riskConditions(facts).length === 0 ? 'safe' : 'risky'
}

export const mirrorPlanSchema = z.object({
  planId: z.string(),
  createdAt: z.string(),
  toolVersion: z.string(),
  kind: z.literal('mirror'),
  category: z.enum(['mcp', 'skills', 'instructions', 'hooks']),
  source: z.object({
    installationId: z.string(),
    harness: z.string(),
    tierId: z.string(),
    scope: z.string(),
    nativeLocation: z.string(),
    // The source's canonical facts, already classified. Opaque to apply, which reads none of them,
    // and not re-checked field by field here: that table is the adapter's, not the plan's.
    knownFields: z.custom<PlanValue>(),
    contentDigest: z.string(),
  }),
  target: z.object({
    harness: z.enum(HARNESSES),
    tierId: z.string(),
    scope: z.string(),
    nativeLocation: z.string(),
    alsoReadBy: z.array(z.enum(HARNESSES)),
  }),
  equivalence: equivalenceSchema,
  prerequisites: prerequisitesSchema,
  permissions: permissionsSchema,
  // What became of the target: one artefact type, never a separate error shape, so a plan that has
  // nothing to write still arrives as a plan and says why.
  disposition: dispositionSchema,
  conflicts: z.array(planConflictSchema),
  security: securitySchema,
  writes: z.array(planWriteSchema),
  manualSteps: z.array(planManualStepSchema),
  verify: z.object({ asserts: z.array(planAssertSchema) }),
})

export type MirrorPlan = z.infer<typeof mirrorPlanSchema>

// Everything the id covers. It is the plan document minus the id, so hashing it twice is the whole
// integrity check.
export type PlanBody = Omit<MirrorPlan, 'planId'>

// One plan artefact type: a target that cannot be written is refused as caller input, before any
// plan exists, so it never arrives here as a plan with an empty write list.
export type PlanResult = { kind: 'refused'; reason: string } | { kind: 'plan'; plan: MirrorPlan }

// The source row as the store holds it, plus the adapter identity the plan names.
export interface PlanSource {
  installationId: string
  category: Category
  harness: string
  tierId: string
  scope: string
  name: string
  nativeFile: string
  nativePointer: string
  knownFieldsJson: string
  contentDigest: string
}

export interface PlanTarget {
  harness: HarnessId
  tier: Tier
  // The MCP write surface, for an MCP source. Skills and instructions are file work, so their
  // planner reads the tier's own category locations instead.
  surface?: McpWriteSurface
  // Hooks are three methods rather than one: a pointer write into a native hooks file for two
  // targets, generated plugin code for the third.
  hookSurface?: HookWriteSurface
}

export interface PlanInput {
  adapters: readonly Adapter[]
  source: PlanSource
  target: PlanTarget
  now: string
}

// A plan is validated in one place, so `acm apply` and the later `apply_plan` tool refuse the same
// documents for the same reasons: the schema first, then the id the document claims for itself.
export type ValidatedPlan = { kind: 'refused'; reason: string } | { kind: 'plan'; plan: MirrorPlan }

export function validatePlan(raw: Json): ValidatedPlan {
  const parsed = mirrorPlanSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`
    return {
      kind: 'refused',
      reason: `this is not a plan document${at}: ${issue?.message ?? 'the schema did not match'}`,
    }
  }
  // The id covers the whole document, not only the part a write reads, so an edited `equivalence`
  // or `conflicts` section is a different document even when no write depends on it.
  const document = planValueSchema.safeParse(raw)
  if (document.success && intactDocument(document.data)) return { kind: 'plan', plan: parsed.data }
  return {
    kind: 'refused',
    reason: `the plan body does not hash to its planId (${parsed.data.planId}), so it was edited after planning`,
  }
}

export function buildPlan(input: PlanInput): PlanResult {
  if (input.source.category === 'mcp') {
    const surface = input.target.surface
    if (surface === undefined) {
      return { kind: 'refused', reason: `${input.target.harness} declares no mcp write surface` }
    }
    return buildMcpPlan(input, surface)
  }
  if (input.source.category === 'skills') return buildSkillPlan(input)
  if (input.source.category === 'instructions') return buildInstructionPlan(input)
  if (input.source.category === 'hooks') return buildHookPlan(input)
  return {
    kind: 'refused',
    reason: `${input.source.category} has no mirror planner yet; only mcp, skills, instructions and hooks do`,
  }
}

// The parts a planner fills in, sealed into one document by `sealPlan`: the identity of source and
// target comes from the input every time, so no planner can name a different one.
interface PlanParts {
  disposition: Disposition
  equivalence: z.infer<typeof equivalenceSchema>
  prerequisites: z.infer<typeof prerequisitesSchema>
  permissions: z.infer<typeof permissionsSchema>
  conflicts: PlanConflict[]
  security: z.infer<typeof securitySchema>
  writes: PlanWrite[]
  manualSteps: PlanManualStep[]
  verify: PlanAssert[]
  targetNativeLocation: string
  alsoReadBy: HarnessId[]
}

function sealPlan(input: PlanInput, parts: PlanParts): PlanResult {
  const { source, target } = input
  const body: PlanBody = {
    createdAt: input.now,
    toolVersion: TOOL_VERSION,
    kind: 'mirror',
    category: source.category,
    disposition: parts.disposition,
    source: {
      installationId: source.installationId,
      harness: source.harness,
      tierId: source.tierId,
      scope: source.scope,
      nativeLocation: `${source.nativeFile}#${source.nativePointer}`,
      knownFields: knownFieldsDocument(source.knownFieldsJson),
      contentDigest: source.contentDigest,
    },
    target: {
      harness: target.harness,
      tierId: target.tier.id,
      scope: target.tier.scopeBucket,
      nativeLocation: parts.targetNativeLocation,
      alsoReadBy: parts.alsoReadBy,
    },
    equivalence: parts.equivalence,
    prerequisites: parts.prerequisites,
    permissions: parts.permissions,
    conflicts: parts.conflicts,
    security: parts.security,
    writes: parts.writes,
    manualSteps: parts.manualSteps,
    verify: { asserts: parts.verify },
  }
  return { kind: 'plan', plan: { planId: planIdOf(toPlanValue(body)), ...body } }
}

// A stored row holds its known fields as JSON text; a row this process cannot decode is refused
// rather than planned from nothing.
function knownFieldsDocument(json: string): PlanValue {
  try {
    return planValueSchema.parse(JSON.parse(json))
  } catch {
    return {}
  }
}

function buildMcpPlan(input: PlanInput, surface: McpWriteSurface): PlanResult {
  const { source, target } = input
  const file = targetFile(target.tier)
  const existing = readTargetFile(file)
  if (existing.kind === 'unreadable') {
    return {
      kind: 'refused',
      reason: `${file} exists but cannot be parsed, so the target's current values are unknown`,
    }
  }
  const known = factsFromKnownFields(source.knownFieldsJson)
  if (known.kind === 'invalid') {
    return {
      kind: 'refused',
      reason: `${source.nativeFile} known fields cannot be decoded: ${known.detail}`,
    }
  }
  // A project entry may carry only `enabled`/`exposure` and inherit the rest from the user tier. On
  // its own it names no transport, and OpenCode replaces whole entries rather than merging them, so
  // a plan would write a server that cannot launch.
  if (known.facts.command === undefined && known.facts.url === undefined) {
    return {
      kind: 'refused',
      reason: `${source.nativePointer} carries neither command nor url: it is a project override of a base entry, and mirroring it alone would write a server that cannot start`,
    }
  }
  const entryPointer = `${surface.pointerPrefix}.${pointerSegment(source.name)}`
  // A candidate file may define this server at either address, and both are definitions of it.
  const addresses =
    target.harness === 'opencode' ? [entryPointer, `mcp.${pointerSegment(source.name)}`] : [entryPointer]
  const ambiguous = ambiguousTarget(target.tier, file, addresses)
  if (ambiguous !== null) return { kind: 'refused', reason: ambiguous }
  const document = existing.kind === 'parsed' ? existing.document : null
  // OpenCode reads a legacy flat `mcp.<name>` shape beside `mcp.servers`, and one file may hold
  // both. A plan writes one shape, so such a file is normalised first; every read below then sees
  // the values the write really lands on top of, instead of guessing them absent.
  const legacy = legacyBlock(document, target)
  if (legacy.kind === 'invalid') return { kind: 'refused', reason: legacy.detail }
  const current = legacy.kind === 'normalised' ? legacy.document : document
  const blocker = structuralBlocker(current, entryPointer, known.facts)
  if (blocker !== null) return { kind: 'refused', reason: blocker }

  const partition = partitionFields(known.facts, surface, target.tier.id)
  const precondition = {
    exists: existing.kind === 'parsed',
    digest: existing.kind === 'parsed' ? existing.digest : null,
  }
  // One write for a normalised block, one write per addressed leaf otherwise: the shapes differ, so
  // a plan never carries both.
  const writes: PlanWrite[] = []
  if (legacy.kind === 'normalised') {
    const container = normalisedWrite(file, precondition, legacy, document, source.name, partition)
    if (container.kind === 'refused') return container
    writes.push(container.write)
  } else {
    for (const write of partition.writes) {
      const pointer = `${entryPointer}.${write.target}`
      const runs = z.string().safeParse(write.value)
      writes.push({
        op: 'writeAtPointer',
        file,
        pointer,
        value: write.value,
        precondition,
        reversible: true,
        priorValue: priorValueAt(current, pointer),
        executable: runs.success && runs.data.startsWith('!'),
        secretValues: false,
        irreversible: false,
      })
    }
  }
  const blocked = writes
    .map((write) => (write.op === 'writeAtPointer' ? ancestorBlocker(current, write.pointer) : null))
    .find((found) => found !== null)
  if (blocked !== null && blocked !== undefined) return { kind: 'refused', reason: blocked }
  // Nothing to copy onto itself, and nothing to write where the target already says it: both are
  // plans with no writes and a stated reason, never a refusal or a silent rewrite.
  const disposition = dispositionOf(file, source, writes, existing.kind === 'parsed')
  const pending = disposition.kind === 'mirror' ? writes : []
  // Every MCP write addresses one pointer, so the pointer, its current value and its proposed one
  // are what a conflict shows.
  const conflicts = pending.flatMap<PlanConflict>((write) => {
    const pointer = write.op === 'writeAtPointer' ? write.pointer : ''
    const value = write.op === 'writeAtPointer' ? write.value : null
    if (write.priorValue === null || JSON.stringify(write.priorValue) === JSON.stringify(value)) {
      return []
    }
    return [{ file, pointer, current: write.priorValue, proposed: value }]
  })
  const executables = pending
    .filter((write) => write.executable)
    .map((write) => ({
      file,
      why: `${write.op === 'writeAtPointer' ? write.pointer : file} runs a command at harness runtime`,
    }))
  return sealPlan(input, {
    equivalence: {
      carried: partition.carried,
      mapped: partition.mapped,
      gaps: partition.gaps,
      // A field no adapter names is preserved as it stands; so is a canonical field the target has
      // no rule for and no declared absence.
      preserved: [...known.unknown, ...partition.preserved],
    },
    prerequisites: [
      {
        check: 'source-known-fields',
        detail: `${source.nativeFile}#${source.nativePointer} decoded from the last scan`,
      },
      { check: 'target-tier-writable', detail: `${target.tier.id} is a declared writable tier` },
      {
        check: 'target-file',
        detail: precondition.exists ? `${file} exists` : `${file} does not exist yet`,
      },
    ],
    permissions: {
      tierWritability: target.tier.writability,
      elevationRequired: false,
      trust: target.tier.id === 'codex:project' ? 'required' : 'notRequired',
    },
    disposition,
    conflicts,
    security: {
      grade: planGrade({ writes: pending, conflicts, permissions: { elevationRequired: false } }),
      secrets: partition.secrets,
      executables,
    },
    writes: pending,
    manualSteps: [...partition.manualSteps, ...legacySteps(legacy), ...tierManualSteps(target.tier.id)],
    verify: pending.flatMap<PlanAssert>((write) =>
      write.op === 'writeAtPointer'
        ? [{ file: write.file, pointer: write.pointer, equals: write.value }]
        : [],
    ),
    targetNativeLocation: `${file}#${entryPointer}`,
    alsoReadBy: alsoReadBy(input.adapters, target.harness, file),
  })
}

// Skills ---------------------------------------------------------------------------------------

const storedSkillFacts = z.object({ files: z.array(z.string()) })
const storedInstructionFacts = z.object({ body: z.string() })

// A skill is a directory tree, and all three harnesses read it from the same `.agents/skills`
// location, so the plan is one copy there. That is also why mirroring the same skill into a second
// harness has nothing to write: the target is the source, and the installation now carries one
// binding per harness that reads it.
function buildSkillPlan(input: PlanInput): PlanResult {
  const { source, target } = input
  const root = mirrorTarget(target.tier, 'skills')
  if (root === undefined) return categoryAbsentPlan(input, 'skills')
  const facts = decode(source.knownFieldsJson, storedSkillFacts)
  if (facts === null) {
    return {
      kind: 'refused',
      reason: `${source.nativeFile} known fields are not a skill listing, so the directory cannot be described`,
    }
  }
  const targetDir = path.join(root, source.name)
  const sourceDigest = digestOfPath(source.nativeFile)
  if (sourceDigest === null) {
    return { kind: 'refused', reason: `${source.nativeFile} cannot be read, so there is nothing to copy` }
  }
  // The listing this plan classifies came from the last scan. A tree that changed since is one the
  // classifier never saw, so the copy is refused rather than offered half-inspected.
  if (source.contentDigest !== '' && sourceDigest !== source.contentDigest) {
    return {
      kind: 'refused',
      reason: `${source.nativeFile} changed since the last scan, so the files a copy would carry are not the ones that were inspected; run \`acm list\` and plan again`,
    }
  }
  // The skill is described by a directory the engine cannot read? Then there is nothing to plan from:
  // a copy of an unknown tree would claim a content it never saw.
  if (readTextOrNull(path.join(source.nativeFile, 'SKILL.md')) === null) {
    return {
      kind: 'refused',
      reason: `${path.join(source.nativeFile, 'SKILL.md')} cannot be read, so the skill cannot be described`,
    }
  }
  // Every text file in the tree is credential-bearing content, not just the entry point: a copy
  // would carry a value in `references/` into every harness that reads the shared location.
  const unclean = uncleanTree(source.nativeFile, facts.files)
  const conflicts: PlanConflict[] = []
  const gaps: PlanGap[] = []
  const manualSteps: PlanManualStep[] = []
  const writes: PlanWrite[] = []
  const existing = digestOfPath(targetDir)
  let disposition: Disposition = { kind: 'mirror', reason: null }
  if (unclean !== null) {
    const gap: PlanGap = { field: unclean.file, reason: 'credential', replacement: 'dropped' }
    gaps.push(gap)
    // The policy table decides whether a gap owes the human a step, not this branch.
    if (gapDisposition(gap.reason) === 'manualStep') {
      manualSteps.push({
        step: `remove the credential from ${path.join(source.nativeFile, unclean.file)} and read it through the source harness's own indirection`,
        why: 'the skill directory holds a credential-shaped value, and copying it would put that value in every harness that reads the shared location',
      })
    }
  } else if (path.resolve(targetDir) === path.resolve(source.nativeFile)) {
    disposition = {
      kind: 'alreadyShared',
      reason: `${targetDir} is where ${source.nativeFile} already lives, and every harness that reads it reads this directory, so there is nothing to copy`,
    }
  } else if (existing === sourceDigest) {
    disposition = { kind: 'alreadyPresent', reason: `${targetDir} already holds this skill` }
  } else if (existing !== null) {
    // Nothing is removed by a mirror, so two different skills under one name stay two: the plan
    // reports the conflict and says how a human clears it.
    conflicts.push({ file: targetDir, pointer: '', current: existing, proposed: sourceDigest })
    manualSteps.push({
      step: `remove ${targetDir} by hand, then plan this mirror again`,
      why: 'the shared location already holds a different skill under this name, and this slice has no op that removes a directory',
    })
  } else {
    writes.push({
      op: 'copyFile',
      file: targetDir,
      source: source.nativeFile,
      sourceDigest,
      precondition: { exists: false, digest: null },
      // The bytes are re-read at apply; nothing to put back, and no removal op to put it back with.
      reversible: false,
      priorValue: null,
      executable: false,
      secretValues: false,
      irreversible: false,
    })
  }
  return sealPlan(input, {
    disposition,
    equivalence: {
      // A withheld file is a gap, never something carried: nothing in this plan holds its value.
      carried: unclean === null ? [...SKILL_FIELDS] : [],
      mapped: [],
      gaps,
      preserved: [],
    },
    prerequisites: [
      { check: 'source-known-fields', detail: `${source.nativeFile} listed at the last scan` },
      { check: 'target-tier-writable', detail: `${target.tier.id} is a declared writable tier` },
      {
        check: 'target-directory',
        detail: existing === null ? `${targetDir} does not exist yet` : `${targetDir} exists`,
      },
    ],
    permissions: {
      tierWritability: target.tier.writability,
      // Derived, not asserted: a plan for a managed or elevated tier never reaches here.
      elevationRequired: target.tier.writability !== 'writable',
      trust: trustRequired(target.tier.id, 'skills') ? 'required' : 'notRequired',
    },
    conflicts,
    security: {
      grade: planGrade({ writes, conflicts, permissions: { elevationRequired: false } }),
      secrets: unclean === null ? [] : [{ pointer: unclean.file, verdict: unclean.verdict }],
      executables: [],
    },
    writes,
    manualSteps: [...manualSteps, ...trustSteps(target.tier.id, 'skills')],
    verify: writes.map<PlanAssert>(() => ({ file: targetDir, digest: sourceDigest })),
    targetNativeLocation: targetDir,
    alsoReadBy: alsoReadBy(input.adapters, target.harness, targetDir),
  })
}

// A whole instruction file: the body is the plan's own value, and the digest it lands as is what
// verification re-reads. A file whose address is already taken is written over only when the caller
// answers the conflict.
function writeBody(
  file: string,
  body: string,
  precondition: { exists: boolean; digest: string | null } = { exists: false, digest: null },
): PlanWrite {
  return {
    op: 'writeFile',
    file,
    content: body,
    precondition,
    reversible: false,
    priorValue: precondition.digest,
    executable: false,
    secretValues: false,
    irreversible: false,
  }
}

// Whether a file carries text the classifier can read, decided from the bytes rather than the name:
// a dotfile and an extensionless script are text, and an image or a font is not. Valid UTF-8 with no
// NUL is the whole test, so nothing is skipped for having an unexpected extension.
type TreeFile = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'unreadable' }

function readTreeFile(file: string): TreeFile {
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch {
    return { kind: 'unreadable' }
  }
  if (bytes.includes(0)) return { kind: 'binary' }
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? { kind: 'text', text } : { kind: 'binary' }
}

// The first file of a tree the classifier will not call clean. A file this process cannot read is
// the same answer as an unclean one: a copy it cannot describe is not one it may offer.
function uncleanTree(
  dir: string,
  files: readonly string[],
): { file: string; verdict: Verdict } | null {
  for (const relative of files) {
    const read = readTreeFile(path.join(dir, relative))
    if (read.kind === 'binary') continue
    if (read.kind === 'unreadable') return { file: relative, verdict: 'suspect' }
    const verdict = classifyWholeFile(relative, read.text)
    if (verdict !== 'clean') return { file: relative, verdict }
  }
  return null
}

// An instruction file is one markdown file, so the plan writes or links it. A link is the spec's
// one permitted use: the source and the target sit in the same scope bucket, the target path is
// declared, and nothing exists there. Across buckets a link would point out of the bucket it is
// meant to belong to, so the body is written instead.
function buildInstructionPlan(input: PlanInput): PlanResult {
  const { source, target } = input
  const targetFile = mirrorTarget(target.tier, 'instructions')
  if (targetFile === undefined) return categoryAbsentPlan(input, 'instructions')
  const facts = decode(source.knownFieldsJson, storedInstructionFacts)
  if (facts === null) {
    return {
      kind: 'refused',
      reason: `${source.nativeFile} known fields are not an instruction body, so the file cannot be described`,
    }
  }
  const verdict = storedVerdict(facts.body)
  // The body travels inside the plan, so the row it came from has to still be what is on disk: a
  // source edited since the scan would otherwise be written as the old text, into a target whose own
  // digest would never reveal it.
  const sourceDigest = digestOfPath(source.nativeFile)
  if (sourceDigest === null) {
    return { kind: 'refused', reason: `${source.nativeFile} cannot be read, so there is nothing to mirror` }
  }
  if (sourceDigest !== source.contentDigest) {
    return {
      kind: 'refused',
      reason: `${source.nativeFile} changed since the last scan, so the stored body is stale; run \`acm list\` and plan again`,
    }
  }
  const existing = digestOfPath(targetFile)
  const samePath = path.resolve(targetFile) === path.resolve(source.nativeFile)
  const conflicts: PlanConflict[] = []
  const gaps: PlanGap[] = []
  const manualSteps: PlanManualStep[] = []
  const writes: PlanWrite[] = []
  const written = digestOfBytes(Buffer.from(facts.body, 'utf8'))
  const alsoRead = alsoReadBy(input.adapters, target.harness, targetFile)
  // Every harness that loads this file, the target first: a shadow only matters to one of them.
  const readers: HarnessId[] = [target.harness, ...alsoRead]
  let disposition: Disposition = { kind: 'mirror', reason: null }
  if (verdict !== 'clean') {
    const gap: PlanGap = { field: 'body', reason: 'credential', replacement: 'dropped' }
    gaps.push(gap)
    if (gapDisposition(gap.reason) === 'manualStep') {
      manualSteps.push({
        step: `read the value ${source.nativeFile} needs through the target harness's own indirection, and keep it out of the shared instruction file`,
        why: 'the instruction file holds a credential-shaped value, and the plan never carries one',
      })
    }
  } else if (samePath) {
    // The project instruction file is the same file for all three harnesses, so a mirror between
    // them finds it already in place instead of writing a second copy.
    disposition = {
      kind: 'alreadyPresent',
      reason: `${targetFile} is where ${source.nativeFile} already lives, and all three harnesses read this one file`,
    }
  } else if (existing === sourceDigest) {
    disposition = { kind: 'alreadyPresent', reason: `${targetFile} already holds this body` }
  } else if (existing !== null) {
    // A differing file is a conflict, and the write rides along so an explicit `replace` can answer
    // it; a link is never placed over something, so this case always writes the body.
    conflicts.push({ file: targetFile, pointer: '', current: existing, proposed: sourceDigest })
    writes.push(writeBody(targetFile, facts.body, { exists: true, digest: existing }))
  } else if (source.scope === target.tier.scopeBucket) {
    writes.push({
      op: 'symlink',
      file: targetFile,
      source: source.nativeFile,
      sourceDigest,
      precondition: { exists: false, digest: null },
      reversible: false,
      priorValue: null,
      executable: false,
      secretValues: false,
      irreversible: false,
    })
  } else {
    writes.push(writeBody(targetFile, facts.body))
  }
  return sealPlan(input, {
    disposition,
    // A withheld body is a gap, never something carried: the plan never holds the value.
    equivalence: { carried: verdict === 'clean' ? ['body'] : [], mapped: [], gaps, preserved: [] },
    prerequisites: [
      { check: 'source-known-fields', detail: `${source.nativeFile} decoded from the last scan` },
      { check: 'target-tier-writable', detail: `${target.tier.id} is a declared writable tier` },
      {
        check: 'target-file',
        detail: existing === null ? `${targetFile} does not exist yet` : `${targetFile} exists`,
      },
    ],
    permissions: {
      tierWritability: target.tier.writability,
      elevationRequired: false,
      trust: trustRequired(target.tier.id, 'instructions') ? 'required' : 'notRequired',
    },
    conflicts,
    security: {
      grade: planGrade({ writes, conflicts, permissions: { elevationRequired: false } }),
      secrets: verdict === 'clean' ? [] : [{ pointer: 'body', verdict }],
      executables: [],
    },
    writes,
    // The shadows and the size cap are facts about the target whatever this plan writes, so an
    // already-present plan names them too — an oversized shared `AGENTS.md` is truncated whichever
    // harness asked for the mirror, and nothing about that plan may read as verified.
    manualSteps: [
      ...manualSteps,
      ...instructionManualSteps(
        targetFile,
        facts.body,
        target.tier.scopeBucket,
        readers,
        writes.length > 0,
      ),
      ...trustSteps(target.tier.id, 'instructions'),
    ],
    verify: writes.map<PlanAssert>((write) =>
      write.op === 'symlink'
        ? { file: targetFile, digest: sourceDigest }
        : { file: targetFile, digest: written },
    ),
    targetNativeLocation: targetFile,
    alsoReadBy: alsoRead,
  })
}

// Hooks ---------------------------------------------------------------------------------------

// One category, three methods, decided by what the target actually has: a pointer write into the
// hooks file Codex reads natively and Pi reads through a bridge, or generated plugin code for
// OpenCode, which has no hook config at all. The event is renamed per target; an event or a matcher
// with no counterpart is a gap and nothing is written for it, because a hook that fires more widely
// than its source is a different hook. Every write carrying a command is executable, needs its own
// tick, and can never be reported as verified.
function buildHookPlan(input: PlanInput): PlanResult {
  const { source, target } = input
  const surface = target.hookSurface
  if (surface === undefined) {
    return { kind: 'refused', reason: `${target.harness} declares no hook write surface` }
  }
  const facts = decode(source.knownFieldsJson, hookFactsSchema)
  if (facts === null) {
    return {
      kind: 'refused',
      reason: `${source.nativeFile} known fields are not a hook entry, so there is nothing to mirror`,
    }
  }
  const root = mirrorTarget(target.tier, 'hooks')
  if (root === undefined) return categoryAbsentPlan(input, 'hooks')
  // The commands travel inside the plan, so the file they came from has to still be what the scan
  // saw: a hook edited since would otherwise land a command no classifier ever read.
  const sourceDigest = digestOfPath(source.nativeFile)
  if (sourceDigest === null) {
    return { kind: 'refused', reason: `${source.nativeFile} cannot be read, so there is nothing to mirror` }
  }
  if (sourceDigest !== source.contentDigest) {
    return {
      kind: 'refused',
      reason: `${source.nativeFile} changed since the last scan, so the stored hook is stale; run \`acm list\` and plan again`,
    }
  }

  const gaps: PlanGap[] = []
  const manualSteps: PlanManualStep[] = []
  const mapped: MappedField[] = []
  const secrets: { pointer: string; verdict: Verdict }[] = []
  const carried: string[] = []

  const targetEvent = surface.eventName(facts.event)
  if (targetEvent === undefined) {
    gaps.push({ field: 'event', reason: 'fieldAbsent', replacement: 'dropped' })
    manualSteps.push({
      step: `author this ${facts.event} hook in ${target.harness} by hand`,
      why: `${target.harness} has no ${facts.event} event, so writing it here would give the hook no event to fire on`,
    })
  } else {
    mapped.push({ transform: 'rename', fields: ['event'], targetField: targetEvent })
  }

  // A wildcard matcher is carried as it stands; anything narrower is this target's own gap, because
  // writing the hook without it would fire where the source did not.
  const wildcard = facts.matcher === undefined || facts.matcher === '' || facts.matcher === '*'
  if (wildcard) {
    if (facts.matcher !== undefined) carried.push('matcher')
  } else {
    gaps.push({ field: 'matcher', reason: 'fieldAbsent', replacement: 'dropped' })
    manualSteps.push({
      step: `narrow the mirrored hook in ${target.harness} to ${JSON.stringify(facts.matcher)} by hand`,
      why: 'neither of the other targets has a matcher on a hook, so a write here would fire it wherever a tool runs rather than only on this one',
    })
  }

  const handlers: HookCarried[] = []
  let unitMapped = false
  facts.handlers.forEach((handler, index) => {
    // A handler that runs a tool is neither a command nor code this engine can generate, so it is
    // stated rather than approximated.
    if (handler.type !== undefined && handler.type !== 'command') {
      gaps.push({ field: `handlers.${index}.type`, reason: 'fieldAbsent', replacement: 'dropped' })
      return
    }
    if (handler.command === undefined) {
      gaps.push({ field: `handlers.${index}.command`, reason: 'fieldAbsent', replacement: 'dropped' })
      return
    }
    // A command is the one hook value the classifier can read as a credential, and a literal token
    // in it would travel to every harness the hook lands in.
    const verdict = classify(`handlers.${index}.command`, handler.command, [])
    if (verdict.verdict !== 'clean') {
      gaps.push({ field: `handlers.${index}.command`, reason: 'credential', replacement: 'dropped' })
      secrets.push({ pointer: `handlers.${index}.command`, verdict: verdict.verdict })
      if (gapDisposition('credential') === 'manualStep') {
        manualSteps.push({
          step: `read the value this hook command needs through ${target.harness}'s own indirection, and keep it out of the hook`,
          why: 'the command carries a credential-shaped value, and a mirror never writes one',
        })
      }
      return
    }
    // A handler field this target has no place for is a gap, never a silent drop.
    for (const field of ['statusMessage', 'print'] as const) {
      if (handler[field] !== undefined && !surface.holds.includes(field)) {
        gaps.push({ field: `handlers.${index}.${field}`, reason: 'fieldAbsent', replacement: 'dropped' })
      }
    }
    // Only a target reading milliseconds is a mapped field: the same unit is a carry, not a
    // translation, and one plan names the transform once however many handlers it holds.
    if (handler.timeout !== undefined && surface.timeoutUnit === 'milliseconds' && !unitMapped) {
      mapped.push({ transform: 'unit', fields: ['handlers.timeout'], targetField: 'timeout' })
      unitMapped = true
    }
    handlers.push(carriedHandler(handler, surface.holds))
  })
  if (handlers.length === facts.handlers.length) carried.push('handlers')

  const writes: PlanWrite[] = []
  const conflicts: PlanConflict[] = []
  const asserts: PlanAssert[] = []
  let disposition: Disposition = { kind: 'mirror', reason: null }
  let targetNativeLocation = root
  // Nothing is written when the event has no counterpart, the matcher would have to be widened, or
  // every handler was a gap: the plan states that instead of writing a hook that behaves differently.
  if (targetEvent !== undefined && wildcard && handlers.length > 0) {
    if (surface.kind === 'pointer') {
      const file = root
      const existing = readTargetFile(file)
      if (existing.kind === 'unreadable') {
        return {
          kind: 'refused',
          reason: `${file} exists but cannot be parsed, so the hooks it already holds are unknown`,
        }
      }
      const pointer = `hooks.${targetEvent}`
      targetNativeLocation = `${file}#${pointer}`
      const current = existing.kind === 'parsed' ? resolvePointer(existing.document, pointer) : undefined
      const list = z.array(planValueSchema).safeParse(current ?? [])
      if (!list.success) {
        return {
          kind: 'refused',
          reason: `${pointer} in ${file} is not a list of hooks, so writing an entry there would replace something this engine cannot describe`,
        }
      }
      // The whole list would travel in `priorValue`, which is shown verbatim, so a credential-shaped
      // command already at that address is refused rather than printed.
      const unclean = uncleanPointer(current ?? null, pointer)
      if (unclean !== null) {
        return {
          kind: 'refused',
          reason: `${unclean} in ${file} holds a credential-shaped value, and appending to that list would carry it into the plan; move that command to the harness's own indirection by hand first`,
        }
      }
      const added = surface.entries(handlers, facts.matcher)
      const value: PlanValue = [...list.data, ...added]
      const already = added.every((entry) =>
        list.data.some((item) => JSON.stringify(item) === JSON.stringify(entry)),
      )
      if (already) {
        disposition = { kind: 'alreadyPresent', reason: `${file} already holds this hook at ${pointer}` }
      } else {
        writes.push({
          op: 'writeAtPointer',
          file,
          pointer,
          value,
          precondition: {
            exists: existing.kind === 'parsed',
            digest: existing.kind === 'parsed' ? existing.digest : null,
          },
          reversible: true,
          priorValue: current === undefined ? null : list.data,
          executable: true,
          secretValues: false,
          irreversible: false,
        })
        asserts.push({ file, pointer, equals: value })
      }
    } else {
      const plugin = surface.plugin(
        { harness: source.harness, event: facts.event },
        targetEvent,
        handlers,
      )
      const file = path.join(root, plugin.file)
      targetNativeLocation = file
      // Generated code is a whole-file category, so its own text is the value the classifier reads.
      const verdict = classifyWholeFile(plugin.file, plugin.text)
      if (verdict !== 'clean') {
        gaps.push({ field: 'plugin', reason: 'credential', replacement: 'dropped' })
        secrets.push({ pointer: 'plugin', verdict })
        if (gapDisposition('credential') === 'manualStep') {
          manualSteps.push({
            step: `read the value this hook command needs through ${target.harness}'s own indirection, and keep it out of the generated module`,
            why: 'the command carries a credential-shaped value, and a mirror never writes one',
          })
        }
      } else {
        const existing = digestOfPath(file)
        const written = digestOfBytes(Buffer.from(plugin.text, 'utf8'))
        if (existing === written) {
          disposition = { kind: 'alreadyPresent', reason: `${file} already holds this module` }
        } else {
          if (existing !== null) {
            conflicts.push({ file, pointer: '', current: existing, proposed: written })
          }
          writes.push({
            op: 'writeFile',
            file,
            content: plugin.text,
            precondition:
              existing === null ? { exists: false, digest: null } : { exists: true, digest: existing },
            reversible: false,
            priorValue: existing,
            executable: true,
            secretValues: false,
            irreversible: false,
          })
          asserts.push({ file, digest: written })
        }
      }
    }
  }

  return sealPlan(input, {
    disposition,
    equivalence: { carried, mapped, gaps, preserved: [] },
    prerequisites: [
      { check: 'source-known-fields', detail: `${source.nativeFile}#${source.nativePointer} decoded from the last scan` },
      { check: 'target-tier-writable', detail: `${target.tier.id} is a declared writable tier` },
      {
        check: 'target-hook-location',
        detail: `${targetNativeLocation} ${writes.length === 0 ? (existsSync(targetNativeLocation) ? 'exists' : 'does not exist yet') : 'is the address this plan writes'}`,
      },
    ],
    permissions: {
      tierWritability: target.tier.writability,
      elevationRequired: false,
      trust: trustRequired(target.tier.id, 'hooks') ? 'required' : 'notRequired',
    },
    conflicts,
    security: {
      grade: planGrade({ writes, conflicts, permissions: { elevationRequired: false } }),
      secrets,
      executables: [...new Set(writes.map((write) => write.file))].map((file) => ({
        file,
        why: 'the hook runs a command at harness runtime',
      })),
    },
    writes,
    manualSteps: [...manualSteps, ...hookSteps(target.harness), ...trustSteps(target.tier.id, 'hooks')],
    verify: asserts,
    targetNativeLocation,
    alsoReadBy: alsoReadBy(input.adapters, target.harness, targetNativeLocation.split('#')[0] ?? ''),
  })
}

// One source handler as the target will hold it: its command, the timeout in milliseconds whichever
// unit the target reads, and the fields that target has a place for. A field it does not hold stays
// out here and is reported as the gap it is.
function carriedHandler(handler: HookHandler, holds: readonly HookHandlerField[]): HookCarried {
  const carried: HookCarried = { command: handler.command ?? '' }
  if (handler.timeout !== undefined) carried.timeoutMs = handler.timeout * 1000
  if (handler.statusMessage !== undefined && holds.includes('statusMessage')) {
    carried.statusMessage = handler.statusMessage
  }
  if (handler.print !== undefined && holds.includes('print')) carried.print = handler.print
  return carried
}

// What a human still has to do before a mirrored hook actually fires. Each target gates this its own
// way: a feature switch and a trust review, a bridge package and a restart, or a generated module
// and the restart that loads it.
function hookSteps(harness: HarnessId): PlanManualStep[] {
  if (harness === 'codex') {
    return [
      {
        step: 'set [features] hooks = true in $CODEX_HOME/config.toml',
        why: 'Codex loads no hook while its hooks feature is off, so a correct hooks.json is inert until the switch is on',
      },
      {
        step: 'review the new hook with `/hooks` in Codex and approve it',
        why: "Codex runs no hook it has not trusted, and it keys trust to a content hash and the hook's position, so inserting one ahead of an existing hook needs the later ones reviewed again",
      },
    ]
  }
  if (harness === 'pi') {
    return [
      {
        step: 'install the bridge: `pi install npm:@vahor/pi-hooks`',
        why: 'Pi has no hook config of its own; this package is what reads hooks.json, so the file this plan writes is inert until it is installed',
      },
      {
        step: 'restart Pi',
        why: 'Pi loads its extensions at startup, so the mirrored hook does not load until it is restarted',
      },
    ]
  }
  return [
    {
      step: 'review the generated plugin module, then restart OpenCode',
      why: 'OpenCode has no hook config: this module is executable code that runs the hook command, and plugins load at startup',
    },
  ]
}

// The files a harness reads ahead of the one this plan writes, in the same directory, each with the
// harnesses it outranks. Same directory only: these replace the file, whereas an ancestor's is
// combined with it.
const SHADOWING_INSTRUCTIONS: readonly { name: string; readers: readonly HarnessId[] }[] = [
  { name: 'AGENTS.override.md', readers: ['pi', 'codex'] },
  { name: 'AGENTS.MD', readers: ['pi'] },
  { name: 'CLAUDE.md', readers: ['pi'] },
  { name: 'CLAUDE.MD', readers: ['pi'] },
]

// A name that resolves to the target itself is not a shadow of it: on a case-insensitive filesystem
// `AGENTS.MD` and `AGENTS.md` are one file, and a link with a shadow's name is the same entry again.
// Where they really are decides it, so a distinct same-named file on a case-sensitive filesystem is
// still reported.
function isSameEntry(candidate: string, target: string): boolean {
  const resolved = realpathOf(candidate)
  return resolved !== null && resolved === realpathOf(target)
}

function realpathOf(file: string): string | null {
  try {
    return existsSync(file) ? realpathSync(file) : null
  } catch {
    return null
  }
}

// What a human still has to know after the bytes land: a same-directory file that outranks this one
// for a harness that reads it, Codex's project budget, and — only when something is written — the
// ancestor instruction files every harness also loads.
function instructionManualSteps(
  targetFile: string,
  body: string,
  scopeBucket: ScopeBucket,
  readers: readonly HarnessId[],
  writing: boolean,
): PlanManualStep[] {
  const steps: PlanManualStep[] = []
  const directory = path.dirname(targetFile)
  const shadows = SHADOWING_INSTRUCTIONS.filter(
    (shadow) =>
      shadow.readers.some((harness) => readers.includes(harness)) &&
      existsSync(path.join(directory, shadow.name)) &&
      !isSameEntry(path.join(directory, shadow.name), targetFile),
  ).map((shadow) => ({ rank: shadow, file: path.join(directory, shadow.name) }))
  for (const { rank, file } of shadows) {
    steps.push({
      step: `review ${file}`,
      why: `${rank.readers.join(' and ')} read${rank.readers.length === 1 ? 's' : ''} ${rank.name} ahead of AGENTS.md in that directory, so the file this plan writes is not the one that wins there while that file exists`,
    })
  }
  if (readers.includes('codex') && scopeBucket === 'project' && Buffer.byteLength(body, 'utf8') > 32768) {
    steps.push({
      step: "raise project_doc_max_bytes in Codex's user config, or shorten the project instruction file",
      why: 'Codex caps the project instructions it loads at 32 KiB by default, so the tail of this file is not read',
    })
  }
  if (writing && scopeBucket === 'project') {
    steps.push({
      step: 'review the AGENTS.md files in the directories above this project',
      why: 'Pi, Codex and OpenCode each load every ancestor AGENTS.md too, so this file is one of several a session reads; a file closer to the working directory comes later and wins',
    })
  }
  return steps
}

// The layers that outrank a written file, named rather than assumed away.
// A trust gate makes a correct write inert, and only a human can lift it. Codex gates its whole
// project layer; Pi gates a project's `.agents/skills` and its own project config — which is what a
// project `hooks.json` is — but not its instruction-file discovery, so a project `AGENTS.md` needs
// no step there.
function trustRequired(tierId: string, category: Category): boolean {
  if (tierId === 'codex:project') return true
  return tierId === 'pi:project' && (category === 'skills' || category === 'hooks')
}

function trustSteps(tierId: string, category: Category): PlanManualStep[] {
  const what =
    category === 'skills'
      ? 'the copied skill directory'
      : category === 'hooks'
        ? 'the mirrored hook'
        : 'this instruction file'
  if (tierId === 'codex:project') return [codexTrustStep(what)]
  if (tierId === 'pi:project' && (category === 'skills' || category === 'hooks')) {
    return [
      {
        step: 'trust this project in Pi (`/trust`), or set defaultProjectTrust',
        why: `Pi loads no project or ancestor config until a trust decision is saved in ~/.pi/agent/trust.json, so ${what} is inert`,
      },
    ]
  }
  return []
}

// One switch, whatever the plan writes: an untrusted project layer is inert for every category, so
// the step differs only in what a human is being told is not loaded.
function codexTrustStep(what: string): PlanManualStep {
  return {
    step: 'add this project to [projects."<path>"] with trust_level = "trusted" in $CODEX_HOME/config.toml',
    why: `Codex treats an untrusted project config as inert, so ${what} is not loaded until the user config trusts the path`,
  }
}

// A category no target can express is still one artefact type: a plan with no writes and one gap.
function categoryAbsentPlan(input: PlanInput, category: Category): PlanResult {
  const { target } = input
  return sealPlan(input, {
    disposition: { kind: 'mirror', reason: null },
    equivalence: {
      carried: [],
      mapped: [],
      gaps: [{ field: category, reason: 'categoryAbsent', replacement: 'dropped' }],
      preserved: [],
    },
    prerequisites: [
      { check: 'target-tier-writable', detail: `${target.tier.id} is a declared writable tier` },
    ],
    permissions: {
      tierWritability: target.tier.writability,
      // Derived, not asserted: a plan for a managed or elevated tier never reaches here.
      elevationRequired: target.tier.writability !== 'writable',
      trust: trustRequired(target.tier.id, 'skills') ? 'required' : 'notRequired',
    },
    conflicts: [],
    security: { grade: 'safe', secrets: [], executables: [] },
    writes: [],
    manualSteps: [
      {
        step: `${target.harness} cannot express ${category}; configure it there by hand`,
        why: 'the target declares no location for this category, so there is nowhere a mirror could write',
      },
    ],
    verify: [],
    targetNativeLocation: '',
    alsoReadBy: [],
  })
}

function decode<Value>(json: string, schema: z.ZodType<Value>): Value | null {
  try {
    const parsed = schema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function readTextOrNull(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

// A write into a project-scope file is correct on disk and still inert until the harness's own
// user-scope switch allows it, so the plan says so instead of claiming the mirror took effect.
function tierManualSteps(tierId: string): PlanManualStep[] {
  if (tierId === 'codex:project') return [codexTrustStep('the MCP entry')]
  if (tierId === 'oc:project' || tierId === 'oc:user') {
    return [
      {
        step: 'confirm /etc/opencode does not define this server',
        why:
          tierId === 'oc:project'
            ? 'a root-managed layer outranks the project config, so it would shadow the entry this plan writes'
            : 'a root-managed layer outranks the user config, so it would shadow the entry this plan writes; `~/.opencode/opencode.json` may outrank `~/.config/opencode` too, and that order is unverified',
      },
    ]
  }
  return []
}

// Two structural refusals, both because this slice has no remove op: an entry that already names the
// other transport would keep it, and a pointer whose parent is a literal cannot be written into.
function structuralBlocker(
  document: PlanValue | null,
  entryPointer: string,
  facts: McpFacts,
): string | null {
  if (document === null) return null
  const url = resolvePointer(document, `${entryPointer}.url`)
  const command = resolvePointer(document, `${entryPointer}.command`)
  if (url !== undefined && facts.url === undefined) {
    return `${entryPointer}.url already exists, so writing command would leave the entry HTTP; remove that url by hand first`
  }
  if (command !== undefined && facts.command === undefined) {
    return `${entryPointer}.command already exists, so writing url would leave the entry stdio; remove that command by hand first`
  }
  return null
}

interface TargetWrite {
  target: string
  value: PlanValue
}

interface Partition {
  carried: string[]
  mapped: MappedField[]
  gaps: PlanGap[]
  preserved: string[]
  writes: TargetWrite[]
  manualSteps: PlanManualStep[]
  secrets: { pointer: string; verdict: Verdict }[]
}

// Every canonical field the source holds lands in exactly one bucket: carried, mapped, a gap, or
// preserved. A key no adapter names is not here at all — `factsFromKnownFields` hands it back.
function partitionFields(facts: McpFacts, surface: McpWriteSurface, tierId: string): Partition {
  const partition: Partition = {
    carried: [],
    mapped: [],
    gaps: [],
    preserved: [],
    writes: [],
    manualSteps: [],
    secrets: [],
  }
  const consumed = new Set<string>()
  for (const field of MCP_FIELDS) {
    if (consumed.has(field)) continue
    const value = facts[field]
    if (value === undefined) continue
    const verdict = withheldVerdict(value)
    if (verdict !== 'clean') {
      // Never written, never claimed: the migrate-out instruction is the manual step.
      consumed.add(field)
      const gap: PlanGap = { field, reason: 'credential', replacement: 'dropped' }
      partition.gaps.push(gap)
      partition.secrets.push({ pointer: field, verdict })
      // The policy table decides whether a gap owes the human a step, not this branch.
      if (gapDisposition(gap.reason) === 'manualStep') {
        partition.manualSteps.push({
          step: `set ${field} on ${tierId} from the source harness's own credential store`,
          why: 'the value is credential-bearing and never leaves the engine',
        })
      }
      continue
    }
    if (!isPi(tierId) && carriesCommandRetrieval(value)) {
      const gap: PlanGap = { field, reason: 'executable', replacement: 'dropped' }
      partition.gaps.push(gap)
      if (gapDisposition(gap.reason) === 'manualStep') {
        partition.manualSteps.push({
          step: `re-create ${field} on ${tierId} without a command retrieval`,
          why: 'the source value runs a program (`!command`), which only Pi executes',
        })
      }
      continue
    }
    const rule = matchRule(surface, field, value, facts)
    if (rule !== undefined) {
      for (const name of rule.fields) consumed.add(name)
      if (rule.gap !== undefined) {
        partition.gaps.push({ field, reason: rule.gap, replacement: 'dropped' })
        continue
      }
      const native = ruleValue(rule, facts)
      // A rule with nothing left to write — every key it would set is already held by the field it
      // shares a target with — leaves the field untouched rather than claiming it was carried.
      if (rule.target !== '' && native === undefined) {
        partition.preserved.push(field)
        continue
      }
      if (rule.transform === undefined) partition.carried.push(field)
      else {
        const mapped: MappedField = {
          transform: rule.transform,
          fields: [...rule.fields],
          targetField: rule.target === '' ? null : rule.target,
        }
        if (rule.template !== undefined) mapped.template = rule.template
        partition.mapped.push(mapped)
      }
      if (native !== undefined && rule.target !== '') {
        partition.writes.push(...targetWrites(rule.target, native))
      }
      continue
    }
    if (surface.absent.includes(field)) {
      partition.gaps.push({ field, reason: 'fieldAbsent', replacement: 'dropped' })
      continue
    }
    // No rule and no declared absence: the target never saw this field, so nothing is claimed for
    // it. Reporting it here is what keeps it out of the silent-diff category.
    partition.preserved.push(field)
  }
  return partition
}

function isPi(tierId: string): boolean {
  return tierId === 'pi:user' || tierId === 'pi:project'
}

// A map is written one key at a time: the pointer is the merge unit, so `env.K` is one write.
function targetWrites(target: string, value: McpValue): TargetWrite[] {
  const map = z.record(z.string(), z.string()).safeParse(value)
  if (!map.success) return [{ target, value }]
  return Object.entries(map.data).map(([key, entry]) => ({
    target: `${target}.${pointerSegment(key)}`,
    value: entry,
  }))
}

// The entry a target will hold, built out of the partition's leaf writes, for the write that
// replaces a whole block instead of addressing one field.
function entryValue(writes: TargetWrite[]): PlanValue {
  const entry: { [key: string]: PlanValue } = {}
  for (const write of writes) {
    const segments = pointerSegments(write.target)
    let node = entry
    for (const segment of segments.slice(0, -1)) {
      const child = planObjectSchema.safeParse(node[segment] ?? {})
      const next = child.success ? child.data : {}
      node[segment] = next
      node = next
    }
    node[segments.at(-1) ?? ''] = write.value
  }
  return entry
}

type LegacyBlock =
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string }
  | {
      kind: 'normalised'
      document: PlanValue
      value: PlanValue
      pointer: string
      rewritten: { name: string; spellings: string[] }[]
    }

// The document the plan reads, with OpenCode's legacy flat entries already moved under
// `mcp.servers`: only OpenCode keeps an old shape beside its new one, so no other target normalises.
function legacyBlock(document: PlanValue | null, target: PlanTarget): LegacyBlock {
  if (document === null || target.harness !== 'opencode') return { kind: 'absent' }
  const normalised = normaliseLegacyMcp(document)
  if (normalised.kind === 'invalid') {
    return {
      kind: 'invalid',
      detail: `${normalised.detail}, so the legacy shape in this file cannot be normalised into one shape`,
    }
  }
  if (normalised.kind === 'absent') return { kind: 'absent' }
  const root = planObjectSchema.safeParse(document)
  if (!root.success) return { kind: 'absent' }
  const value = planObjectSchema.parse(normalised.value)
  return {
    kind: 'normalised',
    document: { ...root.data, mcp: value },
    value,
    pointer: 'mcp',
    rewritten: normalised.rewritten,
  }
}

// One write replaces the whole block: the mirrored entry under `mcp.servers`, every sibling carried
// across in the shape OpenCode reads today. Siblings come from a file this engine did not write, so the value
// is classified before it can reach the plan — a literal token in one refuses the plan rather than
// travelling with it, because a withheld marker cannot be written back into a config.
function normalisedWrite(
  file: string,
  precondition: PlanWrite['precondition'],
  legacy: { value: PlanValue; pointer: string },
  document: PlanValue | null,
  name: string,
  partition: Partition,
): { kind: 'ok'; write: PlanWrite } | { kind: 'refused'; reason: string } {
  const container = planObjectSchema.parse(legacy.value)
  const servers = planObjectSchema.parse(container.servers ?? {})
  const previous = planObjectSchema.safeParse(servers[name])
  if (servers[name] !== undefined && !previous.success) {
    return {
      kind: 'refused',
      reason: `mcp.servers.${name} is not a server entry, so the normalised block cannot be written over it`,
    }
  }
  const entry = mergeEntry(previous.success ? previous.data : {}, planObjectSchema.parse(entryValue(partition.writes)))
  const value: PlanValue = { ...container, servers: { ...servers, [name]: entry } }
  // Both the value and the block it replaces are classified, because `priorValue` is shown verbatim:
  // an unclean leaf in either one refuses the plan instead of travelling with it.
  const prior = resolvePointer(document, legacy.pointer)
  const unclean = uncleanPointer(value, legacy.pointer) ?? uncleanPointer(prior ?? null, legacy.pointer)
  if (unclean !== null) {
    return {
      kind: 'refused',
      reason: `${unclean} holds a credential-shaped value, and the legacy entries have to be carried across to leave one shape; move that value to the harness's own indirection by hand first`,
    }
  }
  return {
    kind: 'ok',
    write: {
      op: 'writeAtPointer',
      file,
      pointer: legacy.pointer,
      value,
      precondition,
      reversible: true,
      priorValue: prior ?? null,
      executable: false,
      secretValues: false,
      irreversible: false,
    },
  }
}

// The first leaf of this value the classifier will not call clean, by its own address. The last two
// steps are the canonical pointer, exactly as `priorValueAt` reads one — `environment` under the
// name the credential pointers use — so a value at `env.K` is a `secret` by pointer alone, whatever
// it looks like.
function uncleanPointer(value: PlanValue | null, pointer: string): string | null {
  if (value === null) return null
  const scalar = z.string().safeParse(value)
  if (scalar.success) return cleanAt(pointer, scalar.data) ? null : pointer
  const list = z.array(planValueSchema).safeParse(value)
  if (list.success) {
    for (const [index, item] of list.data.entries()) {
      const found = uncleanPointer(item, `${pointer}.${index}`)
      if (found !== null) return found
    }
    return null
  }
  const object = planObjectSchema.safeParse(value)
  if (!object.success) return null
  for (const [key, entry] of Object.entries(object.data)) {
    const found = uncleanPointer(entry, `${pointer}.${pointerSegment(key)}`)
    if (found !== null) return found
  }
  return null
}

// The pointers a carried block can hold that the vocabulary never names: an OpenCode `oauth` table is
// deliberately left out of the facts, so its client secret has no classifier rule of its own.
const CARRIED_POINTERS: readonly CredentialPointer[] = [
  ...MCP_CREDENTIAL_POINTERS,
  { pointer: 'oauth.client_secret', kind: 'leaf' },
]

// One carried value, judged at its own address. `environment`/`headers` are the credential pointers
// (`env.<K>`, `headers.<H>`); a url is judged as an address, because what is wrong with a
// credential-bearing one is inside the value; anything else falls to the classifier's own rules.
function cleanAt(pointer: string, value: string): boolean {
  const canonical = pointerSegments(pointer)
    .slice(-2)
    .map((segment) => (segment === 'environment' ? 'env' : segment))
    .join('.')
  if (canonical === 'oauth.client_secret') {
    return classify(canonical, value, CARRIED_POINTERS).verdict === 'clean'
  }
  if (canonical === 'url' || canonical.endsWith('.url')) return urlVerdict(value) === 'clean'
  return classify(canonical, value, CARRIED_POINTERS).verdict === 'clean'
}

// The mirrored entry as the write leaves it: the source's fields, and for a table the target already
// holds — `timeout`, `environment`, `headers` — its own keys kept. Pi has no startup timeout, so a
// carried `timeout.startup` or `catalog` survives a write that only supplies `execution`.
function mergeEntry(carried: Record<string, PlanValue>, proposed: Record<string, PlanValue>) {
  const merged = { ...carried }
  for (const [key, value] of Object.entries(proposed)) {
    const table = planObjectSchema.safeParse(value)
    const existing = planObjectSchema.safeParse(merged[key])
    merged[key] = table.success && existing.success ? { ...existing.data, ...table.data } : value
  }
  return merged
}

// The block rewrite is the one write this slice makes over bytes it did not address itself, so the
// human is told what it costs instead of discovering it after the fact.
function legacySteps(legacy: LegacyBlock): PlanManualStep[] {
  if (legacy.kind !== 'normalised') return []
  const steps: PlanManualStep[] = [
    {
      step: 'review the normalised mcp block once it has been written',
      why: 'the legacy flat entries move under mcp.servers in one write, so comments inside the old mcp block do not survive it',
    },
  ]
  // A sibling's spelling had to change for the block to have one shape, and nothing in the plan
  // asked for that, so it is named rather than changed quietly.
  for (const { name, spellings } of legacy.rewritten) {
    steps.push({
      step: `review mcp.servers.${name} in the normalised block`,
      why: `this entry was written flat, so it is rewritten as ${spellings.join(' and ')}`,
    })
  }
  return steps
}

function carriesCommandRetrieval(value: McpValue): boolean {
  const map = z.record(z.string(), z.string()).safeParse(value)
  if (map.success) return Object.values(map.data).some((entry) => entry.startsWith('!'))
  const scalar = z.string().safeParse(value)
  return scalar.success && scalar.data.startsWith('!')
}

// A prior value is read from a file this engine did not write, so it is classified before it can
// reach the plan: a literal token already on disk is withheld exactly as the source's would be. The
// classifier runs on the pointer's canonical last two segments (`env.GH_TOKEN`), because that is the
// form its declared credential pointers match — and its reference rule runs first, so a `${VAR}` or
// `!command` already at a credential address stays readable.
function priorValueAt(document: PlanValue | null, pointer: string): PlanValue {
  return classifyAt(pointer, resolvePointer(document ?? null, pointer)) ?? null
}

// A value read back from a file this engine did not write is classified before it is shown or
// compared: a literal token already on disk stays withheld, exactly as the source's would be.
function classifyAt(pointer: string, value: PlanValue | undefined): PlanValue | undefined {
  if (value === undefined) return undefined
  const scalar = z.string().safeParse(value)
  if (!scalar.success) return value
  const canonical = pointerSegments(pointer).slice(-2).join('.')
  const { verdict } = classify(canonical, scalar.data, MCP_CREDENTIAL_POINTERS)
  return verdict === 'clean' ? scalar.data : withheldMarker(verdict)
}

// One pointer read from a file as it stands now, which is how verification asserts a plan and how a
// re-read after a manual step re-asserts it.
export function readPointer(
  file: string,
  pointer: string,
): { kind: 'ok'; value: PlanValue | undefined } | { kind: 'unreadable' } {
  const target = readTargetFile(file)
  if (target.kind === 'unreadable') return { kind: 'unreadable' }
  const document = target.kind === 'parsed' ? target.document : null
  return { kind: 'ok', value: classifyAt(pointer, resolvePointer(document, pointer)) }
}

function resolvePointer(document: PlanValue | null, pointer: string): PlanValue | undefined {
  let node: PlanValue | undefined = document ?? undefined
  for (const segment of pointerSegments(pointer)) {
    const object = planObjectSchema.safeParse(node)
    if (!object.success) return undefined
    node = object.data[segment]
  }
  return node
}

// A pointer whose parent is a literal value cannot be written into: the plan would replace the
// literal with a table while its own `priorValue` read the literal as absent.
function ancestorBlocker(document: PlanValue | null, pointer: string): string | null {
  if (document === null) return null
  const segments = pointerSegments(pointer)
  let node: PlanValue | undefined = document
  for (let index = 0; index < segments.length - 1; index += 1) {
    const object = planObjectSchema.safeParse(node)
    if (!object.success) {
      if (node === undefined) return null
      return `${segments.slice(0, index).join('.')} is a literal ${JSON.stringify(node)}, so ${pointer} cannot be written into it`
    }
    node = object.data[segments[index] ?? '']
  }
  // The last step reaches the leaf's own parent, which has to be a table as well.
  if (node === undefined || planObjectSchema.safeParse(node).success) return null
  return `${segments.slice(0, -1).join('.')} is a literal ${JSON.stringify(node)}, so ${pointer} cannot be written into it`
}

// The tier owns the file it writes: the file it already reads, or the first candidate it declares
// when nothing is on disk yet.
function targetFile(tier: Tier): string {
  return tier.configPaths.find((candidate) => existsSync(candidate)) ?? tier.configPaths[0] ?? ''
}

// A tier can hold the same server in more than one candidate file (OpenCode reads `opencode.json`
// and `.opencode/opencode.json`), and which one wins is not verified. Writing the first while the
// other defines the same entry would leave two definitions, so that is refused rather than guessed.
function ambiguousTarget(tier: Tier, chosen: string, addresses: string[]): string | null {
  for (const candidate of tier.configPaths) {
    if (candidate === chosen || !existsSync(candidate)) continue
    const other = readTargetFile(candidate)
    if (other.kind !== 'parsed') continue
    const defined = addresses.find((address) => resolvePointer(other.document, address) !== undefined)
    if (defined === undefined) continue
    return `${defined} is defined in both ${chosen} and ${candidate}; which one ${tier.id} honours is not verified, so remove one by hand`
  }
  return null
}

// A location more than one harness reads has to be reported, because a write there lands for every
// one of them. Computed from the declared tier paths, not from a list of known shared places — which
// is how a mirror into `.agents/skills` names the two harnesses that load it beside the target.
export function alsoReadBy(
  adapters: readonly Adapter[],
  targetHarness: HarnessId,
  file: string,
): HarnessId[] {
  const others = adapters
    .filter((adapter) => adapter.harness !== targetHarness)
    .filter((adapter) => adapter.tiers.some((tier) => declaresReadPath(tier, file)))
    .map((adapter) => adapter.harness)
  return [...new Set(others)]
}

type TargetFile =
  | { kind: 'absent' }
  | { kind: 'parsed'; document: PlanValue; digest: string }
  | { kind: 'unreadable' }

// One read of the target answers both questions the plan asks of it — what is there now, and what
// bytes the precondition names — so the digest can never describe a different read than the values.
function readTargetFile(file: string): TargetFile {
  if (file === '' || !existsSync(file)) return { kind: 'absent' }
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch {
    return { kind: 'unreadable' }
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  try {
    const text = bytes.toString('utf8')
    const parsed = file.endsWith('.toml') ? parseToml(text) : JSON.parse(stripJsonc(text))
    const document = planValueSchema.safeParse(parsed)
    return document.success ? { kind: 'parsed', document: document.data, digest } : { kind: 'unreadable' }
  } catch {
    return { kind: 'unreadable' }
  }
}

// One artefact type, no error channel: a target that already says everything the plan would write,
// or that is where the source already lives, comes back with no writes and the reason stated.
function dispositionOf(
  file: string,
  source: PlanSource,
  writes: PlanWrite[],
  targetExists: boolean,
): MirrorPlan['disposition'] {
  if (path.resolve(file) === path.resolve(source.nativeFile)) {
    return {
      kind: 'alreadyShared',
      reason: `${file} is where ${source.nativePointer} already lives, so there is nothing to copy`,
    }
  }
  const matches =
    targetExists &&
    writes.length > 0 &&
    writes.every(
      (write) =>
        write.op === 'writeAtPointer' &&
        JSON.stringify(write.priorValue) === JSON.stringify(write.value),
    )
  if (matches) {
    return { kind: 'alreadyPresent', reason: `${file} already holds every value this plan would write` }
  }
  return { kind: 'mirror', reason: null }
}

// A plan's id is the hash of its own body. Recomputing it after a hand edit cannot match, which is
// what makes the document self-identifying without a plan store.
export function planIdOf(body: PlanValue): string {
  return `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

export function canonicalJson(value: PlanValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = planObjectSchema.safeParse(value)
  if (!object.success) return JSON.stringify(value)
  const entries = Object.entries(object.data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

// `planId` is recomputed from everything else, so an edited body fails this check.
export function planIntact(plan: MirrorPlan): boolean {
  return intactDocument(toPlanValue(plan))
}

function intactDocument(document: PlanValue): boolean {
  const { planId, ...body } = planObjectSchema.parse(document)
  return planIdOf(body) === planId
}

// Anything a plan carries, as the JSON tree the value schema accepts: optional fields the plan did
// not fill in drop out the way JSON drops them, so the id covers what the document says.
function toPlanValue(body: PlanBody): PlanValue {
  return planValueSchema.parse(JSON.parse(JSON.stringify(body)))
}
