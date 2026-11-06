import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import { mcpInstallation } from '../mcp-facts.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readCodexMcpToml } from './read.ts'

// Codex has three layers, and only two of them are mirror targets: `profile` files are read at
// launch time and are not state ACM may write, so the tier is declared (`notState`) and never read.
// `$CODEX_HOME` defaults to `~/.codex`; project config is inert until the *user* config trusts the
// path, which is a manual step the planner owns, not a read-time concern.
export function codexTiers(config: EngineConfig): Tier[] {
  return [
    {
      id: 'codex:user',
      nativeLabel: 'user',
      rank: 1,
      scopeBucket: 'user',
      configPaths: [path.join(config.home, '.codex', 'config.toml')],
      writability: 'writable',
    },
    {
      id: 'codex:profile',
      nativeLabel: 'profile',
      rank: 2,
      scopeBucket: 'user',
      // A profile is a launch-time `$CODEX_HOME/<name>.config.toml` (or a `[profiles.<name>]`
      // table); it declares no readable location until a ticket reads it.
      configPaths: [],
      writability: 'notState',
    },
    {
      id: 'codex:project',
      nativeLabel: 'project',
      rank: 3,
      scopeBucket: 'project',
      configPaths: [path.join(config.projectRoot, '.codex', 'config.toml')],
      writability: 'writable',
    },
  ]
}

export function createCodexAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'codex',
    tiers: codexTiers(config),
    claimedCategories: ['mcp'],
    handlers: { mcp: { read: readMcpTier } },
  }
}

function readMcpTier(tier: Tier): TierRead {
  return readTier(tier, readCodexMcpToml, (server, file) => mcpInstallation(tier, file, server))
}
