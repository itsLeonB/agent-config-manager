# Runtime, process, and module layout

Labels: wayfinder:grilling
Type: grilling
Status: resolved
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

## Answer

Settled after [the prior-art survey](./15-prior-art-engine-mcp-ui-packaging.md) made round 1 stale.
Round 1's four questions are answered below in the order they were asked, and the two the research
moved are marked.

### 1. Framework — the official SDK, stdio only, and it is not a CLI wrapper

`@modelcontextprotocol/sdk` 1.32.2, `McpServer.registerTool` for the five tools of
[ticket 09](./09-mcp-tool-surface.md), `StdioServerTransport`. Input schemas in zod; the SDK's peer
range `^3.25 || ^4.0` covers the 4.5.4 already installed. `ajv` rides in the server graph
(`validation/ajv-provider.js`) — accepted, it is not in our code path.

One caveat that touches [ticket 08](./08-permission-and-approval-model.md): **`elicitInput` is not on
`McpServer`.** It lives on the low-level `Server`, reachable as `mcpServer.server.elicitInput(...)`.
That is the single escape hatch the graded-consent gate uses; everything else stays high-level.

The `acm mcp serve` subcommand **imports** `src/engine/service.ts` and never executes the `acm` CLI.
The CLI is a sibling face over the same library. MCP-wraps-a-CLI is what a server does to a foreign
CLI: it costs a spawn per call, a `--json` contract, and a stdout channel a grandchild can corrupt —
and elicitation cannot round-trip through a child.

### 2. What a harness spawns — absolute bin path, `["mcp","serve"]`, no `cwd`

```
command: "/abs/path/to/acm"      # the bin the user installed, wherever they installed it
args:    ["mcp", "serve"]
```

No `cwd`. Round 1 assumed a pin to the repo root; the research killed it — T3 Code's stdio bridge is
exactly `execPath` + absolute entry + **no `cwd`**, because an absolute entry needs no pin and the pin
would silently change what the server resolves relative to.

The absolute path is not a deviation from "the user installs it where they like": `acm setup`
resolves whatever they installed, once, and pins it. Bare `acm` on `PATH` is rejected — a harness
spawns with a different `PATH` than the shell, which is the documented `ENOENT` failure mode for
Serena and Pi.

**Consequence:** the project root is derived from the module's own location, not `process.cwd()`
(which amends the `AGENTS.md` gotcha that `scan.cjs` and `database/` resolve from the working
directory).

### 3. Module layout

```
src/engine/service.ts                                  ← the only entry point callers use
src/engine/repo.ts                                     ← the only file that talks to store.cjs
src/engine/plan.ts                                     ← plan build, grading, preflight
src/engine/secret.ts                                   ← classifier (ticket 13 table)
src/engine/adapters/{pi,codex,opencode}/{descriptor,read,translate}.ts
src/engine/adapters/registry.ts
src/mcp/router.ts                                      ← five tools, imports service.ts only
src/cli/main.ts                                        ← subcommand dispatch, imports service.ts only
```

One enforceable rule replaces an architectural essay: **nothing under `src/mcp/` or `src/cli/` imports
`repo.ts`, `plan.ts`, or an adapter.** Flat `src/engine/*.ts` was rejected only because each adapter is
three files and [ticket 12](./12-per-category-field-tables.md) made each of those big.

### 4. Framework for the CLI, and the language

`node:util` `parseArgs` per subcommand plus zod. No CLI framework: `commander` 15 and `cac` 7 are both
zero-dependency, so this is taste, and `scan.cjs` already hand-parses. Revisit past ~10 commands.

**TypeScript, no Effect runtime.** The engine is pure transforms over data with errors modelled as
*values* — `translate()`'s discriminated union, `gaps[]`, `partial` + `landed[]` — so Effect's error
channel duplicates a decision already made, and nothing here needs concurrency, retries, resource
scopes, or interruption. `service.ts` returns plain promises and data, which is the hedge: when
BRIEF §8.4's supervised long-lived engine arrives, only `service.ts` changes shape. That is the
reversal condition, written down so it is not re-litigated on taste.

### 5. Bootstrap — `acm setup`, one time, through the plan/apply path

`acm setup --target pi,codex,opencode` builds the three writes as a plan document, prints them, and
applies on confirmation — the same plan/approve path every other mutation uses, so ACM's own install
is not a second mutation route. After that, ACM is an ordinary `mcp` component that
`list_installations` reports like any other; nothing in the engine special-cases itself.

### 6. The store gains one obligation

The MCP process, the CLI, and the dashboard's scanner all write `database/dashboard.db`. WAL and
`busy_timeout = 5000` are already set; `BEGIN IMMEDIATE` on every write transaction and the
`PRAGMA user_version` migration guard are now load-bearing rather than defensive. Appended to
[ticket 10](./10-storage-and-migration.md) as an amendment.

### 7. UI — none in this slice, `acm serve` later

The dashboard renders `readLatestSnapshot('local')` (`src/server/dashboard.server.ts:41`), a blob
written by the Claude scanner this slice excludes. So it has nothing of its own to show here, and the
slice's UI is `acm list --json` plus what the agent sees through MCP. When a UI is built it is
`acm serve` — the same binary serving the SPA and the engine API on one origin, which is what every
surveyed project with a web UI does (Serena hosts its dashboard *inside* the MCP server process, 1MCP
serves its admin SPA from the runtime, T3 Code serves static + RPC + `/mcp` from one listener) — and
it reads through `service.ts`. The direct `readLatestSnapshot` call above is the seam that moves then.

### 8. This rewrites one line of the map

The map's out-of-scope "Full CLI (BRIEF Phase 3)" needs precision: the `acm` bin **is** in the slice,
as a thin face over the same five operations the MCP tools expose. No extra surface, no Phase 3.
Recorded on the map.

**Decisions:** SDK 1.32.2 + `StdioServerTransport`, consent via `server.elicitInput` · one binary,
engine as a library, no daemon · absolute bin path + `["mcp","serve"]`, no `cwd`, project root from
the module location · the layout above with the `src/mcp|cli` import rule · `parseArgs` + zod, no CLI
framework · TypeScript, no Effect, reversal condition stated · `acm setup` reuses plan/apply ·
`BEGIN IMMEDIATE` + `user_version` amendment to ticket 10 · no UI, `acm serve` later.

[ADR 0004](../../../docs/adr/0004-one-binary-engine-as-library.md) records the packaging decision.
