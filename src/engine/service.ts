import { createAdapters } from './adapters/registry.ts'
import type { Category, ScopeBucket, Writability } from './adapters/types.ts'
import type { EngineConfig } from './config.ts'
import { readInventory, recordDiscovery } from './repo.ts'
import type { TierReport } from './repo.ts'
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
    tierHealth: inventory.tierHealth,
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
