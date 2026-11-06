<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `bunx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# agent-config-manager

Inventories a Claude Code setup — plugins, MCP servers, skills, environment tools, project scope —
on the local machine, and is becoming an engine that reads Pi, Codex, and OpenCode config natively
so one harness's configuration can be mirrored into another. [README.md](README.md) covers what it
does and how to run it. Configuration on claude.ai is deliberately out of scope; see
[docs/adr/0002](docs/adr/0002-no-cloud-config-management.md).

Bun is the package manager and script runner (`bun install`, `bun run <script>`, `bunx`); npm and
npx are not used here.

## Engine tickets

Implementing a ticket under `.scratch/acm-rearchitecture/` starts at that ticket file: follow its
`Blocked by:` line, and read [`spec.md`](.scratch/acm-rearchitecture/spec.md) beside it for the
settled decisions.

- The spec is the authority. [`map.md`](.scratch/acm-rearchitecture/map.md) indexes each settled
  decision by ticket: read it when the reasoning behind one of them matters.
- [`CONTEXT.md`](CONTEXT.md) holds the vocabulary the spec, tickets, and code share; a word that is
  not there is a smell.
- A resolved ticket's `## Answer` is settled — build on it instead of re-deriving it.
- `docs/research/{pi,codex,opencode}-config-surface.md` are the verified native surfaces for each
  harness — config paths and precedence, formats, merge semantics, which gates are human-only. Read
  the harness's file before changing its adapter or writing a mirror step for it. The canonical
  field tables, the seven transforms, and the per-tier allowlists are in
  [docs/mcp-field-tables.md](docs/mcp-field-tables.md), beside the planner data that mirrors them.

## Architecture

- **`src/server/store.cjs` is the only module that touches `node:sqlite`.** It stays plain
  CJS so the TypeScript app can load it and `scan.cjs` can require it, and it holds
  everything the app persists: scan snapshots, the `config` rows behind `/settings`, the engine's
  canonical tables, and the operations an apply records — one transaction per apply, so the audit
  row, the target's plan hash, and its binding's verification status land together or not at all.
  `PRAGMA user_version` gates an ordered migration list run on every
  open, so a fresh database and an existing one reach the same schema; migration 1 is pure
  `CREATE TABLE IF NOT EXISTS` next to `snapshots` / `config`, which therefore keep their rows.
  Every write transaction opens with `BEGIN IMMEDIATE`, because the CLI, the MCP server, and the
  scanner all open the file.
- **The engine and the CLI are a second face over that store.** `src/engine/service.ts` exposes
  `discover()`, `listInstallations()`, `inspectInstallation()`, `planMirror()`, and
  `applyPlan()` / `verifyPlan()`; `src/engine/repo.ts` is the only module that calls `store.cjs`;
  `src/engine/plan.ts` builds the mirror plan document from a stored row and the target file alone
  (it writes nothing); `src/engine/apply.ts` executes exactly that document — one lock per store,
  every precondition read before the first byte, one file at a time, `partial` with no rollback
  when a write fails — and re-reads the target to verify it; `src/engine/edit.ts` is the
  pointer-level native editor, so a write lands only on the addresses the plan named and comments
  and sibling entries survive — the one exception being a write that names a whole container
  (OpenCode's `mcp` block, normalised out of its legacy flat shape), which replaces that node and
  drops the comments inside it, which the plan says as a manual step; `src/engine/adapters/`
  holds one directory per harness (Pi, Codex, OpenCode), shared
  MCP fact storage in `mcp-facts.ts`, the per-harness MCP write surfaces and transforms in
  `mcp-write.ts`, and per-tier file reading in `tier.ts`; and
  `src/engine/adapters/registry.ts` fails at load when a claimed category has no handler. Roots
  (home, project root, store path, `CODEX_HOME`) arrive as an injected `EngineConfig`, never read
  from the working directory; `ACM_HOME` / `ACM_PROJECT_ROOT` / `ACM_STORE` are the boundary
  overrides a test uses to point the engine at a fixture. `src/cli/main.ts` is the `acm` bin
  (`bun run acm -- list`, or `acm list` once linked), and it is a face over `service.ts`, exactly
  as the MCP server will be. Nothing under `src/routes/` or `src/components/` imports it.
- **The Claude dashboard is the previous product, kept working unchanged.** It reads the same store;
  its rendering, rescan, settings, scanner, and container notes are in
  [docs/dashboard.md](docs/dashboard.md). Read that before touching `src/routes/`,
  `src/components/`, `scan.cjs`, or `tools/`.

## Gotchas

- `bun run check` runs lint, typecheck, and the test suite under `bun test`; `.githooks/pre-commit`
  runs it, `bun install` points `core.hooksPath` there, and `.github/workflows/check.yml` runs the
  same command on pushes and pull requests to `main`. A manual `git commit --no-verify` skips the
  local hook, so a green `bun run check` is still the thing to report.

- `database/` is gitignored and holds `dashboard.db` — the only store. Deleting it drops the
  engine's inventory too, which `acm list` rebuilds from the native configs on its next run.

## Agent skills

Issue tracker: local markdown under `.scratch/<feature-slug>/` — `docs/agents/issue-tracker.md`.
Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` —
`docs/agents/triage-labels.md`. Domain docs: root `CONTEXT.md` + `docs/adr/`, created lazily by
`/domain-modeling` — `docs/agents/domain.md`.
