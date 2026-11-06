import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
import { HARNESSES, WRITABILITIES, type Adapter, type HarnessId, type Tier } from './adapters/types.ts'
import { planObjectSchema, planValueSchema, type PlanValue } from './plan-value.ts'
import { VERDICTS, classify, withheldMarker, type CredentialPointer, type Verdict } from './secret.ts'

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

const planAssertSchema = z.object({ file: z.string(), pointer: z.string(), equals: planValueSchema })

export const planWriteSchema = z.object({
  // One op only: the engine refuses a write it cannot perform, so a document carrying a future op
  // is refused as caller input rather than half-applied.
  op: z.literal('writeAtPointer'),
  file: z.string(),
  pointer: z.string(),
  value: planValueSchema,
  precondition: z.object({ exists: z.boolean(), digest: z.string().nullable() }),
  reversible: z.boolean(),
  priorValue: planValueSchema,
  executable: z.boolean(),
  secretValues: z.boolean(),
  irreversible: z.boolean(),
})

export type MappedField = z.infer<typeof mappedFieldSchema>
export type PlanGap = z.infer<typeof planGapSchema>
export type PlanConflict = z.infer<typeof planConflictSchema>
export type PlanManualStep = z.infer<typeof planManualStepSchema>
export type PlanAssert = z.infer<typeof planAssertSchema>
export type PlanWrite = z.infer<typeof planWriteSchema>

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
  source: z.object({
    installationId: z.string(),
    harness: z.string(),
    tierId: z.string(),
    scope: z.string(),
    nativeLocation: z.string(),
    // The source's canonical facts, already classified. Opaque to apply, which reads none of them,
    // and not re-checked field by field here: that table is the adapter's, not the plan's.
    knownFields: z.custom<McpFacts>(),
    contentDigest: z.string(),
  }),
  target: z.object({
    harness: z.enum(HARNESSES),
    tierId: z.string(),
    scope: z.string(),
    nativeLocation: z.string(),
    alsoReadBy: z.array(z.enum(HARNESSES)),
  }),
  equivalence: z.object({
    carried: z.array(z.string()),
    mapped: z.array(mappedFieldSchema),
    gaps: z.array(planGapSchema),
    preserved: z.array(z.string()),
  }),
  prerequisites: z.array(z.object({ check: z.string(), detail: z.string() })),
  permissions: z.object({
    tierWritability: z.enum(WRITABILITIES),
    elevationRequired: z.boolean(),
    trust: z.enum(['notRequired', 'required']),
  }),
  // What became of the target: one artefact type, never a separate error shape, so a plan that has
  // nothing to write still arrives as a plan and says why.
  disposition: z.object({
    kind: z.enum(['mirror', 'alreadyPresent', 'alreadyShared']),
    reason: z.string().nullable(),
  }),
  conflicts: z.array(planConflictSchema),
  security: z.object({
    grade: z.enum(['safe', 'risky']),
    secrets: z.array(z.object({ pointer: z.string(), verdict: z.enum(VERDICTS) })),
    executables: z.array(z.object({ file: z.string(), why: z.string() })),
  }),
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
  surface: McpWriteSurface
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
  const entryPointer = `${target.surface.pointerPrefix}.${pointerSegment(source.name)}`
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

  const partition = partitionFields(known.facts, target.surface, target.tier.id)
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
    .map((write) => ancestorBlocker(current, write.pointer))
    .find((found) => found !== null)
  if (blocked !== null && blocked !== undefined) return { kind: 'refused', reason: blocked }
  // Nothing to copy onto itself, and nothing to write where the target already says it: both are
  // plans with no writes and a stated reason, never a refusal or a silent rewrite.
  const disposition = dispositionOf(file, source, writes, existing.kind === 'parsed')
  const pending = disposition.kind === 'mirror' ? writes : []
  const conflicts = pending.flatMap<PlanConflict>((write) => {
    if (write.priorValue === null || JSON.stringify(write.priorValue) === JSON.stringify(write.value)) {
      return []
    }
    return [{ file, pointer: write.pointer, current: write.priorValue, proposed: write.value }]
  })
  const executables = pending
    .filter((write) => write.executable)
    .map((write) => ({ file, why: `${write.pointer} runs a command at harness runtime` }))
  const body: PlanBody = {
    createdAt: input.now,
    toolVersion: TOOL_VERSION,
    kind: 'mirror',
    source: {
      installationId: source.installationId,
      harness: source.harness,
      tierId: source.tierId,
      scope: source.scope,
      nativeLocation: `${source.nativeFile}#${source.nativePointer}`,
      knownFields: known.facts,
      contentDigest: source.contentDigest,
    },
    target: {
      harness: target.harness,
      tierId: target.tier.id,
      scope: target.tier.scopeBucket,
      nativeLocation: `${file}#${entryPointer}`,
      alsoReadBy: alsoReadBy(input.adapters, target.harness, file),
    },
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
    verify: {
      asserts: pending.map((write) => ({
        file: write.file,
        pointer: write.pointer,
        equals: write.value,
      })),
    },
  }
  return { kind: 'plan', plan: { planId: planIdOf(toPlanValue(body)), ...body } }
}

// A write into a project-scope file is correct on disk and still inert until the harness's own
// user-scope switch allows it, so the plan says so instead of claiming the mirror took effect.
function tierManualSteps(tierId: string): PlanManualStep[] {
  if (tierId === 'codex:project') {
    return [
      {
        step: 'add this project to [projects."<path>"] with trust_level = "trusted" in $CODEX_HOME/config.toml',
        why: 'Codex treats an untrusted project config as inert, so the MCP entry is not loaded until the user config trusts the path',
      },
    ]
  }
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
// one of them. Computed from the declared tier paths, not from a list of known shared places.
export function alsoReadBy(
  adapters: readonly Adapter[],
  targetHarness: HarnessId,
  file: string,
): HarnessId[] {
  const others = adapters
    .filter((adapter) => adapter.harness !== targetHarness)
    .filter((adapter) =>
      adapter.tiers.some((tier) => tier.configPaths.some((candidate) => candidate === file)),
    )
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
    writes.every((write) => JSON.stringify(write.priorValue) === JSON.stringify(write.value))
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
