import { z } from 'zod'
import type { McpFacts } from '../mcp-facts.ts'
import type { ParsedEntries } from '../tier.ts'

// Pi's `mcp.json` is Claude/Cursor shaped: one `mcpServers` map, entries as objects. `type` is
// optional because Pi infers it from `command` vs `url`; anything the adapter does not name here
// stays in the native file and never enters the store.
const entrySchema = z.object({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().optional(),
  description: z.string().optional(),
  exposure: z.string().optional(),
})

const fileSchema = z.object({
  mcpServers: z.record(z.string(), entrySchema).optional(),
})

export type PiMcpEntry = { name: string; facts: McpFacts }

// Pure over bytes so the parse can be tested without a filesystem.
export function readPiMcpJson(text: string): ParsedEntries<PiMcpEntry> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text))
    if (!parsed.success) {
      return { kind: 'invalid', detail: parsed.error.issues[0]?.message ?? 'invalid mcp.json' }
    }
    return {
      kind: 'ok',
      entries: Object.entries(parsed.data.mcpServers ?? {}).map(([name, entry]) => ({
        name,
        facts: toFacts(entry),
      })),
    }
  } catch {
    return { kind: 'invalid', detail: 'mcp.json is not valid JSON' }
  }
}

// Pi checks `url` before `command` when `type` is absent, so an entry carrying both is HTTP (see
// the harness's own entry validation).
function toFacts(entry: z.infer<typeof entrySchema>): McpFacts {
  const transport = entry.url !== undefined ? 'http' : entry.command !== undefined ? 'stdio' : undefined
  return {
    transport,
    command: entry.command,
    args: entry.args,
    cwd: entry.cwd,
    env: entry.env,
    url: entry.url,
    headers: entry.headers,
    enabled: entry.enabled,
    timeoutRequest: entry.timeout,
    description: entry.description,
    exposure: entry.exposure,
  }
}
