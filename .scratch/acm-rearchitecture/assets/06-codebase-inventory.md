# Codebase inventory (facts only)

Asset for [Audit the existing codebase for reusable inventory](../issues/06-audit-existing-code.md).
Read of the whole `src/` tree, `scan.cjs`, `scan.test.cjs`, `package.json`, `Dockerfile`, `.mcp.json`.
No decisions are recorded here; each fact that a decision hangs on is marked **→ blocks**.

Sizes are current line counts. "H-A" = harness-agnostic (contains no Claude-specific path, key,
or field name).

## 1. Summary table

| Path | Lines | Role today | H-A? |
|---|---|---|---|
| `scan.cjs` | 493 | offline discovery CLI + redaction + scan loop | **No** — Claude paths throughout |
| `src/server/store.cjs` | 60 | the only `node:sqlite` toucher: snapshots / config | **Yes** |
| `src/server/store.d.cts` | 13 | hand-written `Store` types for the CJS module | **Yes** — `kind` is pinned to `'local'` |
| `src/types/dashboard.ts` | 102 | hand-mirror of `scan.cjs` output = dashboard read model | **No** — Claude field names |
| `src/server/dashboard.server.ts` | 97 | store wiring, snapshot reads, scanner spawn | Mostly — one validator is Claude-shaped |
| `src/server/dashboard.functions.ts` | 16 | TanStack server fns: `getDashboardData`, `rescan` | **Yes** |
| `src/server/settings.server.ts` | 53 | read/write the 4 `config` keys with per-key fallback | **Yes** |
| `src/server/settings.functions.ts` | 32 | GET/POST server fns + field-error mapping | **Yes** |
| `src/lib/settings.ts` | 139 | zod schemas shared client+server, draft conversions | **Yes** |
| `src/lib/install-script.ts` | 14 | compose a pasteable shell script from command groups | **Yes** |
| `src/server/origin-guard.ts` | 38 | HTTP `Origin` / `Sec-Fetch-Site` allowlist for mutations | H-A but **wrong transport for MCP** |
| `src/components/dashboard/ProjectsCompare.tsx` | 352 | two-sided set diff + missing-row selection + copy commands | **Partly** — generic differ, Claude fields |
| `src/components/dashboard/*.tsx` (8 others) | ~437 | Claude-specific rendering of plugins/MCP/skills/env-tools | **No** |
| `src/routes/{index,projects,settings,__root}.tsx` | — | TanStack Start shell, file routing | **Yes** |
| `src/lib/settings.test.ts` | 101 | `node --test` unit tests for the schemas | Yes |
| `src/server/origin-guard.test.ts` | 113 | unit tests for the origin guard | Yes |
| `src/server/store.test.mjs` | 117 | round-trip tests for snapshots/config | Yes |
| `scan.test.cjs` | 281 | redaction, walk, resolve, scan tests | Yes |

Test runner is `node --test` (`package.json` `"test": "node --test"`), so `.test.ts`,
`.test.mjs` and `.test.cjs` all run. Lint is `oxlint`. Build is `vite build`; the container
runs Bun to build and Node 22 to serve.

## 2. What is absent (confirmed by file list + `package.json`)

- No CLI, no argument parser, no `bin` entry.
- No MCP server; `@modelcontextprotocol` is **not** in `bun.lock` or `node_modules`. The
  `.mcp.json` at the repo root configures *other* MCP servers for this repo's own agents — it
  is a sample of the format, not a server we run.
- No adapter, no adapter registry, no capability table, no harness detection, no version probe.
- No `Plan`, `Operation`, `Verification` type or table.
- No write path to any harness's native config. Every write in the app goes to `dashboard.db`.
- No schema migration mechanism: `store.cjs`'s `SCHEMA` is `CREATE TABLE IF NOT EXISTS` only,
  and nothing reads or writes `PRAGMA user_version`.
- No `detectDrift`, no rollback, no operation history.
- No claude.ai cloud surface of any kind: the `/refresh-cloud` scrape, `cloud.json` ingestion,
  `CloudData`, and the cloud snapshot rows were deleted in `fcfbf2c` (see
  [ADR 0002](../../../docs/adr/0002-no-cloud-config-management.md)). `snapshots.kind` is written
  only as `'local'`.

## 3. `scan.cjs` — the only discovery code, and how much of it is a harness

Discovery is a set of top-level functions that each hardcode one Claude path, called once
from `assembleLocal()` which builds one Claude-shaped object literal. There is no registry,
no per-harness module, and no seam where a second harness could be inserted.

| Function | Hardcoded assumption |
|---|---|
| `getInstalledPlugins` | `~/.claude/plugins/installed_plugins.json`, `plugin@marketplace` key, `scope: 'user'\|'project'` |
| `getEnabledPluginsFromSettings` | `~/.claude/settings.json` → `enabledPlugins`, `extraKnownMarketplaces` |
| `getKnownMarketplaces` | `~/.claude/plugins/known_marketplaces.json` |
| `getUserMcpServers` | `~/.claude.json` → `mcpServers` |
| `getUserSkills` | `~/.claude/skills` (skips symlinks) + `skills/` inside each plugin `installPath` |
| `getNpxSkillsGlobal` | `~/.agents/.skill-lock.json`; emits `npx skills add … -a claude-code -a codex` |
| `scanProject` | `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `CLAUDE.md` then `AGENTS.md`, `.claude/skills`, `.agents/skills`, `~/.claude.json` → `projects[path]` |
| `getEnvironmentTools` | none — runs `execSync(t.checkCommand)` per configured tool |

Harness-agnostic helpers inside `scan.cjs`, each independently callable and unit-tested in
`scan.test.cjs`:

- `readJsonSafe` — JSON read that returns `null` on missing/malformed.
- `redactSecrets` / `redactMcpServers` / `redactArgsArray` / `maskValue` (~45 lines) — key-name
  and flag-shape driven (`token|key|secret|authorization|password|credential|bearer|cookie|session`),
  with `${ENV_VAR}` placeholders deliberately left intact. Knows nothing about Claude. **This is
  the repo's existing answer to BRIEF §10 "never copy credentials".**
- `walkProjects`, `looksLikeGitRepo` — depth-limited repo walk with skip list.
- `listSkillsDir` — directory listing that reports symlinks + link target.
- `readSkillMeta` — regex-reads `name:`/`description:` out of `SKILL.md`. `SKILL.md` is the one
  format shared by Pi, Codex and the `~/.agents/skills` convention.
- `resolveConfig` / `loadConfig` / `resolveScanInterval` / `parseIntervalMinutes` — stored-then-env-then-default
  resolution, per tick.
- `scanOnce` / `runScanLoop` / `sleep` — one-off scan and interval loop with per-tick config.

**How much of that is a code skeleton for an adapter: none.** The reusable-freeze is that
`assembleLocal` returns a flat object keyed by *category* (`plugins`, `mcpServers`, `skills`,
`projects`) with no scope/tier/location concept — ticket 01's Installation shape
(`category, name, scope, nativeLocation, bindings[]`) has no counterpart here, so there is
nothing to wrap, only to write.

## 4. `src/server/store.cjs` — the persistence seam

Two tables, both generic:

```sql
snapshots (id INTEGER PK, created_at TEXT, kind TEXT, data TEXT)  -- data = JSON blob
config    (key TEXT PK, value TEXT)                              -- value = JSON
```

- Writes are whole-blob: `saveSnapshot(kind, data)` stringifies; `readLatestSnapshot(kind)` is
  `ORDER BY id DESC LIMIT 1`. There is **no query surface** — the store cannot answer "which
  installations exist in scope X" or "what plans are pending".
- `PRAGMA journal_mode = WAL` and `busy_timeout = 5000` are already set, and the comment says why
  (reader keeps serving while the scanner commits). A second writer process would inherit the
  same protection.
- `store.d.cts` types the API and pins `kind` to `'local'`, so the store's own code holds no
  Claude-specific assumption — only the payload type passed in does. Adding a table means
  appending to `SCHEMA`;
  changing an existing table has no path (no migrations, and `CREATE TABLE IF NOT EXISTS` would
  silently keep the old shape).

**→ blocks** [Storage and migration decision](../issues/10-storage-and-migration.md) q1/q2: tree of
options is (a) append tables to this same `SCHEMA`, (b) a second `.cjs`/module against the same
file, (c) a second database file. Facts that bear on it: no migration runner exists; the store is
blob-only; `bun run test` covers it via `node:test`.

## 5. `src/types/dashboard.ts` — the read model, not a domain model

Every interface is Claude vocabulary: `Plugin {plugin, marketplace, enabled, version}`,
`McpServerConfig {type, url, command}`, `Skill {source: 'plugin'|'standalone', plugin, marketplace}`,
`Project {mcpJson: {mcpServers}, pluginInstalls, skills, agentsSkills, npxSkills}`,
`LocalData {generatedAt, userScope, npxSkillsGlobal, environmentTools, projects}`.
`DashboardData` is `{ local }` — one side, no counterpart.

Zero of these types appear in ticket 01's canonical model. `LocalData` stays valid as *the
dashboard's* read model. The `Json` recursive type exists because a server function's return must
be provably serializable — the same constraint applies to any MCP tool result.

## 6. Server-function and approval patterns already in the repo

- Every mutating server fn (`rescan`, `saveSettings`) opens with
  `if (!isSameOriginMutationRequest(getRequest())) return { ok: false, … }`. That is an existing,
  tested "no mutation without an explicit trust check, and a rejection is a returned value not an
  exception" convention.
- `settings.functions.ts` binds a zod schema with `.validator(settingsSchema)` and maps server
  rejections back onto named fields (`errors: {field, message}[]`). Precedent for a structured,
  field-addressed rejection payload — the shape an approval/plan-validation response needs.
- `dashboard.server.ts` `runScan()` dedupes concurrent callers through one `inFlightScan` promise,
  and spawns with `process.execPath` (Bun in dev, Node in the container) with a 120 s timeout,
  surfacing the first stderr line that names the failure rather than a stack frame.
- `src/lib/install-script.ts` + `NpxCopyButton`: the existing "the app produces a shell command,
  a human copies and runs it, the app never executes it" path. Contrast with
  `getEnvironmentTools`, which *does* `execSync` user-supplied commands at scan time.

**→ blocks** [Permission, approval, and safety model](../issues/08-permission-and-approval-model.md):
`origin-guard.ts` is an HTTP-browser trust check (`Origin`, `Sec-Fetch-Site`, loopback host +
`PUBLIC_ORIGIN`). An MCP stdio JSON-RPC client sends no `Origin` and no `Sec-Fetch-Site`, so as
written `isSameOriginRequest(null, null, …)` returns `false` — the guard cannot authorise an MCP
call. The *concept* (mutations need an explicit allow-check; the allowlist may only hold values a
foreign caller cannot supply) carries; the implementation does not.

## 7. `ProjectsCompare.tsx` — the closest thing to a cross-scope differ

- `buildRows<T>(left, right, keyOf, labelOf, valueOf)` (lines ~16-33) is a **generic, typed,
  harness-agnostic** two-sided set diff producing `{key, label, left?, right?}` per side. This is
  structurally "present here, missing there" — the exact row shape a mirror plan's diff needs.
- `CompareTable` + `renderMissing` + checkbox selection + shift-click range select + a copy button
  is the existing human-in-the-loop "diff, choose, act" UX.
- Hard limit: it compares two *Claude project scopes on the same harness*. Field names (`npxSkills`,
  `pluginInstalls`, `mcpJson.mcpServers`) are baked in, and the "action" is a clipboard write.
- `buildNpxInstallCommand` + `SAFE_SOURCE_RE` / `SAFE_NAME_RE` + `shellQuote` (lines ~95-110):
  allowlist-then-single-quote before interpolating a value that came from *another project's*
  lockfile into a shell command. A worked example of "untrusted config value reaches a shell".

## 8. The explicit answers

**Q1. With Claude skipped, is any existing discovery logic reusable as an adapter — or is
three-adapter discovery greenfield?**

Greenfield. No adapter-shaped seam exists: discovery is eight top-level functions with Claude paths
inlined, compiled into one flat Claude-shaped object by `assembleLocal()`. What is reusable is the
*mechanics around* discovery, not the discovery: `readJsonSafe`, the redaction trio, `readSkillMeta`,
`walkProjects`, `listSkillsDir`, `resolveConfig`, the `node:test` suites that cover them. Two of the three harnesses (Codex, OpenCode) need TOML/JSONC-ish parsing plus
precedence-aware merging that nothing in this repo does; only `readSkillMeta` reads a format all
three share.

**Q2. What happens to the existing Claude-only snapshots?** (The `cloud.json` half of this
question was answered by deletion, not by a decision — see below.)

Facts, not a recommendation:
- The data is inert JSON in one `snapshots` table, addressed by `kind`; nothing joins on it and
  nothing else reads it.
- `readLocalData()` zod-`looseObject`-validates before returning, and returns `null` otherwise, so
  the dashboard already has a "stored snapshot is unreadable → empty state" path.
- `cloud.json` ingestion is **gone**: `createCloudSync` / `isCloudData`, the `/refresh-cloud`
  endpoint, the `CloudData` type, and the `'cloud'` value of `snapshots.kind` were all deleted in
  `fcfbf2c` ([ADR 0002](../../../docs/adr/0002-no-cloud-config-management.md)). Nothing writes, so
  no new cloud rows appear. **Residual fact:** `store.cjs` has no `DELETE` at all, so an existing
  `dashboard.db` keeps any old `kind = 'cloud'` rows forever, unread and undeleted; a fresh clone
  never creates them.
- `database/` is gitignored and holds the only store; a fresh clone has no data.

**→ blocks** [Storage and migration decision](../issues/10-storage-and-migration.md) q3, and needs a
call on whether the residual Claude dashboard keeps being served (BRIEF §16 / map "Out of scope"
keeps the read-only UI as-is for this slice).

**Q3. Which pieces are genuinely harness-agnostic and carry over as-is?**

Carry over with no change: `store.cjs` (all three tables, WAL + busy_timeout, `store.d.cts`),
`redactSecrets` / `redactMcpServers` / `redactArgsArray` / `maskValue`, `readJsonSafe`,
`readSkillMeta`, `walkProjects` / `looksLikeGitRepo` / `listSkillsDir`, `resolveConfig` /
`loadConfig` / `resolveScanInterval`, `install-script.ts`, `settings.server.ts` +
`lib/settings.ts` + their tests, the server-function + `.validator()` + per-field-error convention,
the `Json` type, the TanStack shell (routes, `__root`, `router.tsx`), `buildRows` from
`ProjectsCompare`, the allowlist-then-`shellQuote` rule, and all four `*.test.*` files.

Carry over with a change: `store.d.cts`'s `kind` union (any new table or kind widens it);
`dashboard.server.ts` (the `localDataValidator` field list, if snapshots change shape);
`origin-guard.ts` (transport, see §6).

Do not carry: every Claude path in `scan.cjs`, all of `src/types/dashboard.ts`'s domain interfaces,
and the eight Claude-specific dashboard components.
