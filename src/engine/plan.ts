import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import {
  MCP_FIELDS,
  factsFromKnownFields,
  pointerSegment,
  pointerSegments,
  withheldVerdict,
  type McpFacts,
  type McpValue,
} from './adapters/mcp-facts.ts'
import { matchRule, ruleValue, type McpWriteSurface, type Transform } from './adapters/mcp-write.ts'
import { stripJsonc } from './adapters/opencode/read.ts'
import type { Adapter, HarnessId, Tier, Writability } from './adapters/types.ts'
import type { Verdict } from './secret.ts'

// shortcut: a plan records the tool version that built it so an old blob can be told from a new one.
// A constant until a build stamps the real one.
export const TOOL_VERSION = '0.1.0'

// Any value a plan carries: a native config value, a prior value, an assertion's expectation.
export type PlanValue = string | number | boolean | null | PlanValue[] | { [key: string]: PlanValue }

const planValueSchema: z.ZodType<PlanValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(planValueSchema),
    z.record(z.string(), planValueSchema),
  ]),
)

const planObjectSchema = z.record(z.string(), planValueSchema)

export interface MappedField {
  transform: Transform
  fields: string[]
  // Null when the target carries the fact through another field's presence (`transport`).
  targetField: string | null
  template?: string
}

export type GapReason = 'fieldAbsent' | 'shapeOnly' | 'credential' | 'executable' | 'categoryAbsent'

export interface PlanGap {
  field: string
  reason: GapReason
  replacement: 'renamed' | 'inverted' | 'dropped'
}

export interface PlanWrite {
  op: 'writeAtPointer'
  file: string
  pointer: string
  value: PlanValue
  precondition: { exists: boolean; digest: string | null }
  reversible: boolean
  priorValue: PlanValue
  executable: boolean
  secretValues: boolean
  irreversible: boolean
}

export interface PlanConflict {
  file: string
  pointer: string
  current: PlanValue
  proposed: PlanValue
}

export interface PlanManualStep {
  step: string
  why: string
}

export interface PlanAssert {
  file: string
  pointer: string
  equals: PlanValue
}

export interface MirrorPlan {
  planId: string
  createdAt: string
  toolVersion: string
  kind: 'mirror'
  source: {
    installationId: string
    harness: string
    tierId: string
    scope: string
    nativeLocation: string
    knownFields: McpFacts
    contentDigest: string
  }
  target: {
    harness: HarnessId
    tierId: string
    scope: string
    nativeLocation: string
    alsoReadBy: HarnessId[]
  }
  equivalence: {
    carried: string[]
    mapped: MappedField[]
    gaps: PlanGap[]
    preserved: string[]
  }
  prerequisites: { check: string; detail: string }[]
  permissions: {
    tierWritability: Writability
    elevationRequired: boolean
    trust: 'notRequired' | 'required'
  }
  conflicts: PlanConflict[]
  security: {
    grade: 'safe' | 'risky'
    secrets: { pointer: string; verdict: Verdict }[]
    executables: { file: string; why: string }[]
  }
  writes: PlanWrite[]
  manualSteps: PlanManualStep[]
  verify: { asserts: PlanAssert[] }
}

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

export function buildPlan(input: PlanInput): PlanResult {
  const { source, target } = input
  const file = targetFile(target.tier)
  const existing = readTargetDocument(file)
  if (existing.kind === 'unreadable') {
    return {
      kind: 'refused',
      reason: `${file} exists but cannot be parsed, so the target's current values are unknown`,
    }
  }
  const known = factsFromKnownFields(source.knownFieldsJson)
  const partition = partitionFields(known.facts, target.surface, target.tier.id)
  const entryPointer = `${target.surface.pointerPrefix}.${pointerSegment(source.name)}`
  const precondition = { exists: existing.kind === 'parsed', digest: digestOf(file) }
  const prior = existing.kind === 'parsed' ? existing.document : null
  const writes: PlanWrite[] = partition.writes.map((write) => {
    const pointer = `${entryPointer}.${write.target}`
    return {
      op: 'writeAtPointer',
      file,
      pointer,
      value: write.value,
      precondition,
      reversible: true,
      priorValue: pointerAt(prior, pointer),
      executable: false,
      secretValues: false,
      irreversible: false,
    }
  })
  const conflicts = writes.flatMap<PlanConflict>((write) => {
    if (write.priorValue === null || JSON.stringify(write.priorValue) === JSON.stringify(write.value)) {
      return []
    }
    return [{ file, pointer: write.pointer, current: write.priorValue, proposed: write.value }]
  })
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
      preserved: known.unknown,
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
      executables: [],
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

interface TargetWrite {
  target: string
  value: PlanValue
}

interface Partition {
  carried: string[]
  mapped: MappedField[]
  gaps: PlanGap[]
  writes: TargetWrite[]
  manualSteps: PlanManualStep[]
  secrets: { pointer: string; verdict: Verdict }[]
}

// Every canonical field the source holds lands in exactly one bucket: carried, mapped, or a gap. A
// key no adapter names is not here at all — `factsFromKnownFields` hands it back as preserved.
function partitionFields(facts: McpFacts, surface: McpWriteSurface, tierId: string): Partition {
  const partition: Partition = {
    carried: [],
    mapped: [],
    gaps: [],
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
      const native = ruleValue(rule, facts)
      if (native !== undefined && rule.target !== '') {
        partition.writes.push(...targetWrites(rule.target, native))
      }
      continue
    }
    if (surface.absent.includes(field)) {
      partition.gaps.push({ field, reason: 'fieldAbsent', replacement: 'dropped' })
    }
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

// The tier owns the file it writes: the first candidate that exists, or the first it declares when
// nothing is on disk yet.
function targetFile(tier: Tier): string {
  return tier.configPaths.find((candidate) => existsSync(candidate)) ?? tier.configPaths[0] ?? ''
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

function digestOf(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
  } catch {
    return null
  }
}

type TargetDocument =
  | { kind: 'absent' }
  | { kind: 'parsed'; document: PlanValue }
  | { kind: 'unreadable' }

function readTargetDocument(file: string): TargetDocument {
  if (file === '' || !existsSync(file)) return { kind: 'absent' }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { kind: 'unreadable' }
  }
  try {
    const parsed = file.endsWith('.toml') ? parseToml(text) : JSON.parse(stripJsonc(text))
    const document = planValueSchema.safeParse(parsed)
    return document.success ? { kind: 'parsed', document: document.data } : { kind: 'unreadable' }
  } catch {
    return { kind: 'unreadable' }
  }
}

function pointerAt(document: PlanValue | null, pointer: string): PlanValue {
  let node: PlanValue | undefined = document ?? undefined
  for (const segment of pointerSegments(pointer)) {
    const object = planObjectSchema.safeParse(node)
    if (!object.success) return null
    node = object.data[segment]
  }
  return node ?? null
}

// The engine grades the plan, not the caller: a location that is not on disk yet or a value that
// disagrees with it both mean a human answer is required before apply.
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
  const { planId, ...body } = plan
  return planIdOf(toPlanValue(body)) === planId
}

// Anything a plan carries, as the JSON tree the value schema accepts: optional fields the plan did
// not fill in drop out the way JSON drops them, so the id covers what the document says.
function toPlanValue(body: PlanBody): PlanValue {
  return planValueSchema.parse(JSON.parse(JSON.stringify(body)))
}
