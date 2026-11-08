import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveDefaultConfig, type EngineConfig } from '../engine/config.ts'
import { createRouter } from './router.ts'

// One process per client, speaking JSON-RPC on stdin and stdout. Nothing else may reach stdout: a
// stray line corrupts the framing. The roots come from the injected config, never the working
// directory, because a harness spawns this with one we do not control.
export async function serve(config: EngineConfig = resolveDefaultConfig()): Promise<void> {
  await createRouter(config).connect(new StdioServerTransport())
}
