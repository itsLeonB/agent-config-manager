import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import { HOOK_WRITE_SURFACES } from '../hook-write.ts'
import { readHookTier } from '../hooks.ts'
import { mcpInstallation } from '../mcp-facts.ts'
import { MCP_WRITE_SURFACES } from '../mcp-write.ts'
import { readInstructionTier } from '../instructions.ts'
import { readSkillTier } from '../skills.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readPiMcpJson } from './read.ts'

// Pi has two scopes and no project-local tier. `configPaths` is the tier's MCP file; a skill and an
// instruction file are separate locations under the same layer, declared in `categoryPaths`.
export function piTiers(config: EngineConfig): Tier[] {
  const agentDir = path.join(config.home, '.pi', 'agent')
  const piProject = path.join(config.projectRoot, '.pi')
  const userSkills = path.join(config.home, '.agents', 'skills')
  const projectSkills = path.join(config.projectRoot, '.agents', 'skills')
  const userAgentsMd = path.join(agentDir, 'AGENTS.md')
  const projectAgentsMd = path.join(config.projectRoot, 'AGENTS.md')
  // Hooks under Pi are the file the `@vahor/pi-hooks` extension reads; without that package the file
  // is inert, which the plan says as a manual step rather than checking for it.
  const userHooks = path.join(agentDir, 'hooks.json')
  const projectHooks = path.join(piProject, 'hooks.json')
  return [
    {
      id: 'pi:user',
      nativeLabel: 'user',
      rank: 1,
      scopeBucket: 'user',
      configPaths: [path.join(agentDir, 'mcp.json')],
      categoryPaths: {
        // `~/.agents/skills` is the cross-harness location, so it is where a mirror lands; the
        // harness-owned `skills/` beside it is read but never written by a mirror.
        skills: {
          reads: [userSkills, path.join(agentDir, 'skills')],
          target: userSkills,
        },
        instructions: { reads: [userAgentsMd], target: userAgentsMd },
        hooks: { reads: [userHooks], target: userHooks },
      },
      writability: 'writable',
    },
    {
      id: 'pi:project',
      nativeLabel: 'project',
      rank: 2,
      scopeBucket: 'project',
      configPaths: [path.join(piProject, 'mcp.json')],
      categoryPaths: {
        skills: {
          reads: [projectSkills, path.join(piProject, 'skills')],
          target: projectSkills,
        },
        instructions: { reads: [projectAgentsMd], target: projectAgentsMd },
        hooks: { reads: [projectHooks], target: projectHooks },
      },
      writability: 'writable',
    },
  ]
}

export function createPiAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'pi',
    tiers: piTiers(config),
    claimedCategories: ['mcp', 'skills', 'instructions', 'hooks'],
    handlers: {
      mcp: { read: readMcpTier },
      skills: { read: readSkillTier },
      instructions: { read: readInstructionTier },
      hooks: { read: (tier) => readHookTier(tier, 'pi') },
    },
    mcpWrite: MCP_WRITE_SURFACES.pi,
    hookWrite: HOOK_WRITE_SURFACES.pi,
  }
}

function readMcpTier(tier: Tier): TierRead {
  return readTier(tier, readPiMcpJson, (server, file) =>
    // Only a project entry may carry neither command nor url (it overrides enabled/exposure of the
    // user entry of the same name), so a user-tier entry like that is not a server at all.
    tier.scopeBucket === 'user' &&
    server.facts.command === undefined &&
    server.facts.url === undefined
      ? null
      : mcpInstallation(tier, file, server),
  )
}
