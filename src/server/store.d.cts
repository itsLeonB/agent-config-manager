import type { Json, LocalData } from '../types/dashboard'

export interface DiscoveryBinding {
  harness: string
  tierId: string
  method: string
  verificationStatus: string
}

export interface DiscoveryInstallation {
  id: string
  category: string
  name: string
  aliases: string[]
  scope: string
  nativeFile: string
  nativePointer: string | null
  // `known_fields` stays an opaque JSON string here: the store never interprets it, and the
  // engine's own reader is the only thing that decides what it holds.
  knownFieldsJson: string
  contentDigest: string
  bindings: DiscoveryBinding[]
}

export interface DiscoveryTierHealth {
  harness: string
  tierId: string
  status: string
  detail: string | null
}

export interface DiscoveryBatch {
  at: string
  installations: DiscoveryInstallation[]
  tombstones: string[]
  tierHealth: DiscoveryTierHealth[]
}

export interface InstallationFilter {
  category?: string
  harness?: string
  scope?: string
  includeRemoved?: boolean
}

export interface InstallationRow {
  id: string
  category: string
  name: string
  aliases: string[]
  scope: string
  nativeFile: string
  nativePointer: string | null
  contentDigest: string | null
  knownFieldsJson: string
  firstSeenAt: string
  lastSeenAt: string
  removedAt: string | null
  bindings: DiscoveryBinding[]
}

export interface TierHealthRow {
  harness: string
  tierId: string
  status: string
  detail: string | null
  at: string
}

// The store only round-trips JSON; typing the 'local' kind means readers get LocalData
// back without a cast.
export interface Store {
  saveSnapshot(kind: 'local', data: LocalData): void
  readLatestSnapshot(kind: 'local'): LocalData | null
  writeConfig(key: string, value: Json): void
  readConfig(key: string): Json | null
  writeDiscovery(batch: DiscoveryBatch): void
  listInstallations(filter: InstallationFilter): InstallationRow[]
  listLiveInstallationIdsForTier(harness: string, tierId: string): string[]
  readTierHealth(): TierHealthRow[]
  close(): void
}

export function openStore(filePath: string): Store
