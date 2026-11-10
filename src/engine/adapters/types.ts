export const CATEGORIES = ['mcp', 'skills', 'instructions', 'hooks'] as const
export type Category = (typeof CATEGORIES)[number]
export const HARNESSES = ['pi', 'codex', 'opencode'] as const
export type HarnessId = (typeof HARNESSES)[number]
export type TierHealthStatus = 'ok' | 'unreadable'

// A category whose surface is not one parsed config file: a skill is a directory tree, an
// instruction file is markdown, and a hook is config of its own. `reads` is every location the
// harness loads, so one declaration answers "who else reads this".
export interface CategoryPaths {
  reads: readonly string[]
}

// A tier is one layer of a harness's own configuration. `id` is prefixed with the harness so a
// declaration names its tier unambiguously across harnesses. `configPaths` lists the candidate files
// the tier's config can live in (OpenCode accepts `.json` or `.jsonc`), in read order.
export interface Tier {
  id: string
  nativeLabel: string
  rank: number
  configPaths: readonly string[]
  categoryPaths?: Partial<Record<'skills' | 'instructions' | 'hooks', CategoryPaths>>
}

// Every location one category of one tier declares: the config files for `mcp`, the markdown files
// and skill roots for the rest. Written as an exhaustive switch so a category added later fails
// typecheck here instead of silently reading another category's paths.
export function declaredPaths(tier: Tier, category: Category): readonly string[] {
  switch (category) {
    case 'mcp':
      return tier.configPaths
    case 'skills':
      return tier.categoryPaths?.skills?.reads ?? []
    case 'instructions':
      return tier.categoryPaths?.instructions?.reads ?? []
    case 'hooks':
      return tier.categoryPaths?.hooks?.reads ?? []
  }
}

// One thing a reader found at a tier: what it is, the address it sits at inside a known file, and
// the digest of the bytes it was read from.
export interface DiscoveredDeclaration {
  category: Category
  name: string
  tierId: string
  nativeFile: string
  nativePointer: string
  knownFieldsJson: string
  contentDigest: string
}

// One tier's answer for one category. `unreadable` means the native config did not parse, so what
// the tier declares is unknown rather than empty.
export interface TierRead {
  health: TierHealthStatus
  detail: string | null
  declarations: DiscoveredDeclaration[]
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
