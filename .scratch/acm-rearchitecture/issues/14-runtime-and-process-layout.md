# Runtime, process, and module layout

Labels: wayfinder:grilling
Type: grilling
Status: open
Blocked by: 15

## Question

The map settles components and contracts but never says what a moving part **is**. Ticket 10 puts
the boundary at `src/engine/service.ts` and stops — "the MCP server imports `service.ts` and nothing
below it" — without naming that server's file, transport, runtime, or how a harness comes to spawn
it. Decide those, because a spec cannot invent them.

1. **MCP server framework.** Official `@modelcontextprotocol/sdk` (1.32.2; ships `zod`, `ajv`,
   `express`/`hono` for transports this slice will not use) over `StdioServerTransport`, or a
   hand-rolled newline-delimited JSON-RPC server. Ticket 08 §3 grades consent on **elicitation**,
   so whatever is chosen must expose `elicitInput` and capability negotiation correctly.
2. **What a harness spawns.** Each of Pi, Codex, and OpenCode needs an absolute command plus args in
   its own `mcp` config. Candidates: `node <repo>/dist/mcp/server.mjs`, `<repo>/node_modules/.bin/…`,
   or `process.execPath` embedded at install time. Container and dev host differ (Node in the
   container, Bun under `bun run dev`), so this is the same `process.execPath` question ticket 10's
   rescan already answered.
3. **Module layout.** Where the adapter registry, gap policy, secret classifier, and plan engine
   live; one file or one directory per harness adapter; where the MCP entry point sits relative to
   `src/engine/`.
4. **Bootstrap.** ACM installs itself into each harness as an `mcp` component, which is the `mcp`
   category mirroring itself. The first install cannot be a mirror of a mirror, so say exactly what
   the human does once, and what the engine does after that.

Not in scope: the UI framework. The dashboard stays as-is and is out of scope on the map, so the
existing TanStack Start + React 19 stack is inherited, not chosen.

**Zoom:** [Storage and migration](./10-storage-and-migration.md) §6, [Minimal MCP tool surface](./09-mcp-tool-surface.md),
[Permission, approval, and safety model](./08-permission-and-approval-model.md) §3, `AGENTS.md`
(Bun only; `process.execPath`; container runs `tools/entrypoint.mjs`).

**Output:** the runtime and layout section of the handoff spec, plus whatever ADR the framework
choice earns.

**Blocked by [Prior art](./15-prior-art-engine-mcp-ui-packaging.md)** — round 1 was asked and left
unanswered on purpose: the packaging questions (who hosts the engine, whether the UI stays a web
dashboard, how a harness finds the entry) are cheaper to answer from what other projects already
did. Re-ask the round once the findings land.
