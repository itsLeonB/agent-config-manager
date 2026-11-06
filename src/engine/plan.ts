import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import type { Json } from '../types/dashboard'
import {
  MCP_CREDENTIAL_POINTERS,
  MCP_FIELDS,
  factsFromKnownFields,
  pointerSegment,
  pointerSegments,
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
import { stripJsonc } from './adapters/opencode/read.ts'
import { HARNESSES, WRITABILITIES, type Adapter, type HarnessId, type Tier } from './adapters/types.ts'
import { VERDICTS, classify, withheldMarker, type Verdict } from './secret.ts'

// shortcut: a plan records the tool version that built it so an old blob can be told from a new one.
// A constant until a build stamps the real one.
export const TOOL_VERSION = '0.1.0'

// Any value a plan carries: a native config value, a prior value, an assertion's expectation.
export type PlanValue = string | number | boolean | null | PlanValue[] | { [key: string]: PlanValue }

export const planValueSchema: z.ZodType<PlanValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(planValueSchema),
    z.record(z.string(), planValueSchema),
  ]),
)

export const planObjectSchema = z.record(z.string(), planValueSchema)

// The document, and the only place its shape is written down: the types below are inferred from the
// schemas, so a field added to the plan cannot be missing from what apply validates.
const mappedFieldSchema = z.object({
  transform: z.enum(TRANSFORMS),
  fields: z.array(z.string()),
  // Null when the target carries the fact through another field's presence (`transport`).
  targetField: z.string().nullable(),
  template: z.string().optional(),
})

const planGapSchema = z.object({
  field: z.string(),
  reason: z.enum(['fieldAbsent', 'shapeOnly', 'credential', 'executable', 'categoryAbsent']),
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
export type GapReason = z.infer<typeof planGapSchema>['reason']
export type PlanGap = z.infer<typeof planGapSchema>
export type PlanConflict = z.infer<typeof planConflictSchema>
export type PlanManualStep = z.infer<typeof planManualStepSchema>
export type PlanAssert = z.infer<typeof planAssertSchema>
export type PlanWrite = z.infer<typeof planWriteSchema>

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
  const ambiguous = ambiguousTarget(target.tier, file, entryPointer)
  if (ambiguous !== null) return { kind: 'refused', reason: ambiguous }
  const document = existing.kind === 'parsed' ? existing.document : null
  const blocker = structuralBlocker(document, entryPointer, known.facts)
  if (blocker !== null) return { kind: 'refused', reason: blocker }

  const partition = partitionFields(known.facts, target.surface, target.tier.id)
  const precondition = {
    exists: existing.kind === 'parsed',
    digest: existing.kind === 'parsed' ? existing.digest : null,
  }
  const writes: PlanWrite[] = partition.writes.map((write) => {
    const pointer = `${entryPointer}.${write.target}`
    const runs = z.string().safeParse(write.value)
    return {
      op: 'writeAtPointer',
      file,
      pointer,
      value: write.value,
      precondition,
      reversible: true,
      priorValue: priorValueAt(document, pointer),
      executable: runs.success && runs.data.startsWith('!'),
      secretValues: false,
      irreversible: false,
    }
  })
  const blocked = writes
    .map((write) => ancestorBlocker(document, write.pointer))
    .find((found) => found !== null)
  if (blocked !== null && blocked !== undefined) return { kind: 'refused', reason: blocked }
  const conflicts = writes.flatMap<PlanConflict>((write) => {
    if (write.priorValue === null || JSON.stringify(write.priorValue) === JSON.stringify(write.value)) {
      return []
    }
    return [{ file, pointer: write.pointer, current: write.priorValue, proposed: write.value }]
  })
  const executables = writes
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
    conflicts,
    security: {
      grade: gradeOf(conflicts, writes, precondition.exists),
      secrets: partition.secrets,
      executables,
    },
    writes,
    manualSteps: [...partition.manualSteps, ...tierManualSteps(target.tier.id)],
    verify: {
      asserts: writes.map((write) => ({
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
  if (tierId === 'oc:project') {
    return [
      {
        step: 'confirm /etc/opencode does not define this server',
        why: 'a root-managed layer outranks the project config, so it would shadow the entry this plan writes',
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
      partition.gaps.push({ field, reason: 'credential', replacement: 'dropped' })
      partition.secrets.push({ pointer: field, verdict })
      partition.manualSteps.push({
        step: `set ${field} on ${tierId} from the source harness's own credential store`,
        why: 'the value is credential-bearing and never leaves the engine',
      })
      continue
    }
    if (!isPi(tierId) && carriesCommandRetrieval(value)) {
      partition.gaps.push({ field, reason: 'executable', replacement: 'dropped' })
      partition.manualSteps.push({
        step: `re-create ${field} on ${tierId} without a command retrieval`,
        why: 'the source value runs a program (`!command`), which only Pi executes',
      })
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
function ambiguousTarget(tier: Tier, chosen: string, entryPointer: string): string | null {
  for (const candidate of tier.configPaths) {
    if (candidate === chosen || !existsSync(candidate)) continue
    const other = readTargetFile(candidate)
    if (other.kind !== 'parsed') continue
    if (resolvePointer(other.document, entryPointer) === undefined) continue
    return `${entryPointer} is defined in both ${chosen} and ${candidate}; which one ${tier.id} honours is not verified, so remove one by hand`
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

// The engine grades the plan, not the caller: a location that is not on disk yet, a value that
// disagrees with it, or executable content all mean a human answer is required before apply.
function gradeOf(
  conflicts: PlanConflict[],
  writes: PlanWrite[],
  targetExists: boolean,
): 'safe' | 'risky' {
  if (conflicts.length > 0 || !targetExists) return 'risky'
  return writes.some((write) => write.executable || write.secretValues || write.irreversible)
    ? 'risky'
    : 'safe'
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
