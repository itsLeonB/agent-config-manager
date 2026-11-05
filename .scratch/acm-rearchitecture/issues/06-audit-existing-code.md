# Audit the existing codebase for reusable inventory

Labels: wayfinder:task
Type: task
Status: resolved
Blocked by: none

## Question

Produce a concrete inventory of what in this repo can be reused for the slice and what is
Claude-only and must be left behind — no decisions here, just facts a later decision is
blocked on.

Read `scan.cjs`, `src/server/store.cjs`, `src/types/dashboard.ts`, the dashboard components
(especially `src/components/dashboard/ProjectsCompare.tsx`), `src/server/origin-guard.ts`,
the settings server/functions, and `src/lib/install-script.ts`. For each: what it does,
whether it is harness-agnostic, and what would have to change.

Answer explicitly:

1. With Claude skipped (charting Q4), is **any** existing discovery logic reusable as an
   adapter, or is all three-adapter discovery greenfield?
2. What happens to the existing Claude-only scan snapshots and `cloud.json` ingestion in
   `store.cjs` — kept, ignored, or migrated?
3. Which pieces are genuinely harness-agnostic and carry over as-is (SQLite store, secret
   redaction, origin guard, TanStack shell)?

**Zoom:** `AGENTS.md` architecture section, `BRIEF.md` §14. Unblocks: [Storage and migration decision](./10-storage-and-migration.md).

**Output:** a markdown inventory file, linked as an asset from this ticket.

## Answer

Inventory asset: [Codebase inventory (facts only)](../assets/06-codebase-inventory.md).
Written from a full read of `scan.cjs`, `store.cjs`, `store.d.cts`, `types/dashboard.ts`,
`dashboard.server.ts` / `.functions.ts`, `settings.server.ts` / `.functions.ts`,
`lib/settings.ts`, `lib/install-script.ts`, `lib/comments.ts`, `origin-guard.ts`,
`ProjectsCompare.tsx`, `package.json`, `Dockerfile`, `.mcp.json`, and the four test files.

1. **No adapter reuse — all three adapters are greenfield.** Discovery is eight top-level
   functions in `scan.cjs` with Claude paths inlined, compiled by `assembleLocal()` into one flat
   Claude-shaped literal. No registry, no seam, and no scope/tier/location concept, so ticket 01's
   Installation shape has nothing to wrap. What survives is the machinery *around* discovery:
   `readJsonSafe`, the redaction trio (this repo's existing answer to "never copy credentials"),
   `readSkillMeta`, `walkProjects`, `createCloudSync`, `resolveConfig`, and their `node:test` suites.
   Codex and OpenCode additionally need TOML/JSONC parsing and precedence-aware merging that
   nothing here does; only `readSkillMeta` reads a format all three harnesses share.
2. **Snapshots are inert; `cloud.json` ingestion is load-bearing for the dashboard.** Snapshot
   data is JSON in one `kind`-addressed table, validated on read by a zod `looseObject` that already
   returns `null` → the dashboard has an empty state. `createCloudSync` is wired into `scanOnce`
   and `runScanLoop`, so dropping it edits the scanner's main paths. `store.cjs` has **no migration
   runner** (`CREATE TABLE IF NOT EXISTS` only, no `user_version`) and **no query surface** (whole-blob
   snapshots, `ORDER BY id DESC LIMIT 1`), which is the fact ticket 10 turns on.
3. **Carries over as-is:** the whole store (WAL + `busy_timeout` already correct for a second
   writer), the redaction trio, `readSkillMeta`, the project walk, config resolution, the
   `install-script` + `comments` libs, `settings.server.ts` + `lib/settings.ts`, the
   `createServerFn` + `.validator()` + per-field-error convention, the `Json` type, `buildRows` from
   `ProjectsCompare`, the allowlist-then-`shellQuote` rule, the TanStack shell, and all four test
   files. **Does not carry:** every Claude path in `scan.cjs`, all domain interfaces in
   `types/dashboard.ts` (they remain valid only as the dashboard's read model), and the ten
   Claude-specific components.

One fact for ticket 08 specifically: `origin-guard.ts` is an HTTP-browser check (`Origin`,
`Sec-Fetch-Site`, loopback + `PUBLIC_ORIGIN`); an MCP stdio client sends neither header, so
`isSameOriginRequest(null, null, …)` returns `false` and the guard cannot authorise an MCP call.
The concept carries, the implementation does not.

**Superseded 2026-11-05 — the cloud half of this answer no longer holds.** `fcfbf2c` deleted the
entire claude.ai cloud surface ([ADR 0002](../../../docs/adr/0002-no-cloud-config-management.md)),
so: `createCloudSync` / `isCloudData` are gone and do **not** survive as reusable machinery (item
1); `cloud.json` ingestion is gone, so nothing is "load-bearing for the dashboard" and there is no
scanner main path left to edit (item 2); the `comments` lib and its `comments` table are gone with
it, so read item 3's "`install-script` + `comments` libs" as `install-script` alone. The four test
files item 3 counts are still four — they just cover less. Everything else above still reads true. Current
counts live in [the inventory](../assets/06-codebase-inventory.md).
