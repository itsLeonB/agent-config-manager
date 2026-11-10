import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import { mcpDeclaration } from '../mcp-facts.ts'
import { readInstructionTier } from '../instructions.ts'
import { readSkillTier } from '../skills.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readOpenCodeMcpJsonc } from './read.ts'

// OpenCode merges every ancestor's config, and a root-managed `/etc/opencode` outranks the project,
// so it is a real layer that is read like any other and named by its own id. Ranks are precedence
// order. `~/.opencode` is left out of the tier table until its precedence against
// `~/.config/opencode` is verified.
export function openCodeTiers(config: EngineConfig): Tier[] {
  const projectRoot = config.projectRoot
  const userConfigDir = path.join(config.home, '.config', 'opencode')
  const projectConfigDir = path.join(projectRoot, '.opencode')
  const userSkills = path.join(config.home, '.agents', 'skills')
  const projectSkills = path.join(projectRoot, '.agents', 'skills')
  const userAgentsMd = path.join(userConfigDir, 'AGENTS.md')
  const projectAgentsMd = path.join(projectRoot, 'AGENTS.md')
  return [
    {
      id: 'oc:project',
      nativeLabel: 'project',
      rank: 1,
      configPaths: [
        path.join(projectRoot, 'opencode.json'),
        path.join(projectRoot, 'opencode.jsonc'),
        path.join(projectConfigDir, 'opencode.json'),
        path.join(projectConfigDir, 'opencode.jsonc'),
      ],
      categoryPaths: {
        // OpenCode also discovers `.claude/skills`, which is another tool's location: read, because
        // OpenCode loads it.
        skills: {
          reads: [projectSkills, path.join(projectConfigDir, 'skills'), path.join(projectRoot, '.claude', 'skills')],
        },
        instructions: { reads: [projectAgentsMd] },
      },
    },
    {
      id: 'oc:user',
      nativeLabel: 'user',
      rank: 2,
      configPaths: [
        path.join(userConfigDir, 'opencode.json'),
        path.join(userConfigDir, 'opencode.jsonc'),
      ],
      categoryPaths: {
        skills: {
          reads: [userSkills, path.join(userConfigDir, 'skills'), path.join(config.home, '.claude', 'skills')],
        },
        instructions: { reads: [userAgentsMd] },
      },
    },
    {
      id: 'oc:system',
      nativeLabel: '/etc/opencode',
      rank: 3,
      configPaths: ['/etc/opencode/opencode.json', '/etc/opencode/opencode.jsonc'],
    },
  ]
}

export function createOpenCodeAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'opencode',
    tiers: openCodeTiers(config),
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
