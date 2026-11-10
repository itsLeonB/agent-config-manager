import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  ENVIRONMENT_TIERS,
  HARNESSES,
  defineProvision,
  readNativeConfig,
  readStatus,
  statusDocument,
} from '../environ/service.ts'
import type { DefineOutcome } from '../environ/service.ts'

// The MCP face is a thin call into the environment service: it registers tools and formats their
// answers, and holds no reading logic of its own. No tool runs a command and no tool runs a Check
// that could, because a Check cannot spawn.
function answer(document: string) {
  return { content: [{ type: 'text' as const, text: document }] }
}

// A refused definition is a failure the caller fixes, not an answer: the reason is the parser's own,
// so it names the fault the next read would report anyway.
function refused(outcome: Exclude<DefineOutcome, { kind: 'defined' }>) {
  const text =
    outcome.kind === 'refused'
      ? `${outcome.refusal.line}:${outcome.refusal.column}: ${outcome.refusal.reason}`
      : outcome.reason
  return { content: [{ type: 'text' as const, text: `not defined: ${text}` }], isError: true }
}

// The six predicates and the three Install forms, as the tool's own schema: a client reading
// tools/list sees every shape the environment file spells, each described with what it answers.
// The members pass unknown keys through rather than stripping them, so a definition the shapes do
// not forbid — two predicates in one Check, an unknown key — reaches the parser and comes back
// refused with the reason the loader would give, never silently rewritten into a different Check.
const CHECK_FILE = z
  .string()
  .describe('the file to read: ~ and / are absolute, anything else resolves against the tier\'s root')

const CHECK = z.union([
  z
    .record(z.string(), z.json())
    .and(z.object({ file: CHECK_FILE }))
    .describe('answers whether the file exists'),
  z
    .record(z.string(), z.json())
    .and(
      z.object({
        file: CHECK_FILE,
        contains: z.string().describe('the pattern the file\'s text has to match'),
      }),
    )
    .describe('answers whether the file\'s text matches the contains pattern'),
  z
    .record(z.string(), z.json())
    .and(
      z.object({
        file: CHECK_FILE,
        pointer: z.string().describe('the address inside the file: a JSON pointer and a TOML dotted key are spelled the same'),
        equals: z.json().optional().describe('the value the address has to hold'),
      }),
    )
    .describe('answers whether the value at the pointer equals the value given, or that a value sits there when equals is omitted'),
  z
    .record(z.string(), z.json())
    .and(
      z.object({
        file: CHECK_FILE,
        pointer: z.string().describe('the address inside the file: a JSON pointer and a TOML dotted key are spelled the same'),
        includes: z.json().describe('the value the array at the address has to hold'),
      }),
    )
    .describe('answers whether the array at the pointer includes the value'),
  z
    .record(z.string(), z.json())
    .and(
      z.object({
        file: CHECK_FILE,
        section: z.string().describe('the Payload whose Section the file has to hold'),
      }),
    )
    .describe('answers whether the Section of the file holds the Payload\'s text'),
  z
    .record(z.string(), z.json())
    .and(z.object({ onPath: z.string().describe('the executable name to look up on PATH') }))
    .describe('answers whether the name is an executable file on PATH'),
])

const INSTALL = z.union([
  z.string().describe('the Install command text, the only text ACM ever executes'),
  z
    .record(z.string(), z.json())
    .and(
      z.object({
        payload: z.string().describe('the Payload\'s path, resolved like a Check path'),
        args: z.array(z.string()).optional().describe('the arguments the Payload receives as argv'),
      }),
    )
    .describe('a Payload: the file the command text lives in, resolved like a Check path, with the arguments that reach it as argv'),
  z
    .record(z.string(), z.json())
    .and(
      z.object({
        file: z.string().describe('the native file whose Section is rewritten'),
        section: z.string().describe('the Payload whose text rewrites the Section'),
      }),
    )
    .describe('a Section write: the Payload rewrites one Section of the native file'),
])

// The tools land here one at a time as the tickets that own them arrive; declaring the capability in
// the constructor is what makes `tools/list` answer with whatever is registered rather than "method
// not found".
export function createRouter(): McpServer {
  const server = new McpServer(
    { name: 'agent-config-manager', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.registerTool(
    'list_provisions',
    {
      description:
        'List every Provision the environment files declare, with the Presence (present, absent, or unknown) of each harness entry and a detail when a Check could not answer. Read-only.',
      inputSchema: {
        harness: z.enum(HARNESSES).optional().describe('only the entries declared for this harness'),
        name: z.string().min(1).optional().describe('only the Provision with this name'),
        tier: z.enum(ENVIRONMENT_TIERS).optional().describe('only the entries this tier owns'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ harness, name, tier }) =>
      answer(JSON.stringify(statusDocument(readStatus({ harness, name, tier })), null, 2)),
  )

  server.registerTool(
    'read_native_config',
    {
      description:
        'Read what one harness declares at the native paths it loads, secret-free: every declared path at the tier with whether it could be read, and each declaration with its file and the address inside it, or the file that did not parse. A credentialed value comes back as its verdict marker. Nothing is stored. Read-only.',
      inputSchema: {
        harness: z.enum(HARNESSES).describe('the harness whose native configuration to read'),
        tier: z
          .string()
          .min(1)
          .optional()
          .describe('one declared tier id, such as codex:user; every tier the harness declares when omitted'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ harness, tier }) => answer(JSON.stringify(readNativeConfig(harness, tier), null, 2)),
  )

  server.registerTool(
    'define_provision',
    {
      description:
        'Define one Provision\'s Check and Install command for one harness, written as [provision.<name>.<harness>] in the environment file of the chosen tier. Comments and sibling Provisions survive; a same-key write replaces only that entry\'s check and install. The default tier is project-local, which git ignores. Never runs the Install command and never evaluates the Check: the only effect is the file. Answers the pointer written and the file\'s digest, or the reason the loader would refuse the result.',
      inputSchema: {
        name: z.string().min(1).describe('the Provision name, such as serena'),
        // Deliberately not an enum: the file's own validator names an unknown harness, and that is
        // the reason the caller should read.
        harness: z.string().min(1).describe('the harness the entry is for: pi, codex, or opencode'),
        tier: z
          .enum(ENVIRONMENT_TIERS)
          .optional()
          .describe('which environment file to write: user, project, or project-local (the default)'),
        check: CHECK.optional().describe(
          'one Check, the singular spelling the file writes as check = { \u2026 }',
        ),
        checks: z.array(CHECK).optional().describe('several Checks, written checks = [ \u2026 ]; every one of them has to hold'),
        install: INSTALL.describe('required, and never run by the tool'),
        tags: z.array(z.string()).optional().describe('tags for the Provision, written when it has none'),
      },
      annotations: { readOnlyHint: false },
    },
    async (request) => {
      const outcome = defineProvision(request)
      return outcome.kind === 'defined' ? answer(JSON.stringify(outcome, null, 2)) : refused(outcome)
    },
  )

  return server
}
