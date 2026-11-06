import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import { mcpInstallation } from '../mcp-facts.ts'
import { MCP_WRITE_SURFACES } from '../mcp-write.ts'
import { readInstructionTier } from '../instructions.ts'
import { readSkillTier } from '../skills.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readCodexMcpToml } from './read.ts'

// Codex has three layers, and only two of them are mirror targets: `profile` files are read at
// launch time and are not state ACM may write, so the tier is declared (`notState`) and never read.
// `$CODEX_HOME` defaults to `~/.codex`; project config is inert until the *user* config trusts the
// path, which is a manual step the planner owns, not a read-time concern.
export function codexTiers(config: EngineConfig): Tier[] {
  const codexRoot = config.codexHome ?? path.join(config.home, '.codex')
  // Codex declares no harness-owned skill directory of its own: the two `.agents/skills` roots and
  // `/etc/codex/skills` are the documented locations, and the last is not one ACM may write.
  const userSkills = path.join(config.home, '.agents', 'skills')
  const projectSkills = path.join(config.projectRoot, '.agents', 'skills')
  return [
    {
      id: 'codex:user',
      nativeLabel: 'user',
      rank: 1,
      scopeBucket: 'user',
      configPaths: [path.join(codexRoot, 'config.toml')],
      categoryPaths: {
        skills: { reads: [userSkills], target: userSkills },
        // `AGENTS.override.md` outranks this file when both exist, which the planner names as a
        // manual step rather than reading.
        instructions: { reads: [path.join(codexRoot, 'AGENTS.md')], target: path.join(codexRoot, 'AGENTS.md') },
      },
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
      categoryPaths: {
        skills: { reads: [projectSkills], target: projectSkills },
        // The same file Pi and OpenCode read for a project: one project instruction file, so
        // mirroring between them writes nothing.
        instructions: {
          reads: [path.join(config.projectRoot, 'AGENTS.md')],
          target: path.join(config.projectRoot, 'AGENTS.md'),
        },
      },
      writability: 'writable',
    },
  ]
}

export function createCodexAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'codex',
    tiers: codexTiers(config),
    claimedCategories: ['mcp', 'skills', 'instructions'],
    handlers: {
      mcp: { read: readMcpTier },
      skills: { read: readSkillTier },
      instructions: { read: readInstructionTier },
    },
    mcpWrite: MCP_WRITE_SURFACES.codex,
  }
}

function readMcpTier(tier: Tier): TierRead {
  return readTier(tier, readCodexMcpToml, (server, file) =>
    // A user-tier entry with neither `command` nor `url` names nothing to launch, so it is not a
    // server. A project entry like that is a legitimate per-field override of the user one, so
    // only the base tier filters.
    tier.scopeBucket === 'user' &&
    server.facts.command === undefined &&
    server.facts.url === undefined
      ? null
      : mcpInstallation(tier, file, server),
  )
}
