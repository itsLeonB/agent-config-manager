# The Claude Code dashboard

The previous product, kept working unchanged by the engine work: it inventories this machine's
Claude Code setup (plugins, MCP servers, skills, environment tools, project scope) and serves it as
one page plus `/settings`. What follows is how that page, its scanner, and its container work.

## Rendering

**TanStack Start** — React 19 + TypeScript, file-based routing under `src/routes/`. The previous
version was a static `index.html` + `app.js` using hand-written DOM string templates; the React
structure deliberately mirrors that page's modularity (one component per original render function in
`src/components/dashboard/`, composed by `Dashboard.tsx`) rather than inventing new structure.

TanStack Devtools in `src/routes/__root.tsx` are stripped from production builds by
`@tanstack/devtools-vite`. No `removeDevtoolsOnBuild` config needed.

**Tailwind v4 is wired but unused.** The dashboard keeps its original hand-written CSS (dark/light
via `prefers-color-scheme`, no toggle) for pixel-identical UX. Leave `src/styles.css` for future
pages; there is no theme toggle or Google Fonts import to restore.

## Data loading

**Server-only.** `src/server/dashboard.server.ts` reads the newest stored scan snapshot through
`src/server/store.cjs`. The helper wraps all this in a `createServerFn`; the index route's `loader`
calls that. Loaders are isomorphic (they also run on the client), so filesystem access belongs
behind `createServerFn`, and a loader must not self-fetch a relative URL during SSR.

`src/server/store.cjs` is loaded with `createRequire` from `process.cwd()` there, not statically
imported: Vite's dev SSR serves a `.cjs` source file as-is, so a static import fails in dev with
`require is not defined`. Loading it by path works in dev and in the built server.

`database/dashboard.db` is the only store: scan snapshots plus the settings rows. A fresh clone has
no data until `node scan.cjs` runs once (or the container starts, which scans on boot); until then
the snapshot table is empty and the UI shows the "no scan stored yet" empty state with a Rescan
button. Backing up means copying `dashboard.db` while the server is stopped; resetting means
deleting it.

**`src/types/dashboard.ts`** hand-mirrors the JSON shapes `scan.cjs` emits — kept in sync by hand,
not derived from it. `mcpJson` / `pluginInstalls` need the recursive `Json` type because a server
function's return type must be provably serializable, so `unknown` will not do.

**Rescan is a POST server function** (`rescan` in `src/server/dashboard.functions.ts`). It spawns
`scan.cjs` with `process.execPath` — Bun under `bun run dev`, Node in the container — so one code
path covers both, awaits exit, and returns the new counts; the button then invalidates the route
loader so the page re-renders with no reload. A failed scan returns `ok: false` and is never
invalidated, so the previous snapshot stays on screen. Concurrent callers join the in-flight scan
instead of starting a second scanner.

**Mutating server functions check the request origin** (`src/server/origin-guard.ts`, unit-tested in
`origin-guard.test.ts`), because the scanner runs the configured env tool check commands as shell
commands. TanStack's default CSRF middleware also runs; the explicit guard is deliberate and does
not lean on framework defaults. Its allowlist is only `new URL(request.url).origin` plus
`PUBLIC_ORIGIN`, never `x-forwarded-*`: a foreign page can send its own `Origin` with matching
forwarded headers, so those headers cannot whitelist anything. No environment variables are needed
locally; `PUBLIC_ORIGIN` is required once a proxy fronts the server.

**Settings live in the store's `config` table.** `src/routes/settings.tsx` renders
`src/components/settings/SettingsForm.tsx`; the values are read and written by
`src/server/settings.server.ts` behind the POST server function in `src/server/settings.functions.ts`.
`src/lib/settings.ts` holds the zod schemas the server validates with and the draft/validate helpers
the form runs on blur, so both sides agree. The scanner re-reads the keys at the start of every tick,
so a save needs no restart; the defaults are mirrored in `scan.cjs`'s `resolveConfig` (marked
`shortcut:`).

## The scanner

**`scan.cjs` / `scan.test.cjs`** is an offline CLI data generator, not part of the app. It stays
`.cjs` because `package.json` sets `"type": "module"` and the script uses `require()`.

`scan.cjs` and `database/` are resolved from `process.cwd()`, so the app must run with the repo root
as its working directory (true for `bun run dev`). The scanner writes only the SQLite file; there is
no JSON snapshot, and no code reads JSON for config — settings come from the store's `config` table
via `/settings`.

## Container

`tools/entrypoint.mjs` points `HOME` at `HOST_HOME`, starts `scan.cjs --loop`, and stops so the
container restarts if that loop exits — a dead scanner would otherwise serve silently stale data. It
then imports `tools/serve.mjs`, which serves `dist/client` and `dist/server` through `srvx` on
`PORT` / `HOST`. `bun run build` emits those two directories (Node SSR).
