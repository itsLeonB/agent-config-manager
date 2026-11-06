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

Dashboard that inventories a Claude Code setup — plugins, MCP servers, skills,
environment tools, project scope — on the local machine.
[README.md](README.md) covers what it does and how to run it. Configuration on
claude.ai is deliberately out of scope; see
[docs/adr/0002](docs/adr/0002-no-cloud-config-management.md).

Bun is the package manager and script runner. Never `npm` / `npx` for this repo.

## Architecture

- **Rendering is TanStack Start** — React 19 + TypeScript, file-based routing
  under `src/routes/`. The previous version was a static `index.html` + `app.js`
  using hand-written DOM string templates; the React structure deliberately
  mirrors that page's modularity (one component per original render function in
  `src/components/dashboard/`, composed by `Dashboard.tsx`) rather than
  inventing new structure.
- **Data loading is server-only.** `src/server/dashboard.server.ts` reads the newest
  stored scan snapshot through `src/server/store.cjs`. The helper
  wraps all this in a `createServerFn`; the index route's `loader` calls that. Loaders are
  isomorphic (they also run on the client), so filesystem access belongs behind
  `createServerFn`, and a loader must not self-fetch a relative URL during SSR.
- **`src/server/store.cjs` is the only module that touches `node:sqlite`.** It stays plain
  CJS so the TypeScript app can load it and `scan.cjs` can require it, and it holds
  everything the app persists: scan snapshots, the `config` rows behind `/settings`, and the
  engine's canonical tables. `PRAGMA user_version` gates an ordered migration list run on every
  open, so a fresh database and an existing one reach the same schema; migration 1 is pure
  `CREATE TABLE IF NOT EXISTS` next to `snapshots` / `config`, which therefore keep their rows.
  Every write transaction opens with `BEGIN IMMEDIATE`, because the CLI, the MCP server, and the
  scanner all open the file.
- **The engine and the CLI are a second face over that store.** `src/engine/service.ts` exposes
  `discover()` and `listInstallations()`; `src/engine/repo.ts` is the only module that calls
  `store.cjs`; `src/engine/adapters/` holds one directory per harness (Pi only so far) and
  `src/engine/adapters/registry.ts` fails at load when a claimed category has no handler. Roots
  (home, project root, store path) arrive as an injected `EngineConfig`, never read from the
  working directory; `ACM_HOME` / `ACM_PROJECT_ROOT` / `ACM_STORE` are the boundary overrides a
  test uses to point the engine at a fixture. `src/cli/main.ts` is the `acm` bin
  (`bun run acm -- list`, or `acm list` once linked), and it is a face over `service.ts`, exactly
  as the MCP server will be. Nothing under `src/routes/` or `src/components/` imports it.
- **`src/types/dashboard.ts`** hand-mirrors the JSON shapes `scan.cjs` emits —
  kept in sync by hand, not derived from it. `mcpJson` / `pluginInstalls` need
  the recursive `Json` type because a server function's return type must be
  provably serializable, so `unknown` will not do.
- **Rescan is a POST server function** (`rescan` in
  `src/server/dashboard.functions.ts`). It spawns `scan.cjs` with
  `process.execPath` — Bun under `bun run dev`, Node in the container — so one
  code path covers both, awaits exit, and returns the new counts; the button
  then invalidates the route loader so the page re-renders with no reload. A
  failed scan returns `ok: false` and is never invalidated, so the previous
  snapshot stays on screen. Concurrent callers join the in-flight scan instead
  of starting a second scanner.
- **Mutating server functions check the request origin**
  (`src/server/origin-guard.ts`, unit-tested in `origin-guard.test.ts`), because
  the scanner runs the configured env tool check commands as shell commands.
  TanStack's default CSRF middleware also runs; the explicit guard is
  deliberate and does not lean on framework defaults. Its allowlist is only
  `new URL(request.url).origin` plus `PUBLIC_ORIGIN`, never `x-forwarded-*`: a foreign page
  can send its own `Origin` with matching forwarded headers, so those headers cannot
  whitelist anything.
- **Settings live in the store's `config` table.** `src/routes/settings.tsx` renders
  `src/components/settings/SettingsForm.tsx`; the values are read and written by
  `src/server/settings.server.ts` behind the POST server function in
  `src/server/settings.functions.ts`. `src/lib/settings.ts` holds the zod schemas the server
  validates with and the draft/validate helpers the form runs on blur, so both sides agree.
  The scanner re-reads the keys at the start of every tick, so a save needs no restart; the
  defaults are mirrored in `scan.cjs`'s `resolveConfig` (marked `shortcut:`).
- **`scan.cjs` / `scan.test.cjs`** is an offline CLI data generator, not part of
  the app. It stays `.cjs` because `package.json` sets `"type": "module"` and
  the script uses `require()`.
- **The container runs `tools/entrypoint.mjs`**, which points `HOME` at `HOST_HOME`, starts
  `scan.cjs --loop`, and stops so the container restarts if that loop exits — a dead scanner
  would otherwise serve silently stale data. It then imports `tools/serve.mjs`, which serves
  `dist/client` and `dist/server` through `srvx` on `PORT` / `HOST`.
- **Tailwind v4 is wired but unused.** The dashboard keeps its original
  hand-written CSS (dark/light via `prefers-color-scheme`, no toggle) for
  pixel-identical UX. Leave `src/styles.css` for future pages; there is no
  theme toggle or Google Fonts import to restore.

## Gotchas

- `bun run check` runs lint, typecheck, and the test suite; `.githooks/pre-commit` runs it and
  `bun install` points `core.hooksPath` there. A manual `git commit --no-verify` skips it, so a
  green local `bun run check` is still the thing to report.

- `database/` is gitignored and holds `dashboard.db` — the only store. A fresh
  clone has no data until `node scan.cjs` runs once (or the
  container starts, which scans on boot); until then the store's snapshot table is empty and the
  UI shows the "no scan stored yet" empty state with a Rescan button. Backing up means copying
  `dashboard.db` while the server is stopped; resetting means deleting it. Deleting it also drops
  the engine's inventory, which `acm list` rebuilds from the native configs on its next run.
- `scan.cjs` and `database/` are resolved from `process.cwd()`, so the server
  must run with the repo root as its working directory (true for `bun run dev`
  and for the container). The scanner writes only the SQLite file; there is no
  JSON snapshot any more, and no code reads JSON for config — settings come from
  the store's `config` table via `/settings`.
- `src/server/store.cjs` is loaded with `createRequire` from `process.cwd()` in
  `dashboard.server.ts`, not statically imported: Vite's dev SSR serves a `.cjs`
  source file as-is, so a static import fails in dev with `require is not
  defined`. Loading it by path works in dev and in the built server.
- No environment variables are required to run locally. `PUBLIC_ORIGIN` is
  required once a proxy fronts the server (see `src/server/origin-guard.ts`).
- TanStack Devtools in `src/routes/__root.tsx` are stripped from production
  builds by `@tanstack/devtools-vite`. No `removeDevtoolsOnBuild` config needed.

## Deployment

Target: a Dokploy Application built from this repo's `Dockerfile`, on the local
Swarm, at `http://acm.localhost` (Traefik, HTTPS off) with the container port
also published on the host. Dokploy cannot mount a bind read-only (v0.30.8 stores
only type / host path / mount path / volume name), so the host home goes in
read-write at its own absolute path (`HOST_HOME`) and the data directory is a
second read-write bind. The app's own code only reads `$HOME` and writes the
store under `/app/database`, but the env-tool `checkCommand` strings from
`/settings` are run as shell commands in the container and the dashboard has no
auth, so the writable home is a real trust boundary: keep that list to commands
you would run yourself, and keep the app on a trusted network. `tools/entrypoint.mjs`
exits 1 when `HOST_HOME` is not a directory and
warns when none of `.claude`, `.claude.json`, `.agents` is mounted under it. The
full recipe and the local restart/crash proof are in
[docs/deploy-dokploy.md](docs/deploy-dokploy.md). `bun run build` emits
`dist/client` + `dist/server` (Node SSR).

## Next steps

- Deploy the Dokploy Application using the operator checklist in
  [docs/deploy-dokploy.md](docs/deploy-dokploy.md).

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
