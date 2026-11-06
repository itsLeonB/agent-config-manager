import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import { mcpInstallation } from '../mcp-facts.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readOpenCodeMcpJsonc } from './read.ts'

// OpenCode merges every ancestor's config, and a root-managed `/etc/opencode` outranks the project,
// so it is a real tier that ACM must never write: declared, `elevationRequired`, never read. Ranks
// are precedence order. `~/.opencode` is left out of the tier table until its precedence against
// `~/.config/opencode` is verified (spec, Further Notes 2).
// shortcut: health comes from parsing the file here, not from the `opencode debug config` probe
// spec §9 describes, because this slice runs no commands. A config that parses but that OpenCode
// still rejects will read as `ok`; upgrade when the probe is allowed.
export function openCodeTiers(config: EngineConfig): Tier[] {
  const projectRoot = config.projectRoot
  return [
    {
      id: 'oc:project',
      nativeLabel: 'project',
      rank: 1,
      scopeBucket: 'project',
      configPaths: [
        path.join(projectRoot, 'opencode.json'),
        path.join(projectRoot, 'opencode.jsonc'),
        path.join(projectRoot, '.opencode', 'opencode.json'),
        path.join(projectRoot, '.opencode', 'opencode.jsonc'),
      ],
      writability: 'writable',
    },
    {
      id: 'oc:user',
      nativeLabel: 'user',
      rank: 2,
      scopeBucket: 'user',
      configPaths: [
        path.join(config.home, '.config', 'opencode', 'opencode.json'),
        path.join(config.home, '.config', 'opencode', 'opencode.jsonc'),
      ],
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
  return {
    harness: 'opencode',
    tiers: openCodeTiers(config),
    claimedCategories: ['mcp'],
    handlers: { mcp: { read: readMcpTier } },
  }
}

function readMcpTier(tier: Tier): TierRead {
  return readTier(tier, readOpenCodeMcpJsonc, (server, file) =>
    mcpInstallation(tier, file, server, 'mcp.servers'),
  )
}
