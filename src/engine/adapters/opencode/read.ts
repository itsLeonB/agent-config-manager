import { z } from 'zod'
import type { McpFacts } from '../mcp-facts.ts'
import type { ParsedEntries } from '../tier.ts'

// OpenCode's config is JSONC, and V2 names servers under `mcp.servers.<name>` while the legacy V1
// shape puts them directly under `mcp.<name>` with `enabled` instead of `disabled`. Both are legal
// in one document, so both are read; `oauth` is deliberately unnamed, so its `client_secret` never
// becomes a fact.
const timeoutSchema = z.union([
  // A legacy entry carries one number for every phase; V2 carries a per-phase object.
  z.number().transform((milliseconds) => ({ startup: milliseconds, execution: milliseconds })),
  z.object({
    startup: z.number().optional(),
    catalog: z.number().optional(),
    execution: z.number().optional(),
  }),
])

const entrySchema = z.object({
  type: z.enum(['local', 'remote']).optional(),
  command: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
  timeout: timeoutSchema.optional(),
  codemode: z.boolean().optional(),
})

const fileSchema = z.object({
  mcp: z.record(z.string(), z.unknown()).optional(),
})

export type OpenCodeMcpEntry = { name: string; facts: McpFacts }

export function readOpenCodeMcpJsonc(text: string): ParsedEntries<OpenCodeMcpEntry> {
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonc(text))
  } catch {
    return { kind: 'invalid', detail: 'opencode config is not valid JSONC' }
  }
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) {
    return { kind: 'invalid', detail: parsed.error.issues[0]?.message ?? 'invalid opencode config' }
  }

  const entries: OpenCodeMcpEntry[] = []
  const servers = parsed.data.mcp?.servers
  if (servers !== undefined) {
    const group = z.record(z.string(), entrySchema).safeParse(servers)
    if (!group.success) {
      return { kind: 'invalid', detail: group.error.issues[0]?.message ?? 'invalid mcp.servers' }
    }
    for (const [name, entry] of Object.entries(group.data)) {
      entries.push({ name, facts: toFacts(entry) })
    }
  }
  // Everything else under `mcp` is the legacy flat V1 shape, which V2 still accepts next to
  // `servers` in the same document. A key that names no transport is not a server — `mcp.timeout`
  // holds global phase defaults — so reading it as one would invent an installation.
  for (const [name, value] of Object.entries(parsed.data.mcp ?? {})) {
    if (name === 'servers') continue
    const legacy = entrySchema.safeParse(value)
    if (!legacy.success) {
      return { kind: 'invalid', detail: legacy.error.issues[0]?.message ?? `invalid server ${name}` }
    }
    if (
      legacy.data.type === undefined &&
      legacy.data.command === undefined &&
      legacy.data.url === undefined
    ) {
      continue
    }
    entries.push({ name, facts: toFacts(legacy.data) })
  }
  return { kind: 'ok', entries }
}

// OpenCode's V2 boolean is inverted (`disabled`), and a legacy entry may still carry `enabled`. A
// document that says neither leaves the fact unknown rather than assuming a default.
function toFacts(entry: z.infer<typeof entrySchema>): McpFacts {
  const transport =
    entry.type === 'local'
      ? 'stdio'
      : entry.type === 'remote'
        ? 'http'
        : entry.url !== undefined
          ? 'http'
          : entry.command !== undefined
            ? 'stdio'
            : undefined
  const [command, ...args] = entry.command ?? []
  const timeout = timeoutSeconds(entry.timeout)
  return {
    transport,
    command,
    args: entry.command === undefined ? undefined : args,
    cwd: entry.cwd,
    env: entry.environment,
    url: entry.url,
    headers: entry.headers,
    enabled: entry.disabled === undefined ? entry.enabled : !entry.disabled,
    timeoutStartup: timeout.startup,
    timeoutRequest: timeout.execution,
    codemode: entry.codemode,
  }
}

// OpenCode stores milliseconds where Codex stores seconds, so the canonical fields are seconds.
function timeoutSeconds(timeout: z.infer<typeof timeoutSchema> | undefined) {
  return {
    startup: timeout?.startup === undefined ? undefined : timeout.startup / 1000,
    execution: timeout?.execution === undefined ? undefined : timeout.execution / 1000,
  }
}

// Strips `//` and `/* */` comments and trailing commas, leaving string bodies untouched: a `//`
// inside a value is data, not a comment, and neither is a comma before a closing brace.
export function stripJsonc(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      const start = index++
      while (index < text.length && text[index] !== '"') {
        index += text[index] === '\\' ? 2 : 1
      }
      out += text.slice(start, index + 1)
      index++
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }
    if (char === ',') {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next] ?? '')) next++
      if (text[next] === '}' || text[next] === ']') {
        index++
        continue
      }
    }
    out += char
    index++
  }
  return out
}
