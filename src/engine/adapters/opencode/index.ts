import type { EngineConfig } from '../../config.ts'
import { mcpDeclaration } from '../mcp-facts.ts'
import { readInstructionTier } from '../instructions.ts'
import { nativeTiers } from '../native-paths.ts'
import { readSkillTier } from '../skills.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readOpenCodeMcpJsonc } from './read.ts'

export function createOpenCodeAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'opencode',
    tiers: nativeTiers(config, 'opencode'),
    // Hooks here are plugin modules, which OpenCode loads as code this engine cannot parse, so it
    // claims no hooks reader at all.
    claimedCategories: ['mcp', 'skills', 'instructions'],
    handlers: {
      mcp: { read: readMcpTier },
      skills: { read: readSkillTier },
      instructions: { read: readInstructionTier },
    },
  }
}

function readMcpTier(tier: Tier): TierRead {
  return readTier(tier, readOpenCodeMcpJsonc, (server, file) => mcpDeclaration(tier, file, server))
}
