# The mirror operation and its plan representation

Labels: wayfinder:grilling
Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Define *mirror* as a first-class engine operation (charting Q3) and the shape of its plan.
Decide:

1. The operation vocabulary for a mirror plan — reuse `BRIEF.md` §10 (create dir, copy file or
   directory, symlink, write file, merge config, install package, run approved command, remove
   managed file, manual action, restart/reload). Which does this slice actually need?
2. What every plan must describe (target installation, intended changes, prerequisites,
   expected resulting state, required permissions, potential conflicts, verification steps,
   rollback feasibility — `BRIEF.md` §10).
3. How "equivalent" is expressed when config must be **translated** rather than copied, and how
   an adapter's unsupported/partial/manual verdict appears in the plan.
4. How a plan is validated before execution, and its serialization (JSON).
5. Whether plan → apply → verify are three distinct MCP-visible steps.

Stress-test: mirroring an MCP server from Codex to OpenCode where a field is unknown to the
target. Sharpen "equivalent" into a precise canonical term.

**Zoom:** `BRIEF.md` §9.4, §10. Builds on: [Canonical domain model for mirroring](./01-canonical-domain-model.md), [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md). Unblocks: [Permission, approval, and safety model for MCP mutations](./08-permission-and-approval-model.md), [Minimal MCP tool surface and a worked mirror example](./09-mcp-tool-surface.md).

**Output:** the mirror operation + plan schema in the handoff spec.

## Answer

Settled with the dev over three grilling rounds on 2026-11-05.

### 1. Operation vocabulary — four ops, executable code stays out

BRIEF §10 lists ten operations. Combined with ticket 02's `writes[]`
(`{file,pointer,value} | {command}`) and ticket 01's "already shared" rule, seven of the ten
collapse or drop. The slice has **four ops and one non-op field**:

| Op | Meaning |
|---|---|
| `writeAtPointer` | pointer-addressed write into an existing `json` / `jsonc` / `toml` file, using the adapter's declared pointer syntax. This is BRIEF's *merge configuration*: the pointer is the merge unit |
| `writeFile` | whole-file text write — `AGENTS.md`, `SKILL.md` + frontmatter, command markdown |
| `copyFile` | byte-identical copy — skill `scripts/`, assets, plugin directories. Separate from `writeFile` because it is not diffable and because a verbatim executable landing on disk has to be visible as such |
| `runCommand` | an adapter-declared command template with validated arguments, never a free shell |
| `manualSteps[]` | a plan-level list, not an op (see §5) |

Dropped, with reasons:

- **create directory** — folded into `writeFile` / `copyFile`; the preview shows the new directory,
  it is not its own op.
- **create symlink** — ticket 01 already rules that a location two harnesses read is *already
  shared*, reported and never created. A symlink would also make one file two Installations.
- **install package** — **plugins are not an op in this slice.** All three harnesses do have them
  (Pi `settings.json` `packages: []` + `pi install`; Codex `codex plugin add`; OpenCode `plugins[]`
  + `opencode plugin add`, npm/git specs only), and every install path executes third-party code.
  A plugin mirror is reported as a `manual` gap naming the target harness's own install command.
- **remove managed file** — no removal in this slice. An existing target is a conflict (§6), never
  a delete.
- **restart or reload** — a `manualStep` ("restart Pi to load"), never machine-executed.

Hooks follow the same logic as plugins: they are code in Pi and OpenCode (Pi has no hook config at
all), so a hook mirror is `notTranslatable` or `manual`, never a write. The hooks-as-code approval
question stays with [Capability-gap semantics](./11-capability-gap-semantics.md).

### 2. The plan body

A plan is one JSON document. Every one of BRIEF §10's eight required items maps to a field — none
is prose:

```jsonc
{ "planId": "sha256:…",        // §4
  "createdAt": "…", "toolVersion": "…", "kind": "mirror",

  "source": { installationId, harness, tierId, scope, nativeLocation, knownFields, contentDigest },
  "target": { harness, tierId, scope, nativeLocation },     // "target installation"

  "equivalence": { carried[], mapped[{field,targetField,transform}],
                   gaps[{field,reason,replacement}], preserved[] },   // §3

  "prerequisites": [ … ],                 // source readable, harness installed, target path resolvable
  "permissions": { tierWritability, elevationRequired, trust },
  "conflicts": [ … ],                     // §6 — "potential conflicts"

  "writes": [ { op, file, pointer, value | content | source,
                precondition: { exists, digest },
                reversible, priorValue } ],

  "manualSteps": [ { step, why } ],       // §5
  "verify": { asserts: [ { file, pointer, equals } ] } }        // "expected resulting state"
```

- **Expected resulting state is `verify.asserts[]` only** — pointer assertions, never a whole-file
  copy. This is also what keeps the Codex secret hazard out: `mcp_servers.<id>.oauth.client_secret`
  can sit inside `config.toml`, and asserting one pointer never carries it.
- **Rollback: described, never executed.** Each op carries `reversible` and `priorValue` (prior
  bytes / prior pointer value, captured at plan time, held in the blob); `runCommand` is always
  `reversible: false`. Nothing suggests an undo path — the map rules rollback execution out of
  scope. Note this also drops BRIEF's "keep backups before modifying files": prior values live in
  the plan, so no `.bak` files are written.
- **`knownFields` must be secret-free by construction.** A field that holds a credential is never
  in the adapter's `expressible` allowlist; it becomes a `gap` with `reason: credential` and is
  always a `manualStep`. Otherwise the plan would copy the secret that the whole-file-copy rule
  already forbids (BRIEF §1, §10 "never copy credentials").

### 3. "Equivalent" = field-equivalent modulo declared gaps

> **Field-equivalence.** A mirror is *equivalent* when the source Installation's `knownFields` are
> fully partitioned into what the target carries and what it provably cannot, and a human approved
> that partition. Equivalence is enumerable and assertable on disk. It is never a claim that the
> two harnesses behave the same.

`equivalence` is that partition: `carried[]` (translated 1:1), `mapped[]` (renamed / inverted /
converted, with the transform shown), `gaps[]` (unexpressible, with `replacement`), `preserved[]`
(unknown source fields left untouched in place).

Worked stress case — Codex `mcp_servers.serena` → OpenCode:

- `command` / `args` / `env` → `carried`
- `enabled` → `mapped` to OpenCode's inverted `disabled`
- `startup_timeout_sec` → `gaps` (dropped; OpenCode has no equivalent)
- `.env` sub-table → `gaps` (Codex-only shape)
- anything not in OpenCode's allowlist → `preserved`, untouched

Verification asserts only `carried ∪ mapped`. Nothing claims the timeout behaviour survived.

Rejected: **behavioural equivalence** (not assertable without launching a harness, and a dropped
timeout is not the same behaviour even when the file looks right) and **upstream-reference
equivalence** (only covers package-style installs, not this field-level case).

### 4. Stateless, content-addressed plan

There is **no plan store**. `plan` writes nothing and returns the plan document; `apply` takes that
same document back. Two things carry the safety that a stored record would otherwise provide:

- **`planId` = sha256 over the canonical JSON of the plan body.** Self-identifying, and it is the
  value `provenance.planId` records (ticket 01). `apply` recomputes and rejects a mismatch.
- **Per-write `precondition: { exists, digest }`** — the target file's digest as read *at plan
  time*. `apply` recomputes each; any mismatch → `stale`, refuse, re-plan. Same guard a stored
  record would give, carried instead of looked up.

`apply` executes exactly the given writes — it never re-derives the plan from current state.

### 5. `manualSteps[]` alongside `writes[]` — amends ticket 02

Ticket 02's `translate()` union is either/or: `{kind:'manual'}` means nothing can be written. But
Codex project-scope MCP is a **writable file whose Installation stays inert until
`trust_level = "trusted"` exists in the *user* config**, and OpenCode's `/etc/opencode` can shadow a
correct project write. Both are write-then-human.

Until ticket 02's answer is amended, the plan carries the distinction:

- `{kind:'manual'}` → **no writes at all** (plugins, hooks, credentials).
- `{kind:'translatable', …}` + non-empty `manualSteps[]` → **write these files, then a human must do
  this**. Empty is normal and never omitted.

Amendment to apply to ticket 02: `translate()`'s `translatable` arm gains `manualSteps[]` on the
plan, and `manual` keeps its strict "nothing executable" meaning.

### 6. Conflicts — refuse by default, replace only on an explicit ask

The target Installation already existing is the common case, not an error. Three outcomes:

- **`alreadyPresent`** — target `knownFields` equal what the plan would write. No writes; the plan
  reports it as redundant.
- **`already shared`** — target native location equals source (a `~/.agents/skills/…` file). No
  writes (ticket 01's rule).
- **`conflict`** — exists and differs (including per-pointer partial overlap). `conflicts[]` carries
  both the current target value and the proposed value, and `writes[]` is populated but gated:
  `apply` requires `onConflict: 'replace' | 'abort'`, default `abort`. Nothing is overwritten
  silently, and the approval names the conflict it overrides.

Merging is not a fourth outcome: at leaf-pointer granularity the pointer *is* the merge unit, so
partial overlap is just several pointers, some conflicting.

A config edit at the same location is drift on the same Installation, not a new row (ticket 01).

### 7. Verify — a re-read, never a harness probe

`verify` re-reads the write targets, parses them, and evaluates `asserts[]`. No harness is launched
in this slice.

| Outcome | Condition |
|---|---|
| `verified` | every assert holds **and** `manualSteps[]` is empty |
| `unverified` | every assert holds, `manualSteps[]` remains — re-reported verbatim, so the human sees why it stopped short |
| `failed` | any assert misses |

Verify lives on the *result*, never inside the plan (amends CONTEXT.md's Plan definition); the
binding's `verificationStatus` records it.

### 8. Validation before apply

`apply` validates, in order, and refuses at the first failure:

1. **Schema** — the document is a typed plan (zod-style). A hand-edited blob fails closed.
2. **Integrity** — recomputed `planId` equals the document's.
3. **Preconditions** — every `precondition.digest` still matches the file on disk.
4. **Tier writability** — the target tier's declared writability is `writable`. `elevationRequired`
   and `managed` tiers are refused outright; this slice does not elevate.
5. **Conflict gate** — if `conflicts[]` is non-empty, `onConflict` must be explicitly `replace`.

Serialization is plain JSON with the field names in §2, and the plan renders to a human diff by
comparing `writes[]` values against `priorValue` / the current file — never by printing a whole
file.

### 9. One shape, never two

There is no separate error channel. `notTranslatable`, `alreadyPresent`, and `already shared` all
return a **plan with `writes: []`** and the reason in `equivalence.gaps[]` or `conflicts[]`. A caller
reads one artefact type and always gets one.

### Consequences for the remaining tickets

- [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md): one
  amendment — `manualSteps[]` (see §5). Otherwise the contract is exactly the plan's inputs.
- [Permission, approval, and safety model for MCP mutations](./08-permission-and-approval-model.md):
  approval covers a **plan hash plus an explicit `onConflict`**, not a prose summary, and a stale
  plan must be re-planned rather than re-approved.
- [Minimal MCP tool surface and a worked mirror example](./09-mcp-tool-surface.md): the tools have to
  hand back and accept the whole plan document; there is no plan id to fetch later.
- [Capability-gap semantics](./11-capability-gap-semantics.md): severity now applies to
  `equivalence.gaps[]` and `conflicts[]`. Credential gaps are always `manual`, never
  `translatable` (§2).
- [Storage and migration decision](./10-storage-and-migration.md): no plan table is needed; the
  provenance row records a hash.
- New fog graduated: the per-category `expressible` allowlists are now ticketable (see the map).

