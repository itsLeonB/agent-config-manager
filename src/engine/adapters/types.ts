import type { McpWriteSurface } from './mcp-write.ts'

export type Category = 'mcp' | 'skills' | 'instructions' | 'hooks'
export const HARNESSES = ['pi', 'codex', 'opencode'] as const
export type HarnessId = (typeof HARNESSES)[number]
export type ScopeBucket = 'user' | 'project' | 'project-local' | 'system'
export const WRITABILITIES = ['writable', 'elevationRequired', 'notState', 'managed'] as const
export type Writability = (typeof WRITABILITIES)[number]
export type TierHealthStatus = 'ok' | 'unreadable'

// A tier is the harness's own configuration layer. `id` is prefixed with the harness so a row in
// the store names its tier unambiguously across harnesses. `configPaths` lists the candidate files
// the tier's config can live in (OpenCode accepts `.json` or `.jsonc`), in read order.
export interface Tier {
  id: string
  nativeLabel: string
  rank: number
  scopeBucket: ScopeBucket
  configPaths: readonly string[]
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
  // What this harness can write for a category a planner covers. A category with no surface is
  // read-only here, and a mirror into it is refused as caller input rather than planned.
  mcpWrite?: McpWriteSurface
}
