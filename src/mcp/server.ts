import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRouter } from './router.ts'

// One process per client, speaking JSON-RPC on stdin and stdout. Nothing else may reach stdout: a
// stray line corrupts the framing.
export async function serve(): Promise<void> {
  await createRouter().connect(new StdioServerTransport())
}
