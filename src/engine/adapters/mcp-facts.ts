import { createHash } from 'node:crypto'
import { z } from 'zod'
import { classify, storedVerdict, withheldMarker, type CredentialPointer, type Verdict } from '../secret.ts'
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

// Every canonical field, in the order a plan partitions them. A field named here is one an adapter
// may read; `factsFromKnownFields` uses the list to tell a field a plan does not know from one it
// merely cannot express.
export const MCP_FIELDS = [
  'transport',
  'command',
  'args',
  'cwd',
  'env',
  'envPassthrough',
  'url',
  'headers',
  'enabled',
  'timeoutStartup',
  'timeoutRequest',
  'bearerTokenEnvVar',
  'description',
  'exposure',
  'toolExposure',
  'approvalMode',
  'disabledTools',
  'required',
  'supportsParallelToolCalls',
  'codemode',
] as const satisfies readonly (keyof McpFacts)[]

// The value a single canonical field holds. A plan write and a rule's output are both this.
export type McpValue = string | number | boolean | string[] | Record<string, string>

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
    // by the credential-shaped pointer name would withhold the one field a mirror has to carry.
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
// and a credential-shaped query parameter are. Userinfo is dropped, the address survives, so inspect
// still names the server; a query parameter is judged by its own name and value, because a `?token=`
// whose value is not provider-shaped would otherwise read as clean and reach the store verbatim.
// A url carried whole — as a plan carries a legacy block — is judged the way the reader judges it:
// userinfo this process can strip, or a credential-shaped query parameter, makes it unclean. A
// pointer list cannot express this, because what is wrong is inside the value, not its name.
export function urlVerdict(url: string): Verdict {
  return withoutUserinfo(url) === url ? 'clean' : 'secret'
}

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

const MCP_FIELD_SET: ReadonlySet<string> = new Set(MCP_FIELDS)

// The inverse of `knownFieldsForStorage`: one stored row decoded back into facts. A key no adapter
// names comes back as unknown rather than as a fact, so a plan can report it untouched instead of
// writing a field it does not understand.
export interface KnownFacts {
  facts: McpFacts
  unknown: string[]
}

// A row that cannot be decoded is reported, not silently emptied: a plan built from nothing would
// claim the source holds no fields at all.
export type KnownFactsResult = ({ kind: 'ok' } & KnownFacts) | { kind: 'invalid'; detail: string }

const factValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.record(z.string(), z.string()),
])

const storedFacts = z.object({
  transport: z.enum(['stdio', 'http']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envPassthrough: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  timeoutStartup: z.number().optional(),
  timeoutRequest: z.number().optional(),
  bearerTokenEnvVar: z.string().optional(),
  description: z.string().optional(),
  exposure: z.string().optional(),
  toolExposure: z.string().optional(),
  approvalMode: z.string().optional(),
  disabledTools: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  supportsParallelToolCalls: z.boolean().optional(),
  codemode: z.boolean().optional(),
})

export function factsFromKnownFields(json: string): KnownFactsResult {
  let document: unknown
  try {
    document = JSON.parse(json)
  } catch {
    return { kind: 'invalid', detail: 'known fields are not valid JSON' }
  }
  const stored = z.record(z.string(), factValue).safeParse(document)
  if (!stored.success) return { kind: 'invalid', detail: stored.error.issues[0]?.message ?? 'unexpected value shape' }
  // A row whose values are not the shapes the vocabulary holds is not partly trusted either.
  const facts = storedFacts.safeParse(stored.data)
  if (!facts.success) {
    return { kind: 'invalid', detail: facts.error.issues[0]?.message ?? 'unexpected field shape' }
  }
  return {
    kind: 'ok',
    facts: facts.data,
    unknown: Object.keys(stored.data).filter((key) => !MCP_FIELD_SET.has(key)),
  }
}

// The verdict of a whole value: a map or list is only clean when every entry in it is.
export function withheldVerdict(value: McpValue): Verdict {
  const scalar = z.string().safeParse(value)
  if (scalar.success) return storedVerdict(scalar.data)
  const map = z.record(z.string(), z.string()).safeParse(value)
  if (map.success) return worstVerdict(Object.values(map.data))
  const list = z.array(z.string()).safeParse(value)
  return worstVerdict(list.success ? list.data : [])
}

function worstVerdict(values: string[]): Verdict {
  const verdicts = values.map(storedVerdict)
  if (verdicts.includes('secret')) return 'secret'
  return verdicts.includes('suspect') ? 'suspect' : 'clean'
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

// The steps back out of a pointer, unquoting what `pointerSegment` quoted.
export function pointerSegments(pointer: string): string[] {
  const segments: string[] = []
  let index = 0
  while (index < pointer.length) {
    if (pointer[index] === '"') {
      let end = index + 1
      while (end < pointer.length && pointer[end] !== '"') end += pointer[end] === '\\' ? 2 : 1
      const quoted = JSON.parse(pointer.slice(index, end + 1))
      const name = z.string().safeParse(quoted)
      segments.push(name.success ? name.data : '')
      index = end + 2
      continue
    }
    const dot = pointer.indexOf('.', index)
    if (dot === -1) {
      segments.push(pointer.slice(index))
      break
    }
    segments.push(pointer.slice(index, dot))
    index = dot + 1
  }
  return segments
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
