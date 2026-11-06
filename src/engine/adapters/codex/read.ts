import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import type { McpEntry, McpFacts } from '../mcp-facts.ts'
import type { ParsedEntries } from '../tier.ts'

// Codex keeps MCP servers in `[mcp_servers.<id>]` tables. `oauth` (whose `client_secret` lives in
// this file) and `http_headers_helper` (a command) are deliberately unnamed: an unnamed field never
// becomes a fact, so a credential or an executable is never read, stored, or mirrored.
// shortcut: only the fields the canonical vocabulary carries are typed; `startup_readiness`,
// `enabled_tools`, `scopes` and friends stay in the native file until a ticket needs them.
const entrySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  env_vars: z.array(z.string()).optional(),
  url: z.string().optional(),
  http_headers: z.record(z.string(), z.string()).optional(),
  bearer_token_env_var: z.string().optional(),
  enabled: z.boolean().optional(),
  startup_timeout_sec: z.number().optional(),
  tool_timeout_sec: z.number().optional(),
  default_tools_approval_mode: z.string().optional(),
  disabled_tools: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  supports_parallel_tool_calls: z.boolean().optional(),
})

const fileSchema = z.object({
  mcp_servers: z.record(z.string(), entrySchema).optional(),
})

export function readCodexMcpToml(text: string): ParsedEntries<McpEntry> {
  let raw: unknown
  try {
    raw = parseToml(text)
  } catch {
    // The parser's message quotes the offending source lines, which can include a credential
    // sitting next to a syntax error. The tier is unreadable either way, and the caller adds the
    // file path.
    return { kind: 'invalid', detail: 'config.toml is not valid TOML' }
  }
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) {
    return { kind: 'invalid', detail: parsed.error.issues[0]?.message ?? 'invalid config.toml' }
  }
  return {
    kind: 'ok',
    entries: Object.entries(parsed.data.mcp_servers ?? {}).map(([name, entry]) => ({
      name,
      facts: toFacts(entry),
      pointerPrefix: 'mcp_servers',
    })),
  }
}

// Codex has no `transport` key; like Pi it is inferred from which address field is present.
function toFacts(entry: z.infer<typeof entrySchema>): McpFacts {
  const transport = entry.url !== undefined ? 'http' : entry.command !== undefined ? 'stdio' : undefined
  return {
    transport,
    command: entry.command,
    args: entry.args,
    cwd: entry.cwd,
    env: entry.env,
    envPassthrough: entry.env_vars,
    url: entry.url,
    headers: entry.http_headers,
    enabled: entry.enabled,
    timeoutStartup: entry.startup_timeout_sec,
    timeoutRequest: entry.tool_timeout_sec,
    bearerTokenEnvVar: entry.bearer_token_env_var,
    approvalMode: entry.default_tools_approval_mode,
    disabledTools: entry.disabled_tools,
    required: entry.required,
    supportsParallelToolCalls: entry.supports_parallel_tool_calls,
  }
}
