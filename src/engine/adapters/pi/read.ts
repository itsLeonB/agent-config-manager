import { createHash } from 'node:crypto'
import { z } from 'zod'

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

export interface McpFacts {
  transport?: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  timeoutRequest?: number
  description?: string
  exposure?: string
}

export type PiMcpReadOutcome =
  | { kind: 'ok'; servers: { name: string; facts: McpFacts }[] }
  | { kind: 'invalid'; detail: string }

// Pure over bytes so the parse can be tested without a filesystem.
export function readPiMcpJson(text: string): PiMcpReadOutcome {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text))
    if (!parsed.success) {
      return { kind: 'invalid', detail: parsed.error.issues[0]?.message ?? 'invalid mcp.json' }
    }
    const servers = Object.entries(parsed.data.mcpServers ?? {}).map(([name, entry]) => ({
      name,
      facts: toFacts(entry),
    }))
    return { kind: 'ok', servers }
  } catch {
    return { kind: 'invalid', detail: 'mcp.json is not valid JSON' }
  }
}

function toFacts(entry: z.infer<typeof entrySchema>): McpFacts {
  const transport =
    entry.command !== undefined ? 'stdio' : entry.url !== undefined ? 'http' : undefined
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

// Pi's credential pointers for MCP are `env.<K>`, `headers.<H>`, `auth` and `url` userinfo
// (ticket 12 §3): no value at those pointers reaches the store. Keys stay so a row still says
// which variables the server needs, and `auth` never becomes a fact at all.
// shortcut: coarse withholding until ticket 18's classifier reports a verdict instead.
const WITHHELD = '[withheld]'

export function knownFieldsForStorage(facts: McpFacts): McpFacts {
  return {
    ...facts,
    url: facts.url === undefined ? undefined : withoutUserinfo(facts.url),
    env: withheldValues(facts.env),
    headers: withheldValues(facts.headers),
  }
}

function withheldValues(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (map === undefined) return undefined
  return Object.fromEntries(Object.keys(map).map((key) => [key, WITHHELD]))
}

function withoutUserinfo(url: string): string {
  if (!url.includes('@')) return url
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    // Fail closed: an address this process cannot parse is exactly the one whose userinfo it
    // cannot prove it removed.
    return '[withheld]'
  }
}

// shortcut: the digest covers adapter-known fields only, so an edit to a field this adapter does
// not name is not drift. A credential value is hashed, never stored.
export function factsDigest(facts: McpFacts): string {
  const canonical = {
    ...facts,
    env: sortedMap(facts.env),
    headers: sortedMap(facts.headers),
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
}

function sortedMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (map === undefined) return undefined
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
}
