import { z } from 'zod'
import { createAdapters } from './adapters/registry.ts'
import { pointerSegment, pointerSegments } from './adapters/mcp-facts.ts'
import type { Adapter } from './adapters/types.ts'
import type { Category, ScopeBucket, Writability } from './adapters/types.ts'
import {
  containmentFault,
  executePlan,
  verifyPlan,
  type ApplyOptions,
  type ApplyResult,
  type VerifyResult,
} from './apply.ts'
import type { EngineConfig } from './config.ts'
import {
  buildPlan,
  validatePlan,
  type MirrorPlan,
  type PlanResult,
  type PlanSource,
} from './plan.ts'
import type { Json } from '../types/dashboard'
import { readInventory, recordApply, recordDiscovery } from './repo.ts'
import type { TierReport } from './repo.ts'
import { storedVerdict, type Verdict } from './secret.ts'
import type { InstallationRow, TierHealthRow } from '../server/store.cjs'

export type { ApplyResult, VerifyResult }

export interface DiscoverResult {
  scannedAt: string
  installations: number
  tierHealth: { harness: string; tierId: string; status: string; detail: string | null }[]
}

// One pass over every adapter tier. `acm list` and the later MCP tools both call this, so there is
// a single code path for "inventory" and no separate live-query mode.
export function discover(config: EngineConfig): DiscoverResult {
  const scannedAt = new Date().toISOString()
  const reports = new Map<string, TierReport>()
  for (const adapter of createAdapters(config)) {
    for (const category of adapter.claimedCategories) {
      const handler = adapter.handlers[category]
      if (handler === undefined) continue
      for (const tier of adapter.tiers) {
        // Only a writable tier is inventoried and measured. `codex:profile` and `oc:system` are
        // declared so a listing can name them and mark them unwritable, but a launch-time or
        // root-managed layer is not something ACM reads.
        if (tier.writability !== 'writable') continue
        const read = handler.read(tier)
        const merged = reports.get(`${adapter.harness}/${tier.id}`)
        // Tombstoning is per (harness, tier), so every category's installations for one tier reach
        // the store in one report; a second report for the same tier would tombstone the first
        // category's rows.
        if (merged === undefined) {
          reports.set(`${adapter.harness}/${tier.id}`, {
            ...read,
            harness: adapter.harness,
            tierId: tier.id,
          })
          continue
        }
        merged.installations.push(...read.installations)
        if (read.health !== 'ok') {
          merged.health = read.health
          merged.detail = read.detail
        }
      }
    }
  }
  const merged = [...reports.values()]
  recordDiscovery(config.storePath, merged, scannedAt)
  return {
    scannedAt,
    installations: merged.reduce((total, report) => total + report.installations.length, 0),
    tierHealth: merged.map((report) => ({
      harness: report.harness,
      tierId: report.tierId,
      status: report.health,
      detail: report.detail,
    })),
  }
}

export interface ListFilter {
  category?: string
  harness?: string
  scope?: string
  includeRemoved?: boolean
}

export interface Inventory {
  scannedAt: string | null
  installations: InstallationRow[]
  tierHealth: TierHealthRow[]
  harnesses: HarnessSummary[]
}

// The harness row a listing carries: which categories that harness is read for, and which tiers
// exist, so an agent can tell a target tier from one it must not touch. Tiers are adapter-declared
// facts, not inventory, so they are read from the adapters rather than stored.
export interface HarnessSummary {
  harness: string
  readCategories: Category[]
  tiers: {
    id: string
    nativeLabel: string
    rank: number
    scopeBucket: ScopeBucket
    writability: Writability
  }[]
}

export function listInstallations(config: EngineConfig, filter: ListFilter): Inventory {
  const inventory = readInventory(config.storePath, filter)
  return {
    // The scan time comes from tier health, not from the rows being listed: a filter that matches
    // nothing still has to report when the last pass ran.
    scannedAt: newestScan(inventory.tierHealth),
    installations: inventory.installations,
    // Filtered like the rows, so `--harness codex` does not print another harness's unreadable tier.
    tierHealth: inventory.tierHealth.filter(
      (row) => filter.harness === undefined || row.harness === filter.harness,
    ),
    harnesses: createAdapters(config)
      .filter((adapter) => filter.harness === undefined || adapter.harness === filter.harness)
      .map((adapter) => ({
        harness: adapter.harness,
        readCategories: [...adapter.claimedCategories],
        tiers: adapter.tiers.map((tier) => ({
          id: tier.id,
          nativeLabel: tier.nativeLabel,
          rank: tier.rank,
          scopeBucket: tier.scopeBucket,
          writability: tier.writability,
        })),
      })),
  }
}

function newestScan(tierHealth: TierHealthRow[]): string | null {
  return tierHealth.reduce<string | null>(
    (latest, row) => (latest === null || row.at > latest ? row.at : latest),
    null,
  )
}

export interface Inspection {
  installation: InstallationRow
  // Where the row came from: when it was first and last seen, and when it left the config.
  provenance: Provenance
  // The stored known fields, already secret-free: a credential-bearing value is a marker carrying
  // its own verdict, never the value.
  leaves: KnownLeaf[]
  secrets: { pointer: string; verdict: Verdict }[]
  executables: { pointer: string; why: string }[]
  alsoReadBy: string[]
}

export interface Provenance {
  firstSeenAt: string
  lastSeenAt: string
  removedAt: string | null
}

export interface KnownLeaf {
  pointer: string
  value: string
}

export type InspectResult =
  | { kind: 'ok'; inspection: Inspection }
  | { kind: 'notFound' }
  | { kind: 'ambiguous'; ids: string[] }

// One installation named by a prefix of its id. `inspect` and `plan` both resolve a caller's
// reference this way, so a prefix that names two rows is reported by either of them.
type InstallationLookup =
  | { kind: 'ok'; row: InstallationRow }
  | { kind: 'notFound' }
  | { kind: 'ambiguous'; ids: string[] }

function findInstallation(config: EngineConfig, idOrPrefix: string): InstallationLookup {
  const wanted = idOrPrefix.replace(/^sha256:/, '')
  if (wanted === '') return { kind: 'notFound' }
  const matches = readInventory(config.storePath, { includeRemoved: true }).installations.filter(
    (row) => row.id.replace(/^sha256:/, '').startsWith(wanted),
  )
  if (matches.length > 1) return { kind: 'ambiguous', ids: matches.map((row) => row.id) }
  const row = matches[0]
  return row === undefined ? { kind: 'notFound' } : { kind: 'ok', row }
}

// A plan is a read: it resolves the source row the last scan stored and re-reads only the target
// file, for its current digest. A tier that is not a declared writable one is refused here, as
// caller input, so a doomed plan never reaches a human.
export function planMirror(
  config: EngineConfig,
  idOrPrefix: string,
  targetRef: string,
): PlanResult {
  const separator = targetRef.indexOf(':')
  const harness = separator === -1 ? '' : targetRef.slice(0, separator)
  if (harness === '' || harness === targetRef) {
    return { kind: 'refused', reason: `a target is <harness:tier>, not ${JSON.stringify(targetRef)}` }
  }
  const adapters = createAdapters(config)
  // A tier id already carries its harness (`codex:user`, `oc:user`), so the reference is the id
  // itself and the adapter that declares it owns the write.
  const [owned] = adapters.flatMap((adapter) =>
    adapter.tiers.filter((tier) => tier.id === targetRef).map((tier) => ({ adapter, tier })),
  )
  if (owned === undefined) {
    const declared = adapters.find((candidate) => candidate.harness === harness)
    if (declared === undefined) {
      const known = adapters.map((candidate) => candidate.harness).join(', ')
      return { kind: 'refused', reason: `unknown harness ${JSON.stringify(harness)}; known: ${known}` }
    }
    const known = declared.tiers.map((candidate) => candidate.id).join(', ')
    return {
      kind: 'refused',
      reason: `unknown tier ${JSON.stringify(targetRef)}; ${harness} declares: ${known}`,
    }
  }
  const adapter = owned.adapter
  const tier = owned.tier
  if (tier.writability !== 'writable') {
    return {
      kind: 'refused',
      reason: `${tier.id} is ${tier.writability}: a mirror target must be a writable tier`,
    }
  }
  const lookup = findInstallation(config, idOrPrefix)
  if (lookup.kind === 'notFound') {
    return {
      kind: 'refused',
      reason: `no installation matches ${JSON.stringify(idOrPrefix)} in the last scan; run \`acm list\` to refresh the inventory`,
    }
  }
  if (lookup.kind === 'ambiguous') {
    return {
      kind: 'refused',
      reason: `ambiguous id ${JSON.stringify(idOrPrefix)}: ${lookup.ids.map((id) => JSON.stringify(id)).join(', ')}`,
    }
  }
  const row = lookup.row
  // A tombstone is a source the last scan no longer found on disk; the plan would name bytes that
  // are gone, and its target preconditions would still look satisfiable.
  if (row.removedAt !== null) {
    return {
      kind: 'refused',
      reason: `${row.id} was removed from ${JSON.stringify(row.nativeFile)} by a later scan; nothing left to mirror`,
    }
  }
  if (row.category !== 'mcp' && row.category !== 'skills' && row.category !== 'instructions') {
    return { kind: 'refused', reason: `${row.category} has no mirror planner yet` }
  }
  const binding = row.bindings[0]
  const source: PlanSource = {
    installationId: row.id,
    category: row.category,
    harness: binding?.harness ?? '',
    tierId: binding?.tierId ?? '',
    scope: row.scope,
    name: row.name,
    nativeFile: row.nativeFile,
    nativePointer: row.nativePointer ?? '',
    knownFieldsJson: row.knownFieldsJson,
    contentDigest: row.contentDigest ?? '',
  }
  return buildPlan({
    adapters,
    source,
    target: { harness: adapter.harness, tier, surface: adapter.mcpWrite },
    now: new Date().toISOString(),
  })
}

// A plan is a JSON document: normalising here is what makes one built in process and one parsed
// from a file hash the same way.
function asDocument(rawPlan: Json | MirrorPlan): Json {
  return JSON.parse(JSON.stringify(rawPlan))
}

// Applying takes the document a caller was given and executes it; nothing is re-derived, so a plan
// that no longer matches its targets is reported stale instead of being quietly re-planned.
export function applyPlan(
  config: EngineConfig,
  rawPlan: Json | MirrorPlan,
  options: ApplyOptions = {},
): ApplyResult {
  const validated = validatePlan(asDocument(rawPlan))
  if (validated.kind === 'refused') {
    return {
      outcome: 'refused',
      planId: null,
      reason: validated.reason,
      grade: null,
      consent: null,
      landed: [],
      failed: null,
      verification: null,
      manualSteps: [],
    }
  }
  const adapters = createAdapters(config)
  const plan = validated.plan
  const result = executePlan(config, adapters, plan, options)
  const grade = result.grade
  if (grade !== null && (result.outcome === 'applied' || result.outcome === 'partial')) {
    recordMirror(config, adapters, plan, result, grade)
  }
  return result
}

export type VerifyDocumentResult =
  | { kind: 'refused'; reason: string }
  | { kind: 'ok'; verification: VerifyResult }

// Verification of a document nobody has applied yet is the same face as apply: validate the
// document, run the same containment over the files it names, then re-read them. A plan is a
// caller-supplied document, so its assertions are not a licence to read any path it likes.
export function verifyPlanDocument(
  config: EngineConfig,
  rawPlan: Json | MirrorPlan,
): VerifyDocumentResult {
  const validated = validatePlan(asDocument(rawPlan))
  if (validated.kind === 'refused') return { kind: 'refused', reason: validated.reason }
  const fault = containmentFault(config, createAdapters(config), validated.plan)
  if (fault !== null) return { kind: 'refused', reason: fault }
  return { kind: 'ok', verification: verifyPlan(validated.plan) }
}

// The audit trail, and the target's own state with it: a landed write changes a native config, so
// the inventory is re-read before the operation is recorded against the row it now shows.
function recordMirror(
  config: EngineConfig,
  adapters: readonly Adapter[],
  plan: MirrorPlan,
  result: ApplyResult,
  grade: 'safe' | 'risky',
): void {
  discover(config)
  const location = targetLocation(plan, adapters)
  const target =
    location === null
      ? undefined
      : readInventory(config.storePath, { harness: plan.target.harness }).installations.find(
          (row) => row.nativeFile === location.file && row.nativePointer === location.pointer,
        )
  recordApply(config.storePath, {
    at: new Date().toISOString(),
    planId: plan.planId,
    // The grade apply computed, not the claim the document carried.
    grade,
    outcome: result.outcome,
    toolVersion: plan.toolVersion,
    sourceInstallationId: plan.source.installationId,
    landed: result.landed,
    binding:
      target === undefined
        ? null
        : {
            installationId: target.id,
            harness: plan.target.harness,
            tierId: plan.target.tierId,
            // A target found by the scan after the write carries the verification the plan's own
            // asserts produced, never a status the write cannot back up.
            status: result.verification?.outcome ?? 'unverified',
          },
  })
}

interface NativeAddress {
  file: string
  pointer: string
}

// The target entry's address: for MCP it is rebuilt from the first write and the tier's own pointer
// prefix; a skill directory or an instruction file is its own address, so its pointer is empty. The
// plan's `nativeLocation` is one string written for a human, and splitting it back apart would have
// to guess which `#` separated the two halves.
function targetLocation(plan: MirrorPlan, adapters: readonly Adapter[]): NativeAddress | null {
  const write = plan.writes[0]
  if (write === undefined) return null
  if (write.op !== 'writeAtPointer') return { file: write.file, pointer: '' }
  const surface = adapters.find((adapter) => adapter.harness === plan.target.harness)?.mcpWrite
  if (surface === undefined) return null
  const prefix = pointerSegments(surface.pointerPrefix)
  const segments = pointerSegments(write.pointer)
  if (segments.length <= prefix.length) return null
  const pointer = segments
    .slice(0, prefix.length + 1)
    .map(pointerSegment)
    .join('.')
  return { file: write.file, pointer }
}

// A known-fields document decoded leaf by leaf: the store holds JSON, and a shape this process
// cannot decode is left out rather than guessed at.
const knownFieldsValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.record(z.string(), z.string()),
])
const knownFieldsDocument = z.record(z.string(), knownFieldsValue)

export function inspectInstallation(config: EngineConfig, idOrPrefix: string): InspectResult {
  // An inspection reads the stored snapshot, like a listing: the classifier already ran over the
  // source bytes, so nothing here re-reads a native file.
  const lookup = findInstallation(config, idOrPrefix)
  if (lookup.kind !== 'ok') return lookup
  const installation = lookup.row
  const leaves = knownLeaves(installation.knownFieldsJson)
  return {
    kind: 'ok',
    inspection: {
      installation,
      provenance: {
        firstSeenAt: installation.firstSeenAt,
        lastSeenAt: installation.lastSeenAt,
        removedAt: installation.removedAt,
      },
      leaves,
      secrets: leaves
        .filter((leaf) => storedVerdict(leaf.value) !== 'clean')
        .map((leaf) => ({ pointer: leaf.pointer, verdict: storedVerdict(leaf.value) })),
      executables: leaves
        .filter((leaf) => leaf.value.startsWith('!'))
        .map((leaf) => ({ pointer: leaf.pointer, why: 'command retrieval' })),
      // The first binding names the harness that found the row; the rest read the same file.
      alsoReadBy: [...new Set(installation.bindings.map((binding) => binding.harness))].slice(1),
    },
  }
}

function knownLeaves(json: string): KnownLeaf[] {
  let document: ReturnType<typeof knownFieldsDocument.safeParse>
  try {
    document = knownFieldsDocument.safeParse(JSON.parse(json))
  } catch {
    return []
  }
  if (!document.success) return []
  const leaves: KnownLeaf[] = []
  for (const [key, value] of Object.entries(document.data)) {
    const scalar = z.string().safeParse(value)
    if (scalar.success) {
      leaves.push({ pointer: key, value: scalar.data })
      continue
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => leaves.push({ pointer: `${key}.${index}`, value: item }))
      continue
    }
    const map = z.record(z.string(), z.string()).safeParse(value)
    if (map.success) {
      for (const [name, item] of Object.entries(map.data)) {
        leaves.push({ pointer: `${key}.${name}`, value: item })
      }
    }
  }
  return leaves
}
