# 25: MCP server over the same five operations

Type: task
**Status:** resolved

**What to build:** `acm mcp serve` speaking the protocol over standard input and output, exposing the
five settled tools with the same signatures on every client. An agent can list, inspect, plan, apply a
plan document it is carrying, and verify it again later. Tool annotations tell a client which calls
are read-only and which are destructive. Consent is requested through the client's own dialog only
when the client declared that capability; otherwise the graded-consent fallback decides. A smoke test
spawns the built binary the way a harness would.

**Blocked by:** 22.

- [x] a client that initialises and lists tools sees exactly the five settled tools, with the agreed inputs and outputs
- [x] the read-only tools declare themselves read-only and the apply tool declares itself destructive
- [x] a whole plan document round-trips from plan to apply to verify without any stored plan record
- [x] consent is requested only when the client declared the capability, and a client without it receives risky writes as manual steps
- [x] the server answers over standard input and output with no working-directory assumption
- [x] a smoke test spawns the built binary, initialises, lists tools, plans one mirror, applies it, and observes the target change

## Answer

`acm mcp serve` is `src/mcp/server.ts` (the stdio transport) over `src/mcp/router.ts` (the five
tools), reached through a dynamic import in `src/cli/main.ts` so no other subcommand waits for the
SDK. `@modelcontextprotocol/sdk` 1.32.2 is installed; `StdioClientTransport`, `McpServer.registerTool`
and the low-level `elicitInput` are used exactly as [ticket 14](14-runtime-and-process-layout.md)
settled.

Choices worth knowing beyond the ticket:

- **The consent gate is one table, shared.** `planGate(plan)` in `src/engine/apply.ts` answers the
  grade apply computes *and* which writes need a human; both `executePlan` and the service's new
  `applyPlanAsking()` call it, so the dialog and the manual-step fallback cannot drift apart.
  `CONSENT_FLAGS` (`executable`, `secretValues`, `irreversible`) is the list, and `writeFlags()` is
  also what words a manual step now.
- **`ApplyOptions.consent` is the only route past the flag gate, and only the MCP face sets it.**
  There is still no flag, environment variable, or stored approval: the CLI never passes it, and
  `applyPlan` is unchanged for every other caller.
- **`applyPlanAsking(config, rawPlan, options, ask?)` is the async wrapper.** With no `ask` it is
  `applyPlan` verbatim. `ask` is only handed over when
  `server.server.getClientCapabilities()?.elicitation !== undefined`; a `decline` or `cancel`, an
  accept whose form left any flag unticked, and an accept carrying no form content at all (which
  ticks nothing, so it consents to nothing) each answer `outcome: declined` with `consent: null` and
  nothing written — `declined` is now on `ApplyOutcome`. The dialog is one form with one boolean per
  risk flag present, and a gated write reaches it as `file`/`pointer`, never as its value.
- **Answers are one JSON text document per call.** A plan document comes back byte-for-byte as it
  arrived (the input schema is `record(json)`, not a re-serialising object schema), so the round trip
  is the same document; refusals are values in the document, not protocol errors, so an agent reads
  one shape on every tool.
- **`target` is the settled pair, `{harness, tierId}`.** A tier's own id already carries its harness
  (`codex:user`), so the router checks the pair against the tiers that harness declares and refuses a
  pair that disagrees in the planner's own `{kind: 'refused', reason}` shape; the reference handed to
  `planMirror` stays the tier id the service already resolves.
- **`fresh` is a `ListFilter` field, not router logic.** `listInstallations(config, {fresh: true})` runs
  the same `discover()` the CLI runs before answering from the store, and the tool is a pass-through —
  so the behaviour is assertable at Seam A, where `engine.test.ts` now pins the store-first default and
  the re-scan.
- **The import rule is a test.** `src/mcp/imports.test.ts` walks `src/cli` and `src/mcp` and fails when
  either imports `repo.ts`, `plan.ts`, or anything under `adapters/`, which is spec §11's "one
  enforceable import rule" rather than prose.
- **The smoke test is Seam C only.** `src/mcp/server.test.ts` spawns `process.execPath` plus the path
  `package.json`'s `bin.acm` names — the bin a harness pins, not a source file the test picked — with
  `["mcp","serve"]`, a working directory that is neither the home nor the project, and
  `ACM_HOME` / `ACM_PROJECT_ROOT` / `ACM_STORE` / `CODEX_HOME`; it asserts the five names and
  annotations, the five input schemas, the plan → apply → verify round trip against the bytes on disk,
  and both consent paths (no capability → manual step, `asked() === 0`; capability → one dialog,
  accept → `consent: elicitation`, decline → nothing written). Behaviour underneath stays asserted at
  Seam A, in `plan.test.ts` / `apply.test.ts` / `engine.test.ts`.

Not done, and why: there is no bundle to spawn yet. The `bin` is the TypeScript entry that Node 22.23
strips types for, which is what `engine.test.ts` already spawns, so the smoke test follows the `bin`
field and will follow a bundle the moment one exists (`config.ts` carries the matching `shortcut:`
note about a `dist` entry computing its own root). `verify_plan` declaring `readOnlyHint: true` is one
line beyond spec §10's table, which names the hint only for `plan_mirror` and `apply_plan`; the
checklist line asks the read-only tools to declare themselves, and this one is read-only.

