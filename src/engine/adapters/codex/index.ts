import type { EngineConfig } from '../../config.ts'
import { readHookTier } from '../hooks.ts'
import { mcpDeclaration } from '../mcp-facts.ts'
import { readInstructionTier } from '../instructions.ts'
import { nativeTiers } from '../native-paths.ts'
import { readSkillTier } from '../skills.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readCodexMcpToml } from './read.ts'

export function createCodexAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'codex',
    tiers: nativeTiers(config, 'codex'),
    claimedCategories: ['mcp', 'skills', 'instructions', 'hooks'],
    handlers: {
      mcp: { read: readMcpTier },
      skills: { read: readSkillTier },
      instructions: { read: readInstructionTier },
      hooks: { read: (tier) => readHookTier(tier, 'codex') },
    },
  }
}

function readMcpTier(tier: Tier): TierRead {
  return readTier(tier, readCodexMcpToml, (server, file) =>
    // A user-tier entry with neither `command` nor `url` names nothing to launch, so it is not a
    // server. A project entry like that is a legitimate per-field override of the user one, so
    // only the base tier filters.
    tier.id.endsWith(':user') &&
    server.facts.command === undefined &&
    server.facts.url === undefined
      ? null
      : mcpDeclaration(tier, file, server),
  )
}
