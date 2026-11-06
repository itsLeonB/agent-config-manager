import { z } from 'zod'
import { createAdapters } from './adapters/registry.ts'
import type { Category, ScopeBucket, Writability } from './adapters/types.ts'
import type { EngineConfig } from './config.ts'
import { buildPlan, type PlanResult, type PlanSource } from './plan.ts'
import { readInventory, recordDiscovery } from './repo.ts'
import type { TierReport } from './repo.ts'
import { storedVerdict, type Verdict } from './secret.ts'
import type { InstallationRow, TierHealthRow } from '../server/store.cjs'

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
  const surface = adapter.mcpWrite
  if (surface === undefined) {
    return { kind: 'refused', reason: `${adapter.harness} declares no mcp write surface` }
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
  if (row.category !== 'mcp') {
    return { kind: 'refused', reason: `${row.category} has no mirror planner yet; only mcp does` }
  }
  const binding = row.bindings[0]
  const source: PlanSource = {
    installationId: row.id,
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
    target: { harness: adapter.harness, tier, surface },
    now: new Date().toISOString(),
  })
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
