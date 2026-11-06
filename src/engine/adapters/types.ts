import path from 'node:path'
import type { McpWriteSurface } from './mcp-write.ts'

export type Category = 'mcp' | 'skills' | 'instructions' | 'hooks'
export const HARNESSES = ['pi', 'codex', 'opencode'] as const
export type HarnessId = (typeof HARNESSES)[number]
export type ScopeBucket = 'user' | 'project' | 'project-local' | 'system'
export const WRITABILITIES = ['writable', 'elevationRequired', 'notState', 'managed'] as const
export type Writability = (typeof WRITABILITIES)[number]
export type TierHealthStatus = 'ok' | 'unreadable'

// A category whose surface is not one parsed config file: a skill is a directory tree, an
// instruction file is markdown. `reads` is every location the harness loads, so one declaration
// answers both "where may a plan write" and "who else reads this"; `target` is where a mirror into
// this tier lands, and is always one of the reads.
export interface CategoryPaths {
  reads: readonly string[]
  target: string
}

// A tier is the harness's own configuration layer. `id` is prefixed with the harness so a row in
// the store names its tier unambiguously across harnesses. `configPaths` lists the candidate files
// the tier's config can live in (OpenCode accepts `.json` or `.jsonc`), in read order.
export interface Tier {
  id: string
  nativeLabel: string
  rank: number
  scopeBucket: ScopeBucket
  configPaths: readonly string[]
  categoryPaths?: Partial<Record<'skills' | 'instructions', CategoryPaths>>
  writability: Writability
}

// Every location one category of one tier declares: the config files for `mcp`, the markdown files
// and skill roots for the rest.
export function declaredPaths(tier: Tier, category: Category): readonly string[] {
  if (category === 'mcp') return tier.configPaths
  if (category === 'skills') return tier.categoryPaths?.skills?.reads ?? []
  return tier.categoryPaths?.instructions?.reads ?? []
}

// A write may reach a declared path itself or anything beneath it: a mirrored skill is
// `<root>/<name>`, and the root is what the tier declares.
export function declaresPathFor(tier: Tier, category: Category, file: string): boolean {
  return declaredPaths(tier, category).some(
    (entry) => entry === file || file.startsWith(`${entry}${path.sep}`),
  )
}

export function declaresPath(tier: Tier, file: string): boolean {
  return (['mcp', 'skills', 'instructions', 'hooks'] as const).some((category) =>
    declaresPathFor(tier, category, file),
  )
}

export function mirrorTarget(
  tier: Tier,
  category: 'skills' | 'instructions',
): string | undefined {
  return tier.categoryPaths?.[category]?.target
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
