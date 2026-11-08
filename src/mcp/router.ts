import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { EngineConfig } from '../engine/config.ts'
import {
  applyPlanAsking,
  inspectInstallation,
  listInstallations,
  planMirror,
  verifyPlanDocument,
  type ConsentAnswer,
  type ConsentFlag,
  type ConsentRequest,
} from '../engine/service.ts'

// A plan is JSON and nothing else: the document is validated by the service, which refuses one that
// does not hash to its own planId.
const planDocument = z.record(z.string(), z.json()).describe('a plan document, exactly as plan_mirror returned it')

// A tool answers with one JSON document, so an agent carries back what it received: a plan is a
// document, and a refusal is a value the agent reads, not a protocol error.
function answer(document: string) {
  return { content: [{ type: 'text' as const, text: document }] }
}

// One readable tick per risk flag the plan carries, so the dialog says what is being agreed to
// rather than "allow this?".
const RISK_TICKS = {
  executable: 'Run the command this component declares at harness runtime',
  secretValues: 'Write the credential values this component carries',
  irreversible: 'Write what cannot be undone',
} satisfies Record<ConsentFlag, string>

function messageFor(request: ConsentRequest): string {
  const writes = request.writes
    .map((write) => `${write.address ?? 'the whole file'} (${write.flags.join(', ')})`)
    .join('; ')
  return `Apply ${request.planId.slice(0, 15)} into ${request.target}? It writes ${writes}.`
}

function ticksFor(request: ConsentRequest): Partial<Record<ConsentFlag, string>> {
  const flags = new Set(request.writes.flatMap((write) => write.flags))
  return Object.fromEntries([...flags].map((flag) => [flag, RISK_TICKS[flag] ?? flag]))
}

// The dialog belongs to the client, and one unticked flag is a no: the engine reads nothing but
// the answer.
async function askHuman(server: McpServer, request: ConsentRequest): Promise<ConsentAnswer> {
  const ticks = ticksFor(request)
  const result = await server.server.elicitInput({
    message: messageFor(request),
    requestedSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(ticks).map(([flag, title]) => [flag, { type: 'boolean' as const, title }]),
      ),
      required: Object.keys(ticks),
    },
  })
  const ticked = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
  const accepted = ticked.safeParse(result.content ?? {})
  // Every flag is asked for by name, so an accept carrying no form content has ticked nothing.
  const tickedAll =
    accepted.success && Object.keys(ticks).every((flag) => accepted.data[flag] === true)
  return result.action === 'accept' && tickedAll ? 'accept' : 'decline'
}

// The five tools of the settled surface, each one a thin call into the service. `elicitInput` is
// declared on the low-level server only, and it is sent only when the client said it can render it.
export function createRouter(config: EngineConfig): McpServer {
  const server = new McpServer({ name: 'agent-config-manager', version: '0.1.0' })

  server.registerTool(
    'list_installations',
    {
      description:
        'List the installations the last scan stored, with the harnesses and tiers a mirror could target. Read-only.',
      inputSchema: {
        category: z.string().optional(),
        harness: z.string().optional(),
        scope: z.string().optional(),
        fresh: z.boolean().optional().describe('re-scan the native configs before answering'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ category, harness, scope, fresh }) =>
      answer(JSON.stringify(listInstallations(config, { category, harness, scope, fresh }), null, 2)),
  )

  server.registerTool(
    'inspect_installation',
    {
      description: 'Read one installation as stored: secret-free known fields, native location, digests, bindings. Read-only.',
      inputSchema: { installationId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ installationId }) => answer(JSON.stringify(inspectInstallation(config, installationId), null, 2)),
  )

  server.registerTool(
    'plan_mirror',
    {
      description:
        'Build the plan document for moving one installation into a target tier. Writes nothing: carry the document back to apply_plan. Read-only.',
      inputSchema: {
        installationId: z.string().min(1),
        target: z.object({ harness: z.string().min(1), tierId: z.string().min(1) }),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ installationId, target }) => {
      // A tier's own id already carries its harness, so the pair is checked against the tiers that
      // harness declares rather than joined back into a reference: a pair that disagrees names no
      // tier, and a refusal is the same document shape as the planner's own.
      const tiers = listInstallations(config, { harness: target.harness }).harnesses.flatMap(
        (summary) => summary.tiers,
      )
      if (!tiers.some((tier) => tier.id === target.tierId)) {
        return answer(
          JSON.stringify(
            { kind: 'refused', reason: `${target.tierId} is not a tier of ${target.harness}` },
            null,
            2,
          ),
        )
      }
      return answer(JSON.stringify(planMirror(config, installationId, target.tierId), null, 2))
    },
  )

  server.registerTool(
    'apply_plan',
    {
      description:
        'Execute a plan document exactly as given and record what landed. Writes the target harness config.',
      inputSchema: { plan: planDocument, onConflict: z.enum(['abort', 'replace']).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ plan, onConflict }) => {
      const askable = server.server.getClientCapabilities()?.elicitation !== undefined
      return answer(
        JSON.stringify(
          await applyPlanAsking(
            config,
            plan,
            { onConflict },
            askable ? (request) => askHuman(server, request) : undefined,
          ),
          null,
          2,
        ),
      )
    },
  )

  server.registerTool(
    'verify_plan',
    {
      description: "Re-read the target and assert a plan's expectations, after apply or after a manual step. Read-only.",
      inputSchema: { plan: planDocument },
      annotations: { readOnlyHint: true },
    },
    // SAFETY: likewise, a document that is not a plan is refused before a file is read.
    async ({ plan }) => answer(JSON.stringify(verifyPlanDocument(config, plan), null, 2)),
  )

  return server
}
