# Wayfinder map — Agent-driven cross-harness config mirroring

Labels: wayfinder:map

## Destination

A handoff spec + ADR set, committed to the repo, for the **smallest first slice** whose entire
purpose is: an AI agent, through MCP, takes how a component is configured in one harness and
creates the equivalent, correctly-adapted configuration in another harness — native formats
preserved, explicit approval before any write. Adapters in this slice: **Pi, Codex, OpenCode**
(Claude Code skipped). The way is clear when nothing is left to decide before someone builds
that slice.

## Notes

- **Domain:** AI coding-agent harness configuration management. Use the vocabulary of
  `BRIEF.md` §5–6 (Component, Installation, Scope, Harness, Adapter, Plan) plus the sharpened
  term settled in charting Q3: *mirror* = given a source Installation, produce a plan that
  creates an equivalent Installation in a target harness+scope, translating config per that
  harness's declared capabilities (never a blind byte-copy), surfacing unsupported/partial-
  support cases, then apply/verify under approval.
- **Source of truth:** `BRIEF.md` is the target vision, but this map targets only the first
  slice. Accept its vision, non-goals (§16), and guiding principles (§18); decide the *how*,
  not the *whether*.
- **Standing constraints** (`BRIEF.md` §1, §4.2, §10, §18): native config is the source of
  truth; discovery never implies ownership; no unrestricted shell execution; separate planning
  from execution; explicit authorization for mutations; preserve unknown fields; never copy
  credentials; treat hooks/plugins as executable code; mutations recorded and verifiable.
- **Codebase fact:** this repo is currently a read-only Claude Code dashboard (TanStack Start,
  SQLite via `src/server/store.cjs`, `scan.cjs` discovery, project-vs-project compare). There
  is no CLI, no MCP server, no harness adapter, and no mutation path. All of Pi, Codex,
  OpenCode (and Cursor) are installed on this machine. **Because Claude is skipped, none of
  the existing Claude-specific discovery transfers as an adapter** — the three adapters are
  greenfield; reusable parts are the SQLite store, the redaction helper in `scan.cjs`, the
  origin guard, and the TanStack shell. This is the single biggest consequence of Q4.
- **Skills each session should consult:** `grilling` + `domain-modeling` for grilling tickets;
  `research` for research tickets; `prototype` for the prototype ticket. Also `AGENTS.md`
  (Bun only, never npm/npx), `docs/agents/issue-tracker.md`, `docs/agents/domain.md`.
- **Tracker:** local markdown — `.scratch/acm-rearchitecture/`. Frontier = open, unblocked,
  unclaimed child issues; first by number wins. Tickets carry `wayfinder:<type>` labels only.
- **Scope decisions settled during charting (not tickets):** Q1 destination; Q2 no automatic
  sync; Q3 mirror is first-class; Q4 slice = Pi/Codex/OpenCode with Claude skipped.

## Decisions so far

<!-- one line per closed ticket: [Title](link): gist. Empty at charting; charting resolves nothing by hand. -->

- [Pi native configuration surface](issues/03-pi-config-surface.md): Pi has two scopes (user
  `~/.pi/agent`, project `.pi/`), no hook config — hooks are extension code, so plugins/hooks cannot
  be mirrored as data; MCP is Claude-compatible `mcp.json` but `pi mcp add` replaces whole entries
  rather than merging fields; programmatic install exists only for packages and MCP; project trust
  and MCP OAuth are human-only steps. Findings on `research/pi-config`.
- [Codex native configuration surface](issues/04-codex-config-surface.md): three scopes (user,
  launch-time `profile`, project) with project gated on `trust_level` in the *user* config; hooks
  **are** declarative config here (14 events, additive merge, trust keyed on content hash +
  positional index) — the inverse of Pi; MCP merges per field across layers but `codex mcp add`
  replaces whole tables and is user-scope only, so project-scope writes must be file writes;
  `config.toml` can hold MCP OAuth `client_secret`. Findings on `research/codex-config`.
- [OpenCode native configuration surface](issues/05-opencode-config-surface.md): four tiers with
  `/etc/opencode` **outranking** the project and ancestor-chain merging; hooks are code (not
  config, as in Pi); MCP is `mcp.servers.<name>` + `disabled` with whole-entry replace, no
  field patch; the CLI manages only `mcp add|auth|logout` and `plugin *`, global scope only, and
  there is no `mcp remove`; invalid config is dropped with **exit 0 and empty stderr**.
  Findings on `research/opencode-config`.
- [Canonical domain model for mirroring](issues/01-canonical-domain-model.md): BRIEF §5–6 extended,
  not adopted verbatim. Installation key is `(category, name, scope, nativeLocation)` with
  `bindings: [{harness, tier, method, version, verification}]` replacing the flat harness field;
  scope is a derived 4-value bucket over an **adapter-declared tier** (ADR 0001); `knownFields` +
  digest replace "configuration state" so no secret is ever stored; management status dropped;
  capability is `(harness, category, tier)`, adapter-owned, gaps live on the plan.
- [Harness adapter contract and capability model](issues/02-adapter-contract-and-capabilities.md):
  adapter = descriptor (tiers, formats + pointer syntax, one `(category, tier)` table with
  `read`/`write`/`verify` verdicts, `method`, `expressible` **allowlist**) + optional per-category
  handlers, checked for agreement at load; `translate()` returns a discriminated union of *facts*
  (`notTranslatable` | `manual` | `translatable` with `knownFields`, `unexpressible[]`, `writes[]`,
  `preserved[]`) and never a severity — gap policy stays with the planner. Plans carry native
  locations plus a target excerpt/diff, never a whole-file copy. **Versioning skipped**: detection
  recorded as a fact, nothing gates on it, latest release only.
- [Audit the existing codebase for reusable inventory](issues/06-audit-existing-code.md): no adapter
  reuse — discovery is eight Claude-path functions in `scan.cjs` with no registry or scope/tier
  concept, so all three adapters are greenfield; what carries is the machinery around it (redaction
  trio, `readSkillMeta`, `walkProjects`, `resolveConfig`). `store.cjs` has no
  migration runner and no query surface (blob snapshots, `ORDER BY id DESC LIMIT 1`), WAL +
  `busy_timeout = 5000` already suit a second writer; `origin-guard.ts` is HTTP-only, so an MCP
  stdio client sends neither `Origin` nor `Sec-Fetch-Site` and the guard cannot authorise a call.
  Inventory on `assets/06-codebase-inventory.md`.
- [The mirror operation and its plan representation](issues/07-mirror-operation-and-plan.md): mirror has
  **four ops** — `writeAtPointer`, `writeFile`, `copyFile`, `runCommand` — plus a plan-level
  `manualSteps[]`; no mkdir, symlink, package install, or removal (plugins, hooks, and credentials
  are `manual` or `notTranslatable`, never writes). A plan is **stateless and content-addressed**:
  `planId` is the sha256 of its own canonical JSON, each write carries the target file's digest as
  a precondition, and `apply` refuses a stale plan instead of re-deriving one. "Equivalent" is
  sharpened to **field-equivalence** — the source's `knownFields` partitioned into
  `carried[] | mapped[] | gaps[] | preserved[]` — and verification asserts only `carried ∪ mapped`
  on disk, never a harness probe, so a plan with pending `manualSteps[]` lands `unverified`, not
  `verified`. Conflicts refuse by default (`onConflict: 'replace'` required); `notTranslatable`,
  `alreadyPresent`, and `already shared` all return a plan with empty `writes[]`, never a separate
  error shape. Needs one amendment to ticket 02's `translate()` union (`manualSteps[]`).
- [Permission, approval, and safety model for MCP mutations](issues/08-permission-and-approval-model.md):
  consent is **graded**, so a client without elicitation still applies. The engine grades each plan
  `safe` (pointer/file writes into existing files, no risk flags → applies anywhere, consent recorded
  `client-policy`) or `risky` (executable / secretValues / irreversible / copyFile / conflict /
  new dir / elevation → needs elicitation; on Pi 1.5.0 — which has no elicitation — only those
  writes return as `manualSteps`). A caller-supplied `confirm` is always inert. Four gates:
  plan is read-only → graded consent → preflight+containment → risk-flag ticks. Approval binds to
  `planId` per call, stateless, audit on target `provenance`. User + project tiers writable,
  elevated/root tiers refused; writes must match an adapter-declared `writePaths` entry, resolve
  without symlinks, be regular files, and never touch a credential location. Preflight all, then
  write; mid-flight failure returns `partial` + `landed[]`, no rollback. `runCommand` kept in the
  vocabulary with an **empty allowlist**. Executable content (scripts/plugin dirs, `!command`
  headers) needs its own tick and can never land `verified`. A deterministic in-engine secret
  classifier emits `clean|suspect|secret` per pointer and nothing secret ever leaves the process;
  a hit stops the plan and offers migrate-out → blind copy → risk-read. OAuth: mirror the entry,
  never the grant.

- [Minimal MCP tool surface and a worked mirror example](issues/09-mcp-tool-surface.md): **five tools** —
  `list_installations(category?, harness?, scope?, fresh?)` (folds BRIEF's discovery + inventory
  groups; harness rows ride along because a target must be a writable existing tier),
  `inspect_installation`, `plan_mirror(installationId, target)` returning the whole plan document
  with `security.grade: safe|risky` on it (an addition to 07's plan schema),
  `apply_plan(plan, onConflict?)`, and `verify_plan(plan)` — which exists *only* because plans are
  stateless, to re-assert after a pending `manualSteps[]`. No plan id anywhere; the agent carries
  the document. Identical signatures on all three clients — the elicitation difference shows up in
  the *result* (`consent: "client-policy"`, risky writes moved to `manualSteps[]` on Pi), never in
  the surface. Inventory freshness = stored snapshot with `fresh: true` forcing a re-scan, safe
  because `plan_mirror` re-reads for `contentDigest` and `apply` for `precondition.digest`.
  `rollback_operation` out, Comparison and Research groups deferred. Prototype on
  `assets/09-mcp-tool-surface.md`; the V1/V2 OpenCode shape question and the many-to-one
  `command + args → command[]` mapping are handed to ticket 12.

## Not yet specified

- **Which harness pairs matter most.** Source/target precedence and the highest-value first
  pair depend on which harnesses are actually used day to day — a human fact, not a research one.

## Out of scope

- **Automatic / blanket synchronization** of every component across harnesses, including
  continuous or background sync (`BRIEF.md` §16 Non-Goal; settled in charting Q2). Mirroring
  here is agent-initiated, explicit, and per-component.
- **Claude Code adapter** — explicitly skipped for this slice (charting Q4). The brief's
  §14 step 5 / §15 Phase 2 "convert/implement the Claude adapter" is not on this route. It
  returns only if the destination is redrawn, as a fresh effort.
- **Full CLI** (`BRIEF.md` Phase 3) and **the read-only web UI** (Phase 7) — deferred; the
  existing dashboard stays as-is for this slice.
- **Installation-intelligence research pipeline / recipes with evidence & confidence**
  (`BRIEF.md` Phase 5, §9) — deferred.
- **Adoption, drift-detection lifecycle, and full rollback** (`BRIEF.md` §11, Phase 8) —
  deferred. Verification *of a mirror* is in-slice; the broader lifecycle is not.
- **Universal config format, replacing native config, or a marketplace** (`BRIEF.md` §16).
- Harnesses beyond Pi/Codex/OpenCode (Gemini CLI, Qoder, Mistral Vibe, Cursor, Copilot).
