import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { EngineConfig } from '../../config.ts'
import type { Adapter, Tier, TierRead } from '../types.ts'
import { factsDigest, knownFieldsForStorage, readPiMcpJson } from './read.ts'

// Pi has two scopes and no project-local tier. `configPath` is the tier's MCP file; the other
// categories live in different files under the same layer and arrive with their own tickets.
export function piTiers(config: EngineConfig): Tier[] {
  return [
    {
      id: 'pi:user',
      nativeLabel: 'user',
      rank: 1,
      scopeBucket: 'user',
      configPath: path.join(config.home, '.pi', 'agent', 'mcp.json'),
      writability: 'writable',
    },
    {
      id: 'pi:project',
      nativeLabel: 'project',
      rank: 2,
      scopeBucket: 'project',
      configPath: path.join(config.projectRoot, '.pi', 'mcp.json'),
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

// A missing file is a healthy empty tier. Any other read error is not: treated as empty it would
// silently tombstone every row the tier had, so it surfaces as an unreadable tier instead.
function readMcpTier(tier: Tier): TierRead {
  let text: string
  try {
    text = readFileSync(tier.configPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ENOENT')) {
      return { health: 'ok', detail: null, installations: [] }
    }
    return { health: 'unreadable', detail: `${tier.configPath} could not be read`, installations: [] }
  }
  const read = readPiMcpJson(text)
  if (read.kind === 'invalid') return { health: 'unreadable', detail: read.detail, installations: [] }
  return {
    health: 'ok',
    detail: null,
    installations: read.servers
      // Only a project entry may carry neither command nor url (it overrides enabled/exposure of
      // the user entry of the same name), so a user-tier entry like that is not a server at all.
      .filter(
        (server) =>
          tier.scopeBucket !== 'user' ||
          server.facts.command !== undefined ||
          server.facts.url !== undefined,
      )
      .map((server) => ({
        category: 'mcp',
        name: server.name,
        scope: tier.scopeBucket,
        tierId: tier.id,
        nativeFile: tier.configPath,
        nativePointer: `mcpServers.${server.name}`,
        knownFieldsJson: JSON.stringify(knownFieldsForStorage(server.facts)),
        contentDigest: factsDigest(server.facts),
      })),
  }
}
