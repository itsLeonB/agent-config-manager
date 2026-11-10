import path from 'node:path'
import type { EngineConfig } from '../config.ts'
import type { HarnessId, Tier } from './types.ts'

// The one place that answers where a harness keeps its configuration at a tier. Nothing is written
// through here and nothing is derived from it: a tier is a read location, so `configPaths` and
// `categoryPaths` are everything it carries.

// Pi has two layers. `configPaths` is the tier's MCP file; a skill and an instruction file are
// separate locations under the same layer, declared in `categoryPaths`.
export function piTiers(config: EngineConfig): Tier[] {
  const agentDir = path.join(config.home, '.pi', 'agent')
  const piProject = path.join(config.projectRoot, '.pi')
  const userSkills = path.join(config.home, '.agents', 'skills')
  const projectSkills = path.join(config.projectRoot, '.agents', 'skills')
  const userAgentsMd = path.join(agentDir, 'AGENTS.md')
  const projectAgentsMd = path.join(config.projectRoot, 'AGENTS.md')
  // Hooks under Pi are the file the `@vahor/pi-hooks` extension reads; without that package the file
  // is inert, so its presence says nothing about whether anything loads it.
  const userHooks = path.join(agentDir, 'hooks.json')
  const projectHooks = path.join(piProject, 'hooks.json')
  return [
    {
      id: 'pi:user',
      nativeLabel: 'user',
      rank: 1,
      configPaths: [path.join(agentDir, 'mcp.json')],
      categoryPaths: {
        // `~/.agents/skills` is the cross-harness location; the harness-owned `skills/` beside it is
        // read too, because the harness loads it.
        skills: {
          reads: [userSkills, path.join(agentDir, 'skills')],
        },
        instructions: { reads: [userAgentsMd] },
        hooks: { reads: [userHooks] },
      },
    },
    {
      id: 'pi:project',
      nativeLabel: 'project',
      rank: 2,
      configPaths: [path.join(piProject, 'mcp.json')],
      categoryPaths: {
        skills: {
          reads: [projectSkills, path.join(piProject, 'skills')],
        },
        instructions: { reads: [projectAgentsMd] },
        hooks: { reads: [projectHooks] },
      },
    },
  ]
}

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

type TierTable = (config: EngineConfig) => Tier[]

const TIER_TABLES = {
  pi: piTiers,
  codex: codexTiers,
  opencode: openCodeTiers,
} satisfies Record<HarnessId, TierTable>

// Every tier one harness reads, in the table's own precedence order. Ticket 03 resolves a relative
// check path against a tier's root and ticket 08 reads every declared path at one, so both answer
// from this pair rather than from the inventory.
export function nativeTiers(config: EngineConfig, harness: HarnessId): Tier[] {
  return TIER_TABLES[harness](config)
}

// One tier by its harness-prefixed id, which is how a declaration names it (`pi:user`, `oc:project`).
export function nativeTier(config: EngineConfig, harness: HarnessId, tierId: string): Tier | undefined {
  return nativeTiers(config, harness).find((tier) => tier.id === tierId)
}
