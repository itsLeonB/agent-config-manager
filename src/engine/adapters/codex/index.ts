import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import { readHookTier } from '../hooks.ts'
import { mcpDeclaration } from '../mcp-facts.ts'
import { readInstructionTier } from '../instructions.ts'
import { readSkillTier } from '../skills.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readCodexMcpToml } from './read.ts'

// Codex has two layers. `$CODEX_HOME` defaults to `~/.codex`; project config is inert until the
// *user* config trusts the path, which is a fact about the file rather than about where it is read.
export function codexTiers(config: EngineConfig): Tier[] {
  const codexRoot = config.codexHome ?? path.join(config.home, '.codex')
  // Codex declares no harness-owned skill directory of its own: the two `.agents/skills` roots and
  // `/etc/codex/skills` are the documented locations.
  const userSkills = path.join(config.home, '.agents', 'skills')
  const projectSkills = path.join(config.projectRoot, '.agents', 'skills')
  // Hooks are their own file beside the config layer: inline `[hooks]` in config.toml is merged with
  // it rather than replaced, so one file per layer is what a reader has to look at.
  const userHooks = path.join(codexRoot, 'hooks.json')
  const projectHooks = path.join(config.projectRoot, '.codex', 'hooks.json')
  return [
    {
      id: 'codex:user',
      nativeLabel: 'user',
      rank: 1,
      configPaths: [path.join(codexRoot, 'config.toml')],
      categoryPaths: {
        skills: { reads: [userSkills] },
        // `AGENTS.override.md` outranks this file when both exist.
        instructions: { reads: [path.join(codexRoot, 'AGENTS.md')] },
        hooks: { reads: [userHooks] },
      },
    },
    {
      id: 'codex:project',
      nativeLabel: 'project',
      rank: 2,
      configPaths: [path.join(config.projectRoot, '.codex', 'config.toml')],
      categoryPaths: {
        skills: { reads: [projectSkills] },
        // The same file Pi and OpenCode read for a project: one project instruction file.
        instructions: { reads: [path.join(config.projectRoot, 'AGENTS.md')] },
        hooks: { reads: [projectHooks] },
      },
    },
  ]
}

export function createCodexAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'codex',
    tiers: codexTiers(config),
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
