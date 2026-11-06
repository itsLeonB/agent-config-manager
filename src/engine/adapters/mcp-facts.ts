import { createHash } from 'node:crypto'
import type { DiscoveredInstallation, Tier } from './types.ts'

// One server as an adapter read it: its name, its canonical facts, and the native address prefix it
// was found under. The prefix belongs to the entry because OpenCode reads the same server from
// `mcp.servers.<name>` (V2) or `mcp.<name>` (legacy V1), and a row's address must be one that
// actually exists in the file.
export interface McpEntry {
  name: string
  facts: McpFacts
  pointerPrefix: string
}

// The canonical MCP vocabulary every adapter reads into, so one server is comparable across
// harnesses. A field no adapter names here never becomes a fact, and a harness-only field stays in
// the row for the harness that owns it.
export interface McpFacts {
  transport?: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  envPassthrough?: string[]
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  timeoutStartup?: number
  timeoutRequest?: number
  bearerTokenEnvVar?: string
  description?: string
  exposure?: string
  toolExposure?: string
  approvalMode?: string
  disabledTools?: string[]
  required?: boolean
  supportsParallelToolCalls?: boolean
  codemode?: boolean
}

// Each harness's MCP credential pointers are `env.<K>`, `headers.<H>` and `url` userinfo, so no
// value at those pointers reaches the store. Keys stay, so a row still says which variables the
// server needs.
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

// shortcut: the digest covers adapter-known fields only, so an edit to a field no adapter names is
// not drift. A credential value is hashed, never stored.
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

// One dotted step of a native pointer. A name containing a dot has to be quoted, or the address
// names two different entries in both JSON and TOML.
export function pointerSegment(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name
  // JSON string escaping covers quotes, backslashes and control characters, so two names differing
  // only in an unprintable character keep distinct addresses.
  return JSON.stringify(name)
}

// Every harness reads an MCP server into this one row shape, so a listing is comparable across
// harnesses and only the native address differs.
export function mcpInstallation(
  tier: Tier,
  file: string,
  server: McpEntry,
): DiscoveredInstallation {
  return {
    category: 'mcp',
    name: server.name,
    scope: tier.scopeBucket,
    tierId: tier.id,
    nativeFile: file,
    nativePointer: `${server.pointerPrefix}.${pointerSegment(server.name)}`,
    knownFieldsJson: JSON.stringify(knownFieldsForStorage(server.facts)),
    contentDigest: factsDigest(server.facts),
  }
}
