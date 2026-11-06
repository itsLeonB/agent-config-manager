export type Category = 'mcp' | 'skills' | 'instructions' | 'hooks'
export type HarnessId = 'pi' | 'codex' | 'opencode'
export type ScopeBucket = 'user' | 'project' | 'project-local' | 'system'
export type Writability = 'writable' | 'elevationRequired' | 'notState' | 'managed'
export type TierHealthStatus = 'ok' | 'unreadable'

// A tier is the harness's own configuration layer. `id` is prefixed with the harness so a row in
// the store names its tier unambiguously across harnesses.
export interface Tier {
  id: string
  nativeLabel: string
  rank: number
  scopeBucket: ScopeBucket
  configPath: string
  writability: Writability
}

export interface DiscoveredInstallation {
  category: Category
  name: string
  scope: ScopeBucket
  tierId: string
  nativeFile: string
  nativePointer: string
  knownFieldsJson: string
  contentDigest: string
}

// One tier's answer for one category. `unreadable` means the native config did not parse, so the
// tier may tombstone nothing and the inventory is incomplete rather than smaller.
export interface TierRead {
  health: TierHealthStatus
  detail: string | null
  installations: DiscoveredInstallation[]
}

export interface CategoryHandler {
  read(tier: Tier): TierRead
}

export interface Adapter {
  harness: HarnessId
  tiers: readonly Tier[]
  claimedCategories: readonly Category[]
  handlers: Partial<Record<Category, CategoryHandler>>
}
