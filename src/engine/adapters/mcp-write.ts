// The rules below are the machine-readable half of docs/mcp-field-tables.md: one surface per harness,
// listing the canonical facts it expresses and the transforms that get them there. A change to a
// table in that doc belongs here too, and `plan.test.ts` checks that every name used here is a
// canonical fact and that no field is both written and declared absent.
import { z } from 'zod'
import { withheldVerdict, type McpFacts, type McpValue } from './mcp-facts.ts'
import type { HarnessId } from './types.ts'

// The seven transforms ticket 12 settled: every way a canonical MCP value reaches a target field
// that is not a byte copy under the same name.
export type Transform = 'rename' | 'invert' | 'concat' | 'unit' | 'infer' | 'extract' | 'wrap'

// One target field a harness can express, plus the transform that gets the source there. `fields`
// names every canonical fact the rule consumes, because OpenCode's `command[]` takes two of them.
export interface McpWriteRule {
  fields: readonly (keyof McpFacts)[]
  // Native field name under the entry pointer. Empty when the target expresses the fact through the
  // presence of another field — `transport` is inferred from `command` vs `url` everywhere.
  target: string
  // The key a `wrap` lands under when the target field is a map (`headers.Authorization`).
  targetKey?: string
  // Absent means a verbatim carry: the same value under the same name.
  transform?: Transform
  // `extract`: the pattern of a formatted value, one capture. `wrap`: the reference to build, with
  // `$value` standing for the bare identifier it wraps.
  template?: string
  // `unit`: the factor between the source unit and the target's.
  multiplier?: number
  // `extract` from a map of formatted values lands every capture as one list (`env_vars`).
  asList?: boolean
  // A rule that owns the field but cannot express it. The planner reports this instead of writing.
  gap?: 'shapeOnly' | 'fieldAbsent'
  // The values this rule owns; the first rule for a field whose `accepts` holds wins.
  accepts?: (value: McpValue, facts: McpFacts) => boolean
}

// What one harness can write for the `mcp` category. `absent` is the fields the harness provably
// has no home for: a plan reports those as gaps. A field in neither list is `preserved`, which is
// how a fact added to `McpFacts` before its planner rule lands stays visibly untouched.
export interface McpWriteSurface {
  pointerPrefix: string
  rules: readonly McpWriteRule[]
  absent: readonly (keyof McpFacts)[]
}

const stringMap = z.record(z.string(), z.string())

// Codex does no interpolation at all, so a Pi `headers.Authorization: "Bearer ${T}"` copied across
// would ship the literal string as a token — and the same goes for an `env` value of `${T}`, which
// stays the four characters `${T}` once Codex has written it into the child process. `extract` is
// the only safe route: the variable name travels, the formatting does not.
const BEARER_REFERENCE = /^Bearer \$\{([A-Za-z_]\w*)\}$/
const ENV_REFERENCE = /^\$\{([A-Za-z_]\w*)\}$/

function stringEntries(value: McpValue | undefined): [string, string][] | undefined {
  const map = stringMap.safeParse(value)
  return map.success ? Object.entries(map.data) : undefined
}

function soleAuthorization(value: McpValue | undefined): string | undefined {
  const entries = stringEntries(value)
  if (entries === undefined) return undefined
  return entries.length === 1 && entries[0]?.[0] === 'Authorization' ? entries[0][1] : undefined
}

function bearerReference(value: McpValue | undefined): boolean {
  return BEARER_REFERENCE.test(soleAuthorization(value) ?? '')
}

// Every value a `${VAR}` reference, or nothing: a map that is partly literal has to stay literal.
function allEnvReferences(value: McpValue | undefined): boolean {
  const entries = stringEntries(value)
  return entries !== undefined && entries.length > 0 && entries.every(([, entry]) => ENV_REFERENCE.test(entry))
}

function anyEnvReference(value: McpValue | undefined): boolean {
  const entries = stringEntries(value)
  return entries !== undefined && entries.some(([, entry]) => ENV_REFERENCE.test(entry))
}

const codex: McpWriteSurface = {
  pointerPrefix: 'mcp_servers',
  rules: [
    { fields: ['transport'], target: '', transform: 'infer' },
    { fields: ['command'], target: 'command' },
    { fields: ['args'], target: 'args' },
    { fields: ['cwd'], target: 'cwd' },
    // A reference is forwarded as Codex's own passthrough list; a literal map is carried verbatim.
    {
      fields: ['env'],
      target: 'env_vars',
      transform: 'extract',
      template: ENV_REFERENCE.source,
      asList: true,
      accepts: (value, facts) => facts.envPassthrough === undefined && allEnvReferences(value),
    },
    { fields: ['env'], target: 'env', accepts: (value) => !anyEnvReference(value) },
    { fields: ['env'], target: '', gap: 'shapeOnly', accepts: anyEnvReference },
    { fields: ['envPassthrough'], target: 'env_vars', transform: 'rename' },
    { fields: ['url'], target: 'url' },
    {
      fields: ['headers'],
      target: 'bearer_token_env_var',
      transform: 'extract',
      template: BEARER_REFERENCE.source,
      accepts: bearerReference,
    },
    { fields: ['headers'], target: 'http_headers', transform: 'rename' },
    { fields: ['enabled'], target: 'enabled' },
    { fields: ['timeoutStartup'], target: 'startup_timeout_sec', transform: 'rename' },
    { fields: ['timeoutRequest'], target: 'tool_timeout_sec', transform: 'rename' },
    { fields: ['bearerTokenEnvVar'], target: 'bearer_token_env_var', transform: 'rename' },
    { fields: ['approvalMode'], target: 'default_tools_approval_mode', transform: 'rename' },
    { fields: ['disabledTools'], target: 'disabled_tools', transform: 'rename' },
    { fields: ['required'], target: 'required' },
    { fields: ['supportsParallelToolCalls'], target: 'supports_parallel_tool_calls', transform: 'rename' },
  ],
  absent: ['description', 'exposure', 'toolExposure', 'codemode'],
}

const pi: McpWriteSurface = {
  pointerPrefix: 'mcpServers',
  rules: [
    { fields: ['transport'], target: '', transform: 'infer' },
    { fields: ['command'], target: 'command' },
    { fields: ['args'], target: 'args' },
    { fields: ['cwd'], target: 'cwd' },
    { fields: ['env'], target: 'env' },
    // Codex's `env_vars` is a list of names; Pi's `env` reads a value of `${K}`. Keys the literal
    // `env` map already holds are dropped here, so the literal value keeps its pointer.
    {
      fields: ['envPassthrough'],
      target: 'env',
      transform: 'wrap',
      template: '${$value}',
      accepts: (value) => z.array(z.string()).safeParse(value).success,
    },
    { fields: ['url'], target: 'url' },
    { fields: ['headers'], target: 'headers' },
    // Codex's bare variable name becomes Pi's interpolation reference in the header it belongs to,
    // unless the source already carries that header — then the header wins.
    {
      fields: ['bearerTokenEnvVar'],
      target: 'headers',
      targetKey: 'Authorization',
      transform: 'wrap',
      template: 'Bearer ${$value}',
      accepts: (value) => z.string().safeParse(value).success,
    },
    { fields: ['enabled'], target: 'enabled' },
    { fields: ['timeoutRequest'], target: 'timeout', transform: 'rename' },
    { fields: ['description'], target: 'description' },
    { fields: ['exposure'], target: 'exposure' },
  ],
  absent: [
    'timeoutStartup',
    'approvalMode',
    'disabledTools',
    'required',
    'supportsParallelToolCalls',
    'codemode',
  ],
}

const opencode: McpWriteSurface = {
  pointerPrefix: 'mcp.servers',
  rules: [
    { fields: ['transport'], target: 'type', transform: 'infer' },
    // OpenCode's `command` is one array where Codex and Pi keep `command` + `args`.
    { fields: ['command', 'args'], target: 'command', transform: 'concat' },
    { fields: ['cwd'], target: 'cwd' },
    // OpenCode reads its own reference form, `{env:VAR}`, so a Pi `${VAR}` is rewritten into it
    // rather than shipped as a literal string it would never interpolate.
    {
      fields: ['env'],
      target: 'environment',
      transform: 'wrap',
      template: '{env:$value}',
      accepts: allEnvReferences,
    },
    {
      fields: ['env'],
      target: 'environment',
      transform: 'rename',
      accepts: (value) => !anyEnvReference(value),
    },
    { fields: ['env'], target: '', gap: 'shapeOnly', accepts: anyEnvReference },
    { fields: ['url'], target: 'url' },
    { fields: ['headers'], target: 'headers' },
    { fields: ['enabled'], target: 'disabled', transform: 'invert' },
    { fields: ['timeoutStartup'], target: 'timeout.startup', transform: 'unit', multiplier: 1000 },
    { fields: ['timeoutRequest'], target: 'timeout.execution', transform: 'unit', multiplier: 1000 },
    { fields: ['codemode'], target: 'codemode' },
  ],
  absent: [
    'envPassthrough',
    'bearerTokenEnvVar',
    'description',
    'exposure',
    'toolExposure',
    'approvalMode',
    'disabledTools',
    'required',
    'supportsParallelToolCalls',
  ],
}

export const MCP_WRITE_SURFACES = { pi, codex, opencode } satisfies Record<HarnessId, McpWriteSurface>

// The first rule that owns this field and this value. Extract and wrap rules are listed ahead of the
// plain carries they would otherwise be shadowed by.
export function matchRule(
  surface: McpWriteSurface,
  field: keyof McpFacts,
  value: McpValue,
  facts: McpFacts,
): McpWriteRule | undefined {
  return surface.rules.find(
    (rule) =>
      rule.fields.includes(field) &&
      (rule.accepts === undefined || rule.accepts(value, facts)) &&
      // A rule that consumes several fields may not run on a partial one: a withheld `command` must
      // not be dropped while its `args` are concatenated into a command this engine invented.
      rule.fields.every((consumed) => cleanField(facts, consumed)),
  )
}

// The native value the target takes for this rule, already transformed. `undefined` means the rule
// writes nothing: an inferred transport is carried by which address field is present, and a wrapped
// key the source already holds literally keeps the literal value.
export function ruleValue(rule: McpWriteRule, facts: McpFacts): McpValue | undefined {
  switch (rule.transform) {
    case undefined:
    case 'rename':
      return scalarOf(facts, rule.fields[0])
    case 'invert': {
      const enabled = z.boolean().safeParse(scalarOf(facts, rule.fields[0]))
      return enabled.success ? !enabled.data : undefined
    }
    case 'unit': {
      const number = z.number().safeParse(scalarOf(facts, rule.fields[0]))
      return number.success && rule.multiplier !== undefined ? number.data * rule.multiplier : undefined
    }
    case 'concat': {
      const command = z.string().safeParse(scalarOf(facts, 'command'))
      const args = z.array(z.string()).safeParse(scalarOf(facts, 'args'))
      const list = args.success ? args.data : []
      if (!command.success && list.length === 0) return undefined
      return command.success ? [command.data, ...list] : list
    }
    case 'infer':
      // Only OpenCode names a transport; Codex and Pi infer it from `command` vs `url`.
      if (rule.target === '') return undefined
      return facts.url === undefined ? 'local' : 'remote'
    case 'extract':
      return extractValue(rule, facts)
    case 'wrap':
      return wrapValue(rule, facts)
  }
}

// Extract a component of a formatted value: the bearer variable out of the one header that carries
// it, or every variable out of a map of `env` references.
function extractValue(rule: McpWriteRule, facts: McpFacts): McpValue | undefined {
  const pattern = new RegExp(rule.template ?? '')
  const entries = stringEntries(scalarOf(facts, rule.fields[0]))
  const captures = entries?.map(([, entry]) => pattern.exec(entry)?.[1]) ?? []
  if (captures.length === 0 || captures.some((capture) => capture === undefined)) return undefined
  const names = captures.filter((capture) => capture !== undefined)
  return rule.asList ? names : names[0]
}

function wrapValue(rule: McpWriteRule, facts: McpFacts): McpValue | undefined {
  const template = rule.template ?? '$value'
  const source = scalarOf(facts, rule.fields[0])
  const names = z.array(z.string()).safeParse(source)
  if (names.success) {
    // A key the target already holds literally keeps the literal value: the map's own write wins.
    const taken = facts.env ?? {}
    const fresh = names.data.filter((name) => taken[name] === undefined)
    return fresh.length === 0
      ? undefined
      : Object.fromEntries(fresh.map((name) => [name, template.replace('$value', name)]))
  }
  const entries = stringEntries(source)
  if (entries !== undefined) {
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, template.replace('$value', ENV_REFERENCE.exec(entry)?.[1] ?? entry)]),
    )
  }
  const name = z.string().safeParse(source)
  if (!name.success || rule.targetKey === undefined) return undefined
  if (facts.headers?.[rule.targetKey] !== undefined) return undefined
  return { [rule.targetKey]: template.replace('$value', name.data) }
}

// The field is present and carries no withheld value. Checked before a rule may consume it, so a
// multi-field rule never sees a partial value.
function cleanField(facts: McpFacts, field: keyof McpFacts): boolean {
  const value = facts[field]
  return value === undefined || withheldVerdict(value) === 'clean'
}

// A rule's first field, read as the value the target takes. Kept separate so the switch above reads
// as one case per transform rather than as one case per field type. A withheld value is a marker,
// not data, so no rule may consume one.
function scalarOf(facts: McpFacts, field: keyof McpFacts | undefined): McpValue | undefined {
  if (field === undefined) return undefined
  const value = facts[field]
  return value === undefined || withheldVerdict(value) !== 'clean' ? undefined : value
}
