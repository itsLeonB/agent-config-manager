# One binary, the engine as a library, and MCP as one of its subcommands

ACM ships a single installed `acm` executable. `src/engine/service.ts` is the library both of its
faces import — `acm mcp serve` (stdio MCP through the official SDK) and the CLI subcommands
(`list`, `inspect`, `mirror`, `apply`, `verify`, `setup`) — and the MCP server never executes the
CLI. One SQLite file stays the store; because the MCP process and the CLI both write it, every write
transaction opens with `BEGIN IMMEDIATE` and schema migrations run under `PRAGMA user_version`.
Language is TypeScript with `node:util` `parseArgs` and zod: no Effect runtime, no CLI framework.

Every harness installed on this machine ships its engine and its MCP surface as subcommands of one
binary (`pi mcp`, `codex mcp` / `codex app-server`, `opencode serve|mcp|acp`), Serena does the same
(`serena start-mcp-server`), and nothing surveyed ships a separate MCP binary. "MCP wraps the CLI" is
what a server does to a *foreign* CLI, and it costs a spawn per tool call, a `--json` contract, and a
stdout channel a grandchild can corrupt.

## Considered Options

- **One binary; both faces import `service.ts`** (chosen).
- **A separate MCP binary or package.** A second artifact and a second version to keep in step, with
  no boundary gained that an import rule does not already give.
- **MCP execs the CLI per tool call.** A child inheriting stdout corrupts the JSON-RPC framing (one
  channel, no separation), every call pays a process launch, elicitation cannot round-trip back
  through a child, and the CLI grows a `--json` contract it has no other use for.
- **Long-lived runtime with HTTP `/mcp`** (T3 Code's shape, surveyed in ticket 15). Buys a single
  writer, and costs a supervisor plus a "the server is not running" failure mode in every harness.
  All three in-slice harnesses accept a `command` entry, so the HTTP path buys nothing here.
- **Effect runtime for the engine.** Rejected for this slice — see consequences for the reversal
  condition.
- **A CLI framework** (`commander` 15, `cac` 7 — both zero-dependency) **instead of `parseArgs`.** A
  taste call: seven subcommands and `scan.cjs` already hand-parses, so `parseArgs` + zod is fewer
  moving parts. Revisit past ~10 commands or when per-command `--help` output is worth a dependency.

## Consequences

- **Build.** A `bin` field plus shebang, bundled by `bun build src/cli/main.ts --target=node
  --outfile=dist/acm.mjs`. Runs on Node ≥ 22.5 (`node:sqlite` arrived there) and on Bun in dev.
- **Spawn.** A harness entry is the absolute path to the installed bin plus `["mcp", "serve"]`,
  resolved once at `acm setup` and pinned. No `cwd`: an absolute entry needs no pin, and pinning it
  would silently change what the server resolves relative to. The **store** therefore comes from the
  module's own location, not `process.cwd()` — the store, `scan.cjs`, and `database/` are resolved
  from the install root. The **project root** does not: it is the working directory the harness or
  shell opened `acm` in, amended by [ADR 0006](0006-project-root-is-the-working-directory.md).
- **Store.** `BEGIN IMMEDIATE` on writes and the `user_version` guard are load-bearing, not
  defensive; WAL and `busy_timeout` were already there (amends ADR 0003). Ticket 15 records an
  unverified claim that `node:sqlite` needs Node ≥ 24.15 for a *sleeping* busy timeout — verify
  before relying on the timeout, not on the pragma itself.
- **UI.** None in this slice. When it exists it is `acm serve`: the same process serving the SPA and
  the engine API on one origin, reading through `service.ts` and never through `store.cjs` directly.
- **Effect.** Rejected because the engine is pure transforms over data — `translate()` returning a
  union of facts, plan building, a classifier table — with errors modelled as values, no concurrency,
  no retries, no resource scopes, and a startup path an agent waits on. Reversal condition: a
  long-lived engine process with supervision (BRIEF §8.4). Then Effect earns its keep, and by
  ADR 0003's boundary only `service.ts` changes shape.
- **Self-install.** `acm setup` writes plan-document-shaped writes and applies them through the same
  plan/approve path, so installing ACM into a harness is not a second mutation route.
