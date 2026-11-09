import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import { HOOK_WRITE_SURFACES } from '../hook-write.ts'
import { mcpInstallation } from '../mcp-facts.ts'
import { MCP_WRITE_SURFACES } from '../mcp-write.ts'
import { readInstructionTier } from '../instructions.ts'
import { readSkillTier } from '../skills.ts'
import { readTier, type TierProbe } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { openCodeProbe } from './probe.ts'
import { readOpenCodeMcpJsonc } from './read.ts'

// OpenCode merges every ancestor's config, and a root-managed `/etc/opencode` outranks the project,
// so it is a real tier that ACM must never write: declared, `elevationRequired`, never read. Ranks
// are precedence order. `~/.opencode` is left out of the tier table until its precedence against
// `~/.config/opencode` is verified (spec, Further Notes 2).
// Health is measured, not assumed: the local parse is the cheap gate, and one probe per discovery
// pass asks OpenCode which of these files it actually accepted (spec §9).
export function openCodeTiers(config: EngineConfig): Tier[] {
  const projectRoot = config.projectRoot
  const userConfigDir = path.join(config.home, '.config', 'opencode')
  const projectConfigDir = path.join(projectRoot, '.opencode')
  const userSkills = path.join(config.home, '.agents', 'skills')
  const projectSkills = path.join(projectRoot, '.agents', 'skills')
  const userAgentsMd = path.join(userConfigDir, 'AGENTS.md')
  const projectAgentsMd = path.join(projectRoot, 'AGENTS.md')
  // Hooks here are plugin modules, so the location is a directory a mirror generates a module into.
  // It is a write target only: a hook inside an existing plugin is code this engine cannot parse,
  // which is why OpenCode claims no hooks reader at all.
  const userPlugins = path.join(userConfigDir, 'plugins')
  const projectPlugins = path.join(projectConfigDir, 'plugins')
  return [
    {
      id: 'oc:project',
      nativeLabel: 'project',
      rank: 1,
      scopeBucket: 'project',
      configPaths: [
        path.join(projectRoot, 'opencode.json'),
        path.join(projectRoot, 'opencode.jsonc'),
        path.join(projectConfigDir, 'opencode.json'),
        path.join(projectConfigDir, 'opencode.jsonc'),
      ],
      categoryPaths: {
        // OpenCode also discovers `.claude/skills`, which is another tool's location: a source it
        // reads and never a place a mirror may write.
        skills: {
          reads: [projectSkills, path.join(projectConfigDir, 'skills'), path.join(projectRoot, '.claude', 'skills')],
          target: projectSkills,
        },
        instructions: { reads: [projectAgentsMd], target: projectAgentsMd },
        hooks: { reads: [], target: projectPlugins, targetKind: 'directory' },
      },
      writability: 'writable',
    },
    {
      id: 'oc:user',
      nativeLabel: 'user',
      rank: 2,
      scopeBucket: 'user',
      configPaths: [
        path.join(userConfigDir, 'opencode.json'),
        path.join(userConfigDir, 'opencode.jsonc'),
      ],
      categoryPaths: {
        skills: {
          reads: [userSkills, path.join(userConfigDir, 'skills'), path.join(config.home, '.claude', 'skills')],
          target: userSkills,
        },
        instructions: { reads: [userAgentsMd], target: userAgentsMd },
        hooks: { reads: [], target: userPlugins, targetKind: 'directory' },
      },
      writability: 'writable',
    },
    {
      id: 'oc:system',
      nativeLabel: '/etc/opencode',
      rank: 3,
      scopeBucket: 'system',
      configPaths: ['/etc/opencode/opencode.json', '/etc/opencode/opencode.jsonc'],
      writability: 'elevationRequired',
    },
  ]
}

export function createOpenCodeAdapter(config: EngineConfig): Adapter {
  // Built once per pass, so the probe runs once however many tiers or categories ask for it.
  const probe = openCodeProbe(config)
  return {
    harness: 'opencode',
    tiers: openCodeTiers(config),
    claimedCategories: ['mcp', 'skills', 'instructions'],
    handlers: {
      mcp: { read: (tier) => readMcpTier(tier, probe) },
      skills: { read: readSkillTier },
      instructions: { read: readInstructionTier },
    },
    mcpWrite: MCP_WRITE_SURFACES.opencode,
    hookWrite: HOOK_WRITE_SURFACES.opencode,
  }
}

function readMcpTier(tier: Tier, probe: TierProbe | undefined): TierRead {
  return readTier(
    tier,
    readOpenCodeMcpJsonc,
    (server, file) => mcpInstallation(tier, file, server),
    probe,
  )
}
