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
for a declared environment of Provisions. [README.md](README.md) covers what it does and how to run
it. Configuration on claude.ai is deliberately out of scope; see
[docs/adr/0002](docs/adr/0002-no-cloud-config-management.md).

Bun is the package manager and script runner (`bun install`, `bun run <script>`, `bunx`); npm and
npx are not used here.

## Environment tickets

Implementing a ticket under `.scratch/agents-environ/` starts at that ticket file: follow its
`Blocked by:` line, and read [`spec.md`](.scratch/agents-environ/spec.md) beside it for the settled
decisions.

- The spec is the authority, and a ticket's checklist is its definition of done.
- [`CONTEXT.md`](CONTEXT.md) holds the vocabulary the spec, tickets, and code share; a word that is
  not there is a smell. [ADR 0007](docs/adr/0007-declare-provisions-and-delete-the-mirror-engine.md)
  retires the previous model's words: nothing in code, tool output, or docs names a Component,
  Installation, Binding, Capability, Gap, Mirror, Plan, Grade, or scope bucket.
- A resolved ticket's `## Answer` is settled — build on it instead of re-deriving it.
- `docs/research/{pi,codex,opencode}-config-surface.md` are the verified native surfaces for each
  harness — config paths and precedence, formats, merge semantics, which gates are human-only. Read
  the harness's file before changing its adapter.

## Architecture

- **`src/server/store.cjs` is the only module that touches `node:sqlite`.** It stays plain
  CJS so the TypeScript app can load it and `scan.cjs` can require it, and it holds
  everything the app persists: scan snapshots, the `config` rows behind `/settings`, and the `runs`
  history of Install commands.
  `PRAGMA user_version` gates an ordered migration list run on every
  open, so a fresh database and an existing one reach the same schema; migration 1 is pure
  `CREATE TABLE IF NOT EXISTS` next to `snapshots` / `config`, which therefore keep their rows,
  migration 2 drops the previous engine's inventory tables in four `DROP TABLE IF EXISTS`
  statements, and migration 3 adds `runs` without naming either dashboard table. Every write opens
  with `BEGIN IMMEDIATE`, because the CLI, the MCP server, and the scanner all open the file.
- **The engine is a library of readers, and the environment is what runs on it.**
  `src/engine/config.ts` resolves the roots an adapter never reads itself (home, project root,
  store path, `CODEX_HOME`); `src/engine/adapters/` holds one directory per harness (Pi, Codex,
  OpenCode) plus the shared readers: MCP fact classification in `mcp-facts.ts`, skills in
  `skills.ts`, instructions in `instructions.ts`, hooks in `hooks.ts` (the three harnesses differ
  only in which locations they declare), per-tier file reading in `tier.ts`, and
  `src/engine/adapters/registry.ts`, which fails at load when a claimed category has no handler. The
  one path table lives in `native-paths.ts`: `nativeTiers(config, harness)` and
  `nativeTier(config, harness, tierId)` answer where a harness reads at a tier, and the three
  adapters take their `tiers` from there rather than declaring their own. A
  `Tier` in `types.ts` is a read location and nothing else. `src/engine/edit.ts` is the
  pointer-level native editor — a write lands only on the address it names, and comments and
  sibling entries survive — `src/engine/secret.ts` is the credential classifier every reader runs
  before a value can reach a result, and `src/engine/digest.ts` is what makes two copies of one
  tree comparable. `ACM_HOME` / `ACM_PROJECT_ROOT` / `ACM_STORE` / `CODEX_HOME` are the boundary
  overrides a test uses to point the engine at a fixture. `src/cli/main.ts` is the `acm` source
  entry; `bun run build:acm` bundles it to the single ESM file `dist/acm.mjs` that the package's
  `bin` declares, with a Node shebang. Two paths, two rules: the **store** is derived from the
  nearest `package.json` above whichever of the two it is running from — where `acm` is installed,
  shared by every project — while the **project root** is the working directory the harness or
  shell opened `acm` in (or `ACM_PROJECT_ROOT` / `CLAUDE_PROJECT_DIR`, canonicalised, never walked
  up), so one installed `acm` reads whatever repository it was started in. `src/environ/` holds the
  declared environment: `types.ts` is its vocabulary — the closed Tier and Presence lists, the six
  Check predicates, the rows, and one Run — `parse.ts` validates one environment file totally against
  a closed schema and refuses the whole file with a line and column, `check.ts` evaluates a Check over
  the bytes it names (a Check reads and never spawns; an unreadable file answers `unknown`, never
  `absent`), `section.ts` is the one place that decides where a Section starts and ends — the Check
  that compares one and the install that rewrites one both ask it — `loader.ts` is the only module
  that knows where a tier's file lives and what its root is
  — `~/agents_environ.toml` and the committed `<project>/agents_environ.toml`, merged per `(provision, harness)` so the nearer file replaces
  the farther one whole — `tags` included — `runner.ts` is the Provision install run, the only
  place a Provision's Install command is spawned and the only place a Run is recorded,
  `skills.ts` is the skills installer — a CLI-only converge over the two skills lockfiles that
  spawns `npx` once per source group and records nothing — `history.ts` is the environment's one
  caller of the store, `native-read.ts` is a Native read over the three harness readers,
  `define.ts` is `define_provision` writing one entry through the pointer editor and `declare.ts`
  `declare_harnesses` writing one tier's harness list, `print.ts` is how a value from a file
  reaches a printed line, and `service.ts` is everything a face may call — the rows, one Presence per harness, the
  printing, the JSON, and the re-exports a face asks for. `src/mcp/router.ts` is the MCP face
  and `src/mcp/server.ts` puts it on a stdio transport behind `acm mcp serve`; the router registers
  `list_provisions`, `read_native_config`, and `define_provision`, which answer from that service, and
  neither face imports an adapter, a store module, or a loader internal. Nothing under `src/routes/` or
  `src/components/` imports either.
- **The Claude dashboard is the previous product, kept working unchanged.** It reads the same store;
  its rendering, rescan, settings, scanner, and container notes are in
  [docs/dashboard.md](docs/dashboard.md). Read that before touching `src/routes/`,
  `src/components/`, `scan.cjs`, or `tools/`.

## Gotchas

- `bun run check` runs lint, typecheck, and the test suite under `bun test`, which `bun run test`
  wraps with `bun run build:acm`: the MCP smoke test spawns the built bundle the package `bin`
  declares, so a bare `bun test` in a clean checkout fails until that file exists.
  `.githooks/pre-commit` runs `check`, `bun install` points `core.hooksPath` there, and
  `.github/workflows/check.yml` runs the same command on pushes and pull requests to `main`. A
  manual `git commit --no-verify` skips the local hook, so a green `bun run check` is still the
  thing to report.

- `database/` is gitignored and holds `dashboard.db` — the only store. Deleting it drops the
  dashboard's saved settings and scan history; a rescan rebuilds the snapshot, and a settings save
  rewrites the `config` rows.

## Agent skills

Issue tracker: local markdown under `.scratch/<feature-slug>/` — `docs/agents/issue-tracker.md`.
Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` —
`docs/agents/triage-labels.md`. Domain docs: root `CONTEXT.md` + `docs/adr/`, created lazily by
`/domain-modeling` — `docs/agents/domain.md`.
