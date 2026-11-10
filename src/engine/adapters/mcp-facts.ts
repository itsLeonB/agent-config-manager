import { createHash } from 'node:crypto'
import { classify, withheldMarker, type CredentialPointer } from '../secret.ts'
import type { DiscoveredDeclaration, Tier } from './types.ts'

// One server as an adapter read it: its name, its canonical facts, and the native address prefix it
// was found under. The prefix belongs to the entry because OpenCode reads the same server from
// `mcp.servers.<name>` (V2) or `mcp.<name>` (legacy V1), and a declaration's address must be one
// that actually exists in the file.
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

// The canonical credential pointers. Values at these never reach the store: `env.<K>` and
// `headers.<H>` are where every harness keeps an MCP token, and each one is withheld with its
// verdict. `auth` and `oauth` never become facts, so they have nothing to classify here. Keys stay,
// so a row still says which variables the server needs.
export const MCP_CREDENTIAL_POINTERS: readonly CredentialPointer[] = [
  { pointer: 'env.*', kind: 'leaf' },
  { pointer: 'headers.*', kind: 'leaf' },
]

// Every leaf of the canonical vocabulary. A fact added above must be projected here, or its value
// would reach the store verbatim.
export function knownFieldsForStorage(facts: McpFacts): McpFacts {
  return {
    // An inferred transport is `stdio` or `http`, never a credential.
    transport: facts.transport,
    command: classifyScalar('command', facts.command),
    args: classifyList('args', facts.args),
    cwd: classifyScalar('cwd', facts.cwd),
    env: classifyMap('env', facts.env),
    envPassthrough: classifyList('envPassthrough', facts.envPassthrough),
    url: classifyScalar('url', facts.url),
    headers: classifyMap('headers', facts.headers),
    enabled: facts.enabled,
    timeoutStartup: facts.timeoutStartup,
    timeoutRequest: facts.timeoutRequest,
    // The value is an environment-variable name — the secret-free form itself — so classifying it
    // by the credential-shaped pointer name would withhold the one field a reader has to carry.
    bearerTokenEnvVar: facts.bearerTokenEnvVar,
    description: classifyScalar('description', facts.description),
    exposure: classifyScalar('exposure', facts.exposure),
    toolExposure: classifyScalar('toolExposure', facts.toolExposure),
    approvalMode: classifyScalar('approvalMode', facts.approvalMode),
    disabledTools: classifyList('disabledTools', facts.disabledTools),
    required: facts.required,
    supportsParallelToolCalls: facts.supportsParallelToolCalls,
    codemode: facts.codemode,
  }
}

function classifyScalar(pointer: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Userinfo and query parameters are the two places an address can hide a credential, so an
  // address carrying either is parsed rather than classified as one opaque string.
  if (pointer === 'url' && (value.includes('@') || value.includes('?'))) return withoutUserinfo(value)
  const { verdict } = classify(pointer, value, MCP_CREDENTIAL_POINTERS)
  return verdict === 'clean' ? value : withheldMarker(verdict)
}

function classifyMap(
  pointer: string,
  map: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (map === undefined) return undefined
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [key, storedValue(`${pointer}.${key}`, value)]),
  )
}

function classifyList(pointer: string, list: string[] | undefined): string[] | undefined {
  return list?.map((value, index) => storedValue(`${pointer}.${index}`, value))
}

function storedValue(pointer: string, value: string): string {
  const { verdict } = classify(pointer, value, MCP_CREDENTIAL_POINTERS)
  return verdict === 'clean' ? value : withheldMarker(verdict)
}

// A url is not a credential pointer — a plain address has to stay readable — but basic-auth userinfo
// and a credential-shaped query parameter are. Userinfo is dropped, the address survives, so a
// native read still names the server; a query parameter is judged by its own name and value,
// because a `?token=` whose value is not provider-shaped would otherwise read as clean and reach a
// result verbatim.
function withoutUserinfo(url: string): string {
  let parsed: URL
  let hadUserinfo: boolean
  try {
    parsed = new URL(url)
    hadUserinfo = parsed.username !== '' || parsed.password !== ''
    parsed.username = ''
    parsed.password = ''
  } catch {
    // Fail closed: an address this process cannot parse is exactly the one whose userinfo it
    // cannot prove it removed.
    return withheldMarker('secret')
  }
  for (const [name, value] of parsed.searchParams) {
    const { verdict } = classify(`url.${name}`, value, MCP_CREDENTIAL_POINTERS)
    if (verdict !== 'clean') return withheldMarker(verdict)
  }
  const stripped = parsed.toString()
  const { verdict } = classify('url', stripped, MCP_CREDENTIAL_POINTERS)
  if (verdict !== 'clean') return withheldMarker(verdict)
  return hadUserinfo ? `${withheldMarker('secret')} ${stripped}` : stripped
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

// Every harness reads an MCP server into this one shape, so one answer is comparable across
// harnesses and only the native address differs.
export function mcpDeclaration(
  tier: Tier,
  file: string,
  server: McpEntry,
): DiscoveredDeclaration {
  return {
    category: 'mcp',
    name: server.name,
    tierId: tier.id,
    nativeFile: file,
    nativePointer: `${server.pointerPrefix}.${pointerSegment(server.name)}`,
    knownFieldsJson: JSON.stringify(knownFieldsForStorage(server.facts)),
    contentDigest: factsDigest(server.facts),
  }
}
