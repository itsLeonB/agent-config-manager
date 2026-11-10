import { createHash, randomUUID } from 'node:crypto'
import { openStore } from '../server/store.cjs'
import type {
  DiscoveryBatch,
  InstallationFilter,
  InstallationRow,
  MirrorRecord,
  OperationRow,
  TierHealthRow,
} from '../server/store.cjs'
import type { DiscoveredInstallation, TierRead } from './adapters/types.ts'
import { under } from './adapters/types.ts'

export interface TierReport extends TierRead {
  harness: string
  tierId: string
  // Every location this tier declared it reads. A tombstone may only reach a row whose own file sits
  // under one of them.
  declaredReads: readonly string[]
}

// The id is a hash of the identity tuple, so re-discovery upserts the same row and a plan can name
// an installation across processes without a lookup.
export function installationId(installation: DiscoveredInstallation): string {
  const identity = [
    installation.category,
    installation.name,
    installation.scope,
    installation.nativeFile,
    installation.nativePointer,
  ]
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

export function recordDiscovery(storePath: string, reports: TierReport[], at: string): void {
  const store = openStore(storePath)
  try {
    const batch: DiscoveryBatch = { at, installations: [], tombstones: [], tierHealth: [] }
    for (const report of reports) {
      batch.tierHealth.push({
        harness: report.harness,
        tierId: report.tierId,
        status: report.health,
        detail: report.detail,
      })
      const seen = new Set<string>()
      for (const installation of report.installations) {
        const id = installationId(installation)
        seen.add(id)
        batch.installations.push({
          id,
          category: installation.category,
          name: installation.name,
          aliases: [],
          scope: installation.scope,
          nativeFile: installation.nativeFile,
          nativePointer: installation.nativePointer,
          knownFieldsJson: installation.knownFieldsJson,
          contentDigest: installation.contentDigest,
          bindings: [
            {
              harness: report.harness,
              tierId: report.tierId,
              method: 'file',
              verificationStatus: 'unverified',
            },
          ],
        })
      }
      // Only a tier that reported cleanly may tombstone: an unreadable config means the tier was
      // left alone, so its rows survive.
      if (report.health !== 'ok') continue
      for (const live of store.listLiveInstallationsForTier(report.harness, report.tierId)) {
        // The inventory spans every project, so a row under a file this pass never read is another
        // project's entry, not a removal.
        if (seen.has(live.id) || !under(report.declaredReads, live.nativeFile)) continue
        batch.tombstones.push(live.id)
      }
    }
    store.writeDiscovery(batch)
  } finally {
    store.close()
  }
}

export interface StoreInventory {
  installations: InstallationRow[]
  tierHealth: TierHealthRow[]
}

// What an apply leaves behind: one operation row, and — when the target entry is in the inventory
// again — the plan's hash on the target and its verification status on the binding. The operation's
// target id is the binding's, so it has one source rather than two.
export type ApplyRecord = Omit<MirrorRecord, 'id' | 'kind' | 'targetInstallationId'>

export function recordApply(storePath: string, record: ApplyRecord): void {
  const store = openStore(storePath)
  try {
    const row: MirrorRecord = {
      id: randomUUID(),
      kind: 'mirror',
      targetInstallationId: record.binding?.installationId ?? null,
      ...record,
    }
    store.recordMirror(row)
  } finally {
    store.close()
  }
}

export function listOperations(storePath: string): OperationRow[] {
  const store = openStore(storePath)
  try {
    return store.listOperations()
  } finally {
    store.close()
  }
}

export function readInventory(storePath: string, filter: InstallationFilter): StoreInventory {
  const store = openStore(storePath)
  try {
    return { installations: store.listInstallations(filter), tierHealth: store.readTierHealth() }
  } finally {
    store.close()
  }
}
