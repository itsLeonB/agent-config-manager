import { z } from 'zod'
import type { McpFacts, McpValue } from './mcp-facts.ts'
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
const stringValue = z.string()

// Codex does no interpolation at all, so a Pi `headers.Authorization: "Bearer ${T}"` copied across
// would ship the literal string as a token. `extract` is the only safe route: the variable name
// travels, the header does not.
const BEARER_REFERENCE = /^Bearer \$\{([A-Za-z_]\w*)\}$/

function soleAuthorization(value: McpValue): string | undefined {
  const map = stringMap.safeParse(value)
  if (!map.success) return undefined
  const keys = Object.keys(map.data)
  return keys.length === 1 && keys[0] === 'Authorization' ? map.data.Authorization : undefined
}

function bearerReference(value: McpValue): boolean {
  return BEARER_REFERENCE.test(soleAuthorization(value) ?? '')
}

const codex: McpWriteSurface = {
  pointerPrefix: 'mcp_servers',
  rules: [
    { fields: ['transport'], target: '', transform: 'infer' },
    { fields: ['command'], target: 'command' },
    { fields: ['args'], target: 'args' },
    { fields: ['cwd'], target: 'cwd' },
    { fields: ['env'], target: 'env' },
    { fields: ['envPassthrough'], target: 'env_vars', transform: 'rename' },
    { fields: ['url'], target: 'url' },
    {
      fields: ['headers'],
      target: 'bearer_token_env_var',
      transform: 'extract',
      template: BEARER_REFERENCE.source,
      accepts: bearerReference,
    },
    { fields: ['headers'], target: 'http_headers' },
    { fields: ['enabled'], target: 'enabled' },
    { fields: ['timeoutStartup'], target: 'startup_timeout_sec', transform: 'rename' },
    { fields: ['timeoutRequest'], target: 'tool_timeout_sec', transform: 'rename' },
    { fields: ['bearerTokenEnvVar'], target: 'bearer_token_env_var' },
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
    // Codex's `env_vars` is a list of names; Pi's `env` reads a value of `${K}`. A source that
    // already has a literal `env` map keeps it — two rules may not share a pointer.
    {
      fields: ['envPassthrough'],
      target: 'env',
      transform: 'wrap',
      template: '${$value}',
      accepts: (value, facts) => facts.env === undefined && z.array(z.string()).safeParse(value).success,
    },
    { fields: ['url'], target: 'url' },
    { fields: ['headers'], target: 'headers' },
    // Codex's bare variable name becomes Pi's interpolation reference in the header it belongs to.
    {
      fields: ['bearerTokenEnvVar'],
      target: 'headers',
      targetKey: 'Authorization',
      transform: 'wrap',
      template: 'Bearer ${$value}',
      accepts: (value, facts) => facts.headers === undefined && stringValue.safeParse(value).success,
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
    { fields: ['env'], target: 'environment', transform: 'rename' },
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
    (rule) => rule.fields.includes(field) && (rule.accepts === undefined || rule.accepts(value, facts)),
  )
}

// The native value the target takes for this rule, already transformed. `undefined` means the rule
// writes nothing: an inferred transport is carried by which address field is present.
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
      const command = facts.command
      const args = facts.args ?? []
      if (command === undefined && args.length === 0) return undefined
      return command === undefined ? args : [command, ...args]
    }
    case 'infer':
      // Only OpenCode names a transport; Codex and Pi infer it from `command` vs `url`.
      if (rule.target === '') return undefined
      return facts.url === undefined ? 'local' : 'remote'
    case 'extract': {
      const match = new RegExp(rule.template ?? '').exec(soleAuthorization(scalarMap(facts.headers)) ?? '')
      return match?.[1]
    }
    case 'wrap': {
      const template = rule.template ?? '$value'
      const source = facts[rule.fields[0] ?? 'envPassthrough']
      const names = z.array(z.string()).safeParse(source)
      if (names.success) {
        return Object.fromEntries(names.data.map((name) => [name, template.replace('$value', name)]))
      }
      const name = z.string().safeParse(source)
      if (!name.success || rule.targetKey === undefined) return undefined
      return { [rule.targetKey]: template.replace('$value', name.data) }
    }
  }
}

// A rule's first field, read as the value the target takes. Kept separate so the switch above reads
// as one case per transform rather than as one case per field type.
function scalarOf(facts: McpFacts, field: keyof McpFacts | undefined): McpValue | undefined {
  return field === undefined ? undefined : facts[field]
}

function scalarMap(value: McpValue | undefined): McpValue {
  return value ?? {}
}
