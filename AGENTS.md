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
environment tools, project scope — across the local machine and the claude.ai
cloud. [README.md](README.md) covers what it does and how to run it.

Bun is the package manager and script runner. Never `npm` / `npx` for this repo.

## Architecture

- **Rendering is TanStack Start** — React 19 + TypeScript, file-based routing
  under `src/routes/`. The previous version was a static `index.html` + `app.js`
  using hand-written DOM string templates; the React structure deliberately
  mirrors that page's modularity (one component per original render function in
  `src/components/dashboard/`, composed by `Dashboard.tsx`) rather than
  inventing new structure.
- **Data loading is server-only.** `src/server/dashboard.server.ts` reads the newest
  stored scan snapshot through `src/server/store.cjs` — the only module that touches
  `node:sqlite`, plain CJS so the TypeScript app imports it and `scan.cjs` requires it — and
  still reads `database/cloud.json` via `node:fs` until cloud ingestion lands. The helper
  wraps all this in a `createServerFn`; the index route's `loader` calls that. Loaders are
  isomorphic (they also run on the client), so filesystem access belongs behind
  `createServerFn`, and a loader must not self-fetch a relative URL during SSR.
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
deliberate and does not lean on framework defaults.
- **`scan.cjs` / `scan.test.cjs`** is an offline CLI data generator, not part of
  the app. It stays `.cjs` because `package.json` sets `"type": "module"` and
  the script uses `require()`.
- **Tailwind v4 is wired but unused.** The dashboard keeps its original
  hand-written CSS (dark/light via `prefers-color-scheme`, no toggle) for
  pixel-identical UX. Leave `src/styles.css` for future pages; there is no
  theme toggle or Google Fonts import to restore.
- **Comments are server-side.** The "missing" comments live in the store's
  `comments` table and are read once per page load in `getDashboardData`, so they
  follow the browser; the same-origin guard covers the write. The
  copy-install-script button (`src/lib/install-script.ts`) still uses the
  clipboard only. `src/lib/comments.ts` holds just the shared key format.

## Gotchas

- `database/` is gitignored and holds real scanned config plus `dashboard.db`. A fresh
  clone has no data until `node scan.cjs` runs once; until then the store's snapshot table is
  empty and the UI reads "database/local.json not found. Run: node scan.cjs".
- `scan.cjs` and `database/` are resolved from `process.cwd()`, so the server
  must run with the repo root as its working directory (true for `bun run dev`
  and for the container).
- `cloud.json` comes from the `/refresh-cloud` slash command (browser automation
  against claude.ai), not from any code in this repo.
- No environment variables are required.
- TanStack Devtools in `src/routes/__root.tsx` are stripped from production
  builds by `@tanstack/devtools-vite`. No `removeDevtoolsOnBuild` config needed.

## Deployment

Not deployed; this app has only run locally. `bun run build` emits
`dist/client` + `dist/server` (Node SSR). A target needs `database/*.json` on
its disk, or the data-loading layer swapped for another source — undecided.

## Next steps

- Pick a deployment target, and how `database/*.json` reaches it.
- Decide whether `scan.cjs` becomes a server route the UI can trigger, instead
  of a manually-run CLI script.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
