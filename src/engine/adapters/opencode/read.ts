import { z } from 'zod'
import { nativeObjectSchema, type NativeValue } from '../../native-value.ts'
import type { McpEntry, McpFacts } from '../mcp-facts.ts'
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

// `mcp` holds two kinds of key: the `servers` map and legacy flat server names beside it. The
// reserved keys hold global defaults, so they are exempt from server validation; every other key
// must be a server, and a malformed one makes the tier unreadable instead of vanishing.
const RESERVED_MCP_KEYS = new Set(['servers', 'timeout'])

// The legacy flat shape a reader cannot leave unremarked: OpenCode reads `mcp.<name>` beside
// `mcp.servers`, so a document holding both defines every legacy server twice. The read therefore
// normalises the block, and `absent` means there is nothing to convert.
export type LegacyMcpNormalisation =
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string }
  // `rewritten` names the entries whose spelling had to change, so the read can report a conversion
  // it made to somebody else's entry instead of changing it quietly.
  | { kind: 'normalised'; value: Record<string, NativeValue>; rewritten: { name: string; spellings: string[] }[] }

// Every legacy entry moves under `servers`, with its two legacy spellings converted: `enabled` is
// `disabled` inverted, and one numeric `timeout` covers both phases. The reserved keys stay put, and
// a value that is not a table is reported rather than guessed at.
export function normaliseLegacyMcp(document: NativeValue): LegacyMcpNormalisation {
  const root = nativeObjectSchema.safeParse(document)
  const mcp = nativeObjectSchema.safeParse(root.success ? root.data.mcp : null)
  if (!mcp.success) return { kind: 'absent' }
  const legacy = Object.keys(mcp.data).filter((key) => !RESERVED_MCP_KEYS.has(key))
  if (legacy.length === 0) return { kind: 'absent' }
  const servers = nativeObjectSchema.safeParse(mcp.data.servers ?? {})
  if (!servers.success) return { kind: 'invalid', detail: 'mcp.servers is not a table' }
  const converted = { ...servers.data }
  const rewritten: { name: string; spellings: string[] }[] = []
  for (const name of legacy) {
    const entry = nativeObjectSchema.safeParse(mcp.data[name])
    if (!entry.success) return { kind: 'invalid', detail: `mcp.${name} is not a server entry` }
    // Which of the two definitions the harness honours is not verified, so a name in both is
    // reported rather than resolved by picking one.
    // `Object.hasOwn`, not a value test: a server can legitimately be named `toString`, and the
    // inherited member is not a definition the file holds.
    if (Object.hasOwn(converted, name)) {
      return { kind: 'invalid', detail: `mcp.${name} is defined both flat and under mcp.servers` }
    }
    const lifted = fromLegacyEntry(entry.data)
    converted[name] = lifted.entry
    if (lifted.spellings.length > 0) rewritten.push({ name, spellings: lifted.spellings })
  }
  const reserved = Object.fromEntries(
    Object.entries(mcp.data).filter(([key]) => RESERVED_MCP_KEYS.has(key) && key !== 'servers'),
  )
  return { kind: 'normalised', value: { servers: converted, ...reserved }, rewritten }
}

// A per-phase timeout object is already the current spelling, so it is carried as it stands —
// including `catalog`, which the canonical vocabulary does not name but the file still holds.
function fromLegacyEntry(entry: Record<string, NativeValue>) {
  const { enabled, timeout, ...rest } = entry
  const converted = { ...rest }
  const spellings: string[] = []
  const flag = z.boolean().safeParse(enabled)
  if (flag.success && converted.disabled === undefined) {
    converted.disabled = !flag.data
    spellings.push('enabled inverted to disabled')
  }
  const milliseconds = z.number().safeParse(timeout)
  if (milliseconds.success) {
    converted.timeout = { startup: milliseconds.data, execution: milliseconds.data }
    spellings.push('numeric timeout split across timeout.startup and timeout.execution')
  } else if (timeout !== undefined) {
    converted.timeout = timeout
  }
  return { entry: converted, spellings }
}

export function readOpenCodeMcpJsonc(text: string): ParsedEntries<McpEntry> {
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

  const entries: McpEntry[] = []
  const servers = parsed.data.mcp?.servers
  if (servers !== undefined) {
    const group = z.record(z.string(), entrySchema).safeParse(servers)
    if (!group.success) {
      return { kind: 'invalid', detail: group.error.issues[0]?.message ?? 'invalid mcp.servers' }
    }
    for (const [name, entry] of Object.entries(group.data)) {
      // A remote server with no address connects to nothing, so it is a broken entry rather than a
      // healthy HTTP server.
      if (entry.type === 'remote' && entry.url === undefined) {
        return { kind: 'invalid', detail: `${name} is remote with no url` }
      }
      entries.push({ name, facts: toFacts(entry), pointerPrefix: 'mcp.servers' })
    }
  }
  // Everything else under `mcp` is the legacy flat V1 shape, which V2 still accepts next to
  // `servers` in the same document.
  for (const [name, value] of Object.entries(parsed.data.mcp ?? {})) {
    if (RESERVED_MCP_KEYS.has(name)) continue
    const legacy = entrySchema.safeParse(value)
    if (!legacy.success) {
      return { kind: 'invalid', detail: legacy.error.issues[0]?.message ?? `invalid server ${name}` }
    }
    // A legacy entry naming no transport connects to nothing, so it is not a server.
    if (
      legacy.data.type === undefined &&
      legacy.data.command === undefined &&
      legacy.data.url === undefined
    ) {
      continue
    }
    entries.push({ name, facts: toFacts(legacy.data), pointerPrefix: 'mcp' })
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
      // An unterminated comment would silently swallow the rest of the document, and what is left
      // can still parse as valid JSON.
      if (end === -1) throw new Error('unterminated block comment')
      index = end + 2
      continue
    }
    if (char === ',') {
      const next = skipTrivia(text, index + 1)
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

// The next character that is neither whitespace nor a comment: a trailing comma is still trailing
// when a comment sits between it and the closing bracket.
function skipTrivia(text: string, from: number): number {
  let index = from
  for (;;) {
    while (index < text.length && /\s/.test(text[index] ?? '')) index++
    if (text[index] === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++
      continue
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end === -1) throw new Error('unterminated block comment')
      index = end + 2
      continue
    }
    return index
  }
}
