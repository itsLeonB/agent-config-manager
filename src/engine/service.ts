import { createAdapters } from './adapters/registry.ts'
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
  const reports: TierReport[] = []
  for (const adapter of createAdapters(config)) {
    for (const category of adapter.claimedCategories) {
      const handler = adapter.handlers[category]
      if (handler === undefined) continue
      for (const tier of adapter.tiers) {
        reports.push({ ...handler.read(tier), harness: adapter.harness, tierId: tier.id })
      }
    }
  }
  recordDiscovery(config.storePath, reports, scannedAt)
  return {
    scannedAt,
    installations: reports.reduce((total, report) => total + report.installations.length, 0),
    tierHealth: reports.map((report) => ({
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
}

export function listInstallations(config: EngineConfig, filter: ListFilter): Inventory {
  const inventory = readInventory(config.storePath, filter)
  return {
    // The scan time comes from tier health, not from the rows being listed: a filter that matches
    // nothing still has to report when the last pass ran.
    scannedAt: newestScan(inventory.tierHealth),
    installations: inventory.installations,
    tierHealth: inventory.tierHealth,
  }
}

function newestScan(tierHealth: TierHealthRow[]): string | null {
  return tierHealth.reduce<string | null>(
    (latest, row) => (latest === null || row.at > latest ? row.at : latest),
    null,
  )
}
