import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import { mcpInstallation } from '../mcp-facts.ts'
import { readTier } from '../tier.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { readPiMcpJson } from './read.ts'

// Pi has two scopes and no project-local tier. `configPaths` is the tier's MCP file; the other
// categories live in different files under the same layer and arrive with their own tickets.
export function piTiers(config: EngineConfig): Tier[] {
  return [
    {
      id: 'pi:user',
      nativeLabel: 'user',
      rank: 1,
      scopeBucket: 'user',
      configPaths: [path.join(config.home, '.pi', 'agent', 'mcp.json')],
      writability: 'writable',
    },
    {
      id: 'pi:project',
      nativeLabel: 'project',
      rank: 2,
      scopeBucket: 'project',
      configPaths: [path.join(config.projectRoot, '.pi', 'mcp.json')],
      writability: 'writable',
    },
  ]
}

export function createPiAdapter(config: EngineConfig): Adapter {
  return {
    harness: 'pi',
    tiers: piTiers(config),
    claimedCategories: ['mcp'],
    handlers: { mcp: { read: readMcpTier } },
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
