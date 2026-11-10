import type { EngineConfig } from '../../config.ts'
import { readHookTier } from '../hooks.ts'
import { mcpDeclaration } from '../mcp-facts.ts'
import { readInstructionTier } from '../instructions.ts'
import { nativeTiers } from '../native-paths.ts'
import { readSkillTier } from '../skills.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readPiMcpJson } from './read.ts'

export function createPiAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'pi',
    tiers: nativeTiers(config, 'pi'),
    claimedCategories: ['mcp', 'skills', 'instructions', 'hooks'],
    handlers: {
      mcp: { read: readMcpTier },
      skills: { read: readSkillTier },
      instructions: { read: readInstructionTier },
      hooks: { read: (tier) => readHookTier(tier, 'pi') },
    },
  }
}

function readMcpTier(tier: Tier): TierRead {
  return readTier(tier, readPiMcpJson, (server, file) =>
    // Only a project entry may carry neither command nor url (it overrides enabled/exposure of the
    // user entry of the same name), so a user-tier entry like that is not a server at all.
    tier.id.endsWith(':user') && server.facts.command === undefined && server.facts.url === undefined
      ? null
      : mcpDeclaration(tier, file, server),
  )
}
