# Per-category canonical field tables for the slice

Labels: wayfinder:grilling
Type: grilling
Status: resolved
Blocked by: 02, 07

## Question

Populate the `expressible` allowlists, native field names, pointer syntaxes, and `mapped[]`
transforms for the categories the first slice actually mirrors — `mcp`, `skills`, `instructions`,
`commands` — across Pi, Codex, and OpenCode.

Ticket 02 fixed the *shape* (`expressible` is a per-`(category, tier)` canonical-field allowlist that
fails closed; an unlisted field is a gap by default) and ticket 07 fixed what a gap looks like on a
plan (`gaps[{field, reason, replacement}]`, `replacement ∈ renamed | inverted | dropped`). Neither
says which names go in the tables. That was fog until both landed.

Decide, per `(harness, category, tier)`:

1. **The canonical field names in the allowlist**, and for each, its native name and pointer syntax
   per harness. Codex `config.toml` vs OpenCode JSONC vs Pi JSON means the same canonical field has
   three addresses.
2. **The `mapped[]` transforms.** One is agreed in principle (Codex `enabled` → OpenCode's inverted
   `disabled`). Which others exist — transport kinds (`stdio` / `http` / `sse`), `args` shape,
   `env` interpolation, per-server `type` discriminators?
3. **Credential-bearing fields**, excluded from the allowlist entirely so they can never enter
   `knownFields` (ticket 07 §2: they surface as a gap with `reason: credential`, always `manual`).
   Codex's `mcp_servers.<id>.oauth.client_secret` is the known case — find the rest.
4. **File op or pointer op.** Skills are `SKILL.md` directories everywhere and commands are markdown
   everywhere, so they are `writeFile`/`copyFile`; MCP is `writeAtPointer`; instructions are
   `AGENTS.md` for Codex and Pi but OpenCode reaches them through an `instructions[]` array. Is a
   category ever both, in the same harness?

Work the pairs in this order, because each stress-tests a different rule:
**Codex → OpenCode MCP** (inverted field, `.env` sub-table, no field patch), then
**Codex → Pi MCP** (Pi's `mcp.json` is Claude-compatible, but `pi mcp add` replaces whole entries
rather than merging — so the `method` column decides whether the write is a file or a command), then
**Pi → OpenCode skills** (same content, different tier, and 01's "already shared" case if the target
path coincides).

Out of this ticket: plugins (a `manual` gap per ticket 07 §1). **Hooks are in** — see the comment
below; ticket 11 made hooks a real write for Pi and Codex. Anything in `BRIEF.md` §9's recipe
pipeline stays out.

**Zoom:** [Pi](./03-pi-config-surface.md), [Codex](./04-codex-config-surface.md),
[OpenCode](./05-opencode-config-surface.md) — the three researches hold the native surfaces;
`BRIEF.md` §5, §9.4. Builds on: [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md),
[The mirror operation and its plan representation](./07-mirror-operation-and-plan.md).

**Output:** the allowlist tables in the handoff spec, one table per `(harness, category)` with the
tier column carrying `method` and `expressible`.

## Comments

**2026-11-05 — shape question handed over from [Minimal MCP tool surface](./09-mcp-tool-surface.md).**

The prototype's trace B (Codex `mcp_servers.serena` → the real `~/.config/opencode/opencode.json`)
exposed a gap class that is not a per-field gap:

- OpenCode's legacy V1 flat `mcp.<name>` + `enabled: true` is still accepted and normalised in
  memory (ticket 05 headline 3), so the engine writes V2 `mcp.servers.<name>` + `disabled` into a
  file that may still hold the old shape, yielding a mixed document. Decide whether that
  normalisation is reported in `equivalence.mapped[]` or is invisible plumbing.
- `codex command: "serena"` + `args: [...]` → `opencode command: ["serena", ...]` is a structural
  mapping (two source fields into one target array), not a rename. This table is the first place
  that has to say how a many-to-one mapping is named in `mapped[]`.

**2026-11-05 — hooks handed in from [Capability-gap semantics](./11-capability-gap-semantics.md).**

That ticket's exclusion premise flipped: hooks are no longer `manual` everywhere. What this ticket
now owes, beyond its four categories:

- A **hooks table** per target. Codex carries native `hooks.json` / `[hooks]` (14 events); Pi carries
  `hooks.json` only once `npm:@vahor/pi-hooks` is installed; OpenCode is `categoryAbsent` and gets
  no table. So the `expressible` allowlist differs per target *and* the `manualSteps[]` differs.
- The **event-name mapping** — a source event has to land on the target's own event name, or become
  a `fieldAbsent` gap. Codex's 14 events, Pi's `pi.on()` event set, and OpenCode's plugin hooks do
  not share names.
- The **handler mapping**: `{command}` vs `{mcp_tool}` (Codex) vs a shell-command array entry (Pi
  via the bridge). Every command-carrying write is `executable` and can never verify (ticket 11 §7),
  which the table has to state in its `method` column rather than leave to prose.
- `gaps[].reason` comes from ticket 11's closed five; `executable` and `categoryAbsent` are the two
  this table will actually emit.

## Answer

Settled with the dev over three grilling rounds on 2026-11-05, with [Secret detection
rules](./13-secret-detection-rules.md) landing between rounds 2 and 3 and rewriting three of the
answers. Category set is `mcp`, `skills`, `instructions`, `hooks` — **`commands` is dropped** from
the slice (Pi `prompts/` and OpenCode `commands/` exist, Codex has no such surface at all, and the
dev does not use them).

### 0. Shapes this ticket changes

| Ticket | Change |
|---|---|
| 02 §1 | `detectVersion()` deleted. The adapter has **no version surface**; latest release only, assumed, never recorded. |
| 02 §2 | `expressible` moves to a per-`(harness, category)` record; the `(category, tierId)` rows carry `method` + a reference, not a copied list. |
| 02 §2 | `method` is `file` on **every writable row**. `cli` stays in the vocabulary, unused — no write in this slice runs a harness CLI (see §6). |
| 02 §1 | `credentialPointers: string[]` → `{ pointer, kind: 'leaf' \| 'file' }[]`, because three categories point at whole files. |
| 07 §2 | `mapped[]` entry → `{ transform, fields: string[], targetField, template? }`. `transform` is a closed seven: `rename`, `invert`, `concat`, `unit`, `infer`, `extract`, `wrap`. |
| 07 §2 | `writes[]` gains one op, `symlink` (§1.4), and `target` gains `alsoReadBy: Harness[]` (§1.5). |
| 07 §2 | A credential gap's `replacement` is `dropped`. No fourth value: `reason: credential` already says why, and the migrate-out instruction lives in its mandatory `manualSteps[]`. |
| 07 §3 | Its worked stress case is **wrong twice** and is corrected in §1.3: the Codex `.env` sub-table is just `env` (a TOML sub-table, not a Codex-only shape), and `startup_timeout_sec` is not a gap into OpenCode. |
| 10 | `bindings.version` dropped from the schema. |
| 11 §5 | OpenCode hooks are no longer `categoryAbsent` — they are **generated plugin code** (§4.3). |

### 1. Cross-cutting

**1.1 Categories and tiers.** Mirror targets are the writable tiers only: `pi:user`, `pi:project`,
`codex:user`, `codex:project`, `oc:user`, `oc:project`. Out: `codex:profile` (launch-time only),
`oc:system` (`/etc/opencode`, elevated), `oc:home` (`~/.opencode` — real, undocumented, and its
precedence against `~/.config/opencode` is still unverified).

**1.2 `writePaths` per adapter** (08 §5 checks every write against these):

| Adapter | Declared writable paths |
|---|---|
| Pi | `~/.pi/agent/mcp.json`, `.pi/mcp.json`, `~/.pi/agent/hooks.json`, `.pi/hooks.json`, `~/.agents/skills/<name>/`, `.agents/skills/<name>/`, `~/.pi/agent/AGENTS.md` |
| Codex | `$CODEX_HOME/config.toml`, `<repo>/.codex/config.toml`, `$CODEX_HOME/hooks.json`, `<repo>/.codex/hooks.json`, `$HOME/.agents/skills/<name>/`, `<repo>/.agents/skills/<name>/`, `$CODEX_HOME/AGENTS.md` |
| OpenCode | `~/.config/opencode/opencode.json(c)`, `<repo>/.opencode/opencode.json(c)`, `~/.config/opencode/plugins/<name>.ts`, `<repo>/.opencode/plugins/<name>.ts`, `~/.config/opencode/skills/<name>/`, `~/.config/opencode/AGENTS.md` |

**1.3 MCP field vocabulary.** Canonical name on the left, native address per harness on the right.
`expressible` per harness is the canonical names that harness can express. A field the target declares
it provably lacks is a gap; a field neither written nor declared absent is `preserved` — untouched and
unclaimed — so a fact added to the vocabulary before its rule lands stays visible instead of reading as
lost. A stored `toolExposure` reaching a Pi plan is the second case today: Pi owns the field, no rule
writes it, and the plan reports it preserved. The table, the seven transforms, the per-tier allowlists, and the credential pointers now live in
one place — **[MCP field tables](../../../docs/mcp-field-tables.md)** — because the code mirrors them:
`src/engine/adapters/mcp-write.ts` holds the rules and per-target absences over the vocabulary in
`mcp-facts.ts`. Change one and the same change belongs in the other.

`extract` and `wrap` are why 07's `{field, targetField, transform}` could not survive: the mapping
is real, mechanical, and **not** a byte copy, and Codex does no interpolation at all — a copied
`"Bearer ${T}"` ships the literal string as a bearer token (ticket 13 §c1).

**1.4 `symlink` (new op).** Allowed only when the source tier and the target tier share the same
scope bucket, the target path is a declared `writePath`, the target does not already exist (else a
07 §6 conflict), and `precondition.digest` is the digest of the **resolved** content. Verification
resolves the link and re-asserts the target pointer or digest. It exists because one physical copy
with live propagation is the dev's stated preference, and it is safe at the OS level: all three read
`AGENTS.md` and `SKILL.md` through plain `open()`, which follows links. Deleting the source would
break the link, so the plan records the source installation id in the op and the engine never
deletes. Symlinked skill **directories** are unverified for all three harnesses — skills therefore
use it only when the source is already a directory both sides can see.

**1.5 Shared paths.** `.agents/skills` (user `~/.agents/skills`, repo `.agents/skills`) and the
project `AGENTS.md` are read by more than one harness — Pi and Codex both name `~/.agents/skills`
explicitly, OpenCode's global discovery list includes it too. Two consequences: the engine computes
`target.alsoReadBy: Harness[]` from the declared tier paths, so a Codex skill write warns "Pi and
OpenCode also load this"; and an Installation found in a shared path carries one row with several
`bindings` (01 already models this), so `list_installations` reports it once, acknowledged as
present for each harness that scans it. A second mirror of the same skill into one of those
harnesses returns 07's `already shared` plan with `writes: []`.

### 2. Per-category tables

**2.1 `mcp`** — `writeAtPointer`. Every row `method: file`. The per-tier allowlist and the notes each
tier carries (Pi's project replace, Codex's trust switch, OpenCode's shadowing layer) are in
[MCP field tables](../../../docs/mcp-field-tables.md#expressible-per-harness-tier).

Retired from 07 §3: Codex `.env` is `env` (carried, not a `shapeOnly` gap), and
`startup_timeout_sec` → OpenCode is `unit`, not a gap. Still a gap: `startup_timeout_sec` → Pi
(`fieldAbsent` — Pi's `timeout` is per-request), and any OpenCode `pool`/`protocol` → Codex/Pi.

**2.2 `skills`** — `copyFile`, or `symlink` when §1.4 holds. No per-field translation: all three
implement the Agent Skills spec.

| harness | tier | target path | expressible |
|---|---|---|---|
| Pi | `pi:user` | `~/.agents/skills/<name>/` (shared) | `name, description, body, files[]` |
| Pi | `pi:project` | `.agents/skills/<name>/` (shared) | same |
| Codex | `codex:user` | `$HOME/.agents/skills/<name>/` (shared) | same |
| Codex | `codex:project` | `<repo>/.agents/skills/<name>/` (shared) | same |
| OpenCode | `oc:user` | `~/.agents/skills/<name>/` (shared; `~/.config/opencode/skills/` only for a deliberately harness-scoped copy) | same |
| OpenCode | `oc:project` | `.agents/skills/<name>/` (shared) | same |

An unknown frontmatter key is `preserved` by the copy, never a gap. `verify.asserts[]` is digest
equality on the written directory.

**2.3 `instructions`** — `writeFile`, plus `symlink` at user scope.

| harness | tier | target | when |
|---|---|---|---|
| Pi | `pi:user` | `~/.pi/agent/AGENTS.md` | real file, or a link to the source under §1.4 |
| Codex | `codex:user` | `$CODEX_HOME/AGENTS.md` | same |
| OpenCode | `oc:user` | `~/.config/opencode/AGENTS.md` | same |
| all three | project | `<repo>/AGENTS.md` | **the same file** — `alreadyPresent`, `writes: []` |

`expressible`: `body`, `path`. Codex caps project docs at `project_doc_max_bytes` (32 KiB) →
`manualSteps[]` when exceeded; OpenCode's `instructions[]` array is not written by the mirror.

**2.4 `hooks`** — three genuinely different methods.

| harness | tier | method | write | manualSteps[] |
|---|---|---|---|---|
| Codex | user, project | file | `writeAtPointer` into `hooks.json` (preferred over inline `[hooks]`) | `[features] hooks = true`; `/hooks` trust review (trust keyed on content hash + positional index) |
| Pi | user, project | file | `writeAtPointer` into `hooks.json` → `hooks.<event>[]` | `pi install npm:@vahor/pi-hooks`; restart Pi |
| OpenCode | user, project | file (generated code) | `writeFile` `.opencode/plugins/<name>.ts` — a `Plugin.define` module, auto-discovered, **no `plugins[]` entry** | restart OpenCode |

Event mapping, direction-declared. Codex's 14 → Pi's 28:

| Codex | Pi (`@vahor/pi-hooks`, 0.0.11) | transform |
|---|---|---|
| `SessionStart` | `session_start` | `rename` |
| `SessionEnd` | `session_shutdown` | `rename` |
| `UserPromptSubmit` | `input` | `rename` |
| `PreToolUse` | `tool_call` | `rename` |
| `PostToolUse` | `tool_result` | `rename` |
| `PreCompact` | `session_before_compact` | `rename` |
| `PostCompact` | `session_compact` | `rename` |
| `PreModelRequest` | `before_provider_request` | `rename` |
| `PostModelRequest` | `after_provider_response` | `rename` |
| `Stop` | `turn_end` | `rename` |
| `PermissionRequest`, `Interrupt`, `SubagentStart`, `SubagentStop` | — | `fieldAbsent` gap |

Codex → OpenCode, generated plugin: only `PreToolUse` → `ctx.tool.hook("execute.before")`,
`PostToolUse` → `ctx.tool.hook("execute.after")`, `PreModelRequest` →
`ctx.session.hook("context")`. The other eleven are `fieldAbsent` gaps. Codex's three-level
`event → matcher group → handlers` shape has no Pi or OpenCode equivalent, so a non-`*` **matcher is
always its own `fieldAbsent` gap** — the hook would otherwise fire on every tool. Codex
`{type: "mcp_tool"}` handlers are `fieldAbsent` on both targets (Pi hooks are shell commands;
OpenCode's generated plugin could call a tool but that is generation, not translation). `timeout` is
`unit` (s → ms) into Pi; `print` / `context` / `cwd` are Pi-only. Every write carrying a command is
`executable: true`, needs its own tick, and can never land `verified` (11 §7).

**OpenCode as a hook target, never a source**: a hook inside an existing plugin is code we cannot
parse, so its `read` verdict is `manual` while `write` is `supported` — per-verb verdicts, which 02
already allows.

### 3. Credential pointers

`credentialPointers` per adapter, values never entering `knownFields`. The per-harness list is in
[MCP field tables](../../../docs/mcp-field-tables.md#credential-pointers).

Pi's `mcp.json` **does** carry an OAuth client secret (`oauth.clientSecret`) — this corrects the
map line that says credentials sit outside Pi's served tables — and OpenCode carries
`oauth.client_secret` too, so the credential set is all three harnesses, not Codex alone.

### 4. Open items for the builder

1. Symlinked skill directories: unverified for all three. Probe before enabling §1.4 for `skills`.
2. `~/.opencode` vs `~/.config/opencode` precedence: unverified, so `oc:home` stays out of the tier
   table.
3. `http_headers_helper` (Codex schema field, no doc): classified `executable` and excluded, never
   written.
4. Codex `auth.idp.client_secret` appeared in the schema; ticket 13 read it, nothing else confirms
   its scope — treat as a credential pointer regardless.

### Amendments to settled tickets

- **02** — no `detectVersion()`; allowlist keyed per `(harness, category)`; `method: file` only;
  `credentialPointers` carries a `kind`.
- **07** — `mapped[]` gains `fields[]` + a seven-value `transform` + optional `template`; `writes[]`
  gains `symlink`; `target` gains `alsoReadBy`; the §3 worked case is corrected twice; a credential
  gap's `replacement` is `dropped`.
- **10** — `bindings.version` dropped.
- **11** — OpenCode hooks move from `categoryAbsent` to generated-plugin `translatable`.
- **BRIEF §9.4** — the `commands` category is out of this slice.
