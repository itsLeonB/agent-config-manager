# Spec: agent-driven cross-harness config mirroring (first slice)

Status: ready-for-agent
Source: `.scratch/acm-rearchitecture/map.md` and its 15 resolved tickets; ADRs 0001–0004.

## Problem Statement

Today the repo is a read-only Claude Code dashboard. An AI agent working in one harness has no way
to take a component that is already configured correctly somewhere — an MCP server, a skill, an
`AGENTS.md`, a hook — and set up the equivalent in another harness. The agent instead rewrites
config files by hand, from memory, per harness: three different formats (JSON, JSONC, TOML), three
different addressing conventions, inverted booleans, `s` vs `ms` timeouts, and harnesses that do
not interpolate `${VAR}` at all so a copied header ships a literal string as a bearer token.

That hand work is where it fails. The agent cannot enumerate what it dropped, so nobody learns the
Codex `startup_timeout_sec` never made it. It cannot tell a conflict from an empty slot, so an
existing entry gets silently replaced. It cannot see that a value is a credential, so a secret ends
up in an agent's context or in a second file. And once the write lands, nothing re-reads the target
to say whether it actually holds what was intended.

## Solution

One installed `acm` binary whose engine exposes five MCP tools to an agent:

- `list_installations` / `inspect_installation` — what exists, where, in which harness and tier,
  secret-free.
- `plan_mirror` — given a source installation and a target harness+tier, return a complete plan
  document: the source's known fields partitioned into carried / mapped / provably-dropped, the
  exact native addresses to write, a target diff, the preconditions each write needs, the manual
  steps a human must take, and a `safe | risky` grade.
- `apply_plan` / `verify_plan` — execute exactly that document under graded consent, then re-read
  the targets and assert what landed.

Native formats stay native (`mcp.json`, `config.toml`, `opencode.json`, `hooks.json`, `SKILL.md`,
`AGENTS.md`); nothing is normalised into a universal config file. Nothing is written before
approval, no shell command ever runs, credentials never leave the process, and unknown fields in a
target file are preserved in place.

Adapters for this slice: **Pi, Codex, OpenCode**. Claude Code is deliberately out.

## User Stories

### Discover and inventory

1. As an AI agent, I want to list installations with their category, name, harness, tier, and scope,
   so that I can find the component a human pointed at.
2. As an AI agent, I want to filter that list by category, harness, and scope, so that I do not pull
   a whole inventory into my context to answer one question.
3. As an AI agent, I want to force a fresh scan, so that I can trust the inventory after a human
   edited a config file outside ACM.
4. As an AI agent, I want each harness row to tell me which tiers exist and which of them are
   writable, so that I only ever propose a target that can receive a write.
5. As an AI agent, I want a per-tier health verdict (`ok` / `unreadable`), so that I know when a
   tier's config failed to parse and the inventory is incomplete rather than smaller.

### Inspect before planning

6. As an AI agent, I want to inspect one installation and see only its adapter-understood fields,
   so that no secret and no unrelated part of the native file enters my context.
7. As an AI agent, I want to see its native location, content digest, bindings, and provenance, so
   that I can tell a hand-edited entry from a previously mirrored one.
8. As an AI agent, I want to know which other harnesses also read the same file, so that I can warn
   a human that a write in one place changes behaviour in three.

### Plan the mirror

9. As a human, I want the agent to produce a complete plan for one mirror and write nothing yet, so
   that I review a change instead of discovering it.
10. As a human, I want the plan to show each source field as carried, mapped (and how), dropped (and
    why), or preserved, so that "equivalent" is enumerable instead of a claim.
11. As a human, I want to see only the target excerpt and a diff, never a whole-file copy, so that I
    can read the change and no secret is duplicated into a plan.
12. As a human, I want every manual step listed verbatim (log in to OAuth, trust a project,
    install a bridge, restart the harness), so that I know what the agent could not do for me.
13. As an AI agent, I want the plan's grade (`safe` / `risky`) before applying, so that I can tell a
    human a dialog will appear.
14. As an AI agent, I want the plan's own hash and per-file preconditions inside the document, so
    that the document I carry cannot drift out of sync with the disk without saying so.

### Apply and verify

15. As an AI agent, I want to apply exactly the plan I was given, so that apply can never re-derive
    a different change from current state.
16. As an AI agent, I want `stale` when any target file changed after planning, so that I re-plan
    instead of overwriting a human's edit.
17. As an AI agent, I want `partial` with the writes that landed and the one that failed, so that
    the human learns the real state without rollback.
18. As an AI agent, I want `busy` when another apply is in flight, so that two agents never
    interleave writes into the same store.
19. As an AI agent, I want to verify a plan's assertions later, after a human completed a manual
    step, so that "unverified because pending" can become "verified".
20. As an AI agent, I want a plan with pending manual steps to land `unverified` rather than
    `verified`, so that nothing claims success it cannot assert.

### Consent and safety

21. As a human, I want risky writes (executable content, conflicts, secret values, new directories,
    copies) to need my explicit per-plan answer in my client's own dialog, so that the engine never
    acts on an assertion.
22. As a human on a client without elicitation, I want the risky writes returned as manual steps and
    the safe remainder applied, so that the slice still works without weakening the gate.
23. As a human, I want each risk flag on a plan to have its own tick, so that approving a config
    write is not the same act as approving executable content.
24. As a security reviewer, I want writes confined to adapter-declared paths, resolving without
    symlinks, to regular files under `$HOME` or the project root, so that a plan cannot be aimed at
    `~/.ssh`.
25. As a security reviewer, I want elevated and root-owned tiers refused rather than turned into a
    sudo line for a human to paste, so that ACM never escalates.
26. As a security reviewer, I want no command execution in this slice at all, so that "no
    unrestricted shell execution" holds by construction rather than by audit.
27. As a maintainer, I want no `--yes`, no automation policy, no env var, and no session-wide
    approval that skips a gate, so that consent has exactly one shape.

### Secrets

28. As a human, I want a credential value to stop the plan with a migrate-out recommendation for
    *that target harness*, so that the fix is to remove the secret, not to move it.
29. As a human, I want the alternative of a blind copy where the value never enters the plan
    document or my agent's context, so that a legacy secret can still be moved locally.
30. As a human, I want an explicit risk-read opt-in per write if I accept the value entering my
    agent's context, so that the dangerous path exists but is never the default.
31. As a security reviewer, I want hash-shaped values and `trusted_hash` digests never classified as
    secrets, so that the classifier does not cry wolf on every Codex hook entry.
32. As a security reviewer, I want a `${VAR}` reference to be classified clean but Pi's `!command`
    retrieval flagged executable, so that indirection is encouraged and code execution is gated.
33. As a human, I want the OAuth *entry* mirrored and the grant never mirrored, so that each harness
    gets its own login step instead of a stolen token.

### Conflicts

34. As a human, I want a target that already matches the plan to come back as `alreadyPresent` with
    nothing to write, so that re-running a mirror is harmless.
35. As a human, I want a target location identical to the source to come back as `already shared`
    with nothing to write, so that `.agents/skills` is not copied onto itself.
36. As a human, I want a differing target to be a conflict by default, showing both values, so that
    nothing is overwritten silently.
37. As an AI agent, I want to pass `onConflict: replace` deliberately and only then, so that
    overriding a human edit is a named act.

### Categories

38. As an AI agent, I want an MCP server mirrored field by field across JSON, JSONC, and TOML, so
    that `enabled`/`disabled`, `s`/`ms`, and `command + args` vs `command[]` are translated rather
    than guessed.
39. As an AI agent, I want a skill mirrored once into the shared `.agents/skills` location that all
    three harnesses read, so that the same skill is not three copies.
40. As an AI agent, I want `AGENTS.md` mirrored per harness at user scope and recognised as already
    present at project scope, so that one project file is not duplicated.
41. As an AI agent, I want a hook mirrored as native `hooks.json` into Codex and Pi, so that the two
    harnesses that have a real declarative bridge get a real write.
42. As an AI agent, I want a Codex hook translated into generated OpenCode plugin code, flagged
    executable and never verified, so that the one target without hook config still has a path.
43. As a human, I want a category the target cannot express at all to come back as a plan with no
    writes and one `categoryAbsent` gap, so that a refusal is still one artefact type.
44. As a human, I want plugins reported as a manual step naming the target's own install command, so
    that third-party code execution is never something ACM performs.

### CLI and bootstrap

45. As a human, I want every MCP operation available as an `acm` subcommand, so that I can do the
    same thing without an agent.
46. As a human, I want `acm setup` to install ACM into the three harnesses through the same
    plan/apply path, so that ACM's own install is not a second mutation route.
47. As a human, I want the harness entry to be an absolute binary path with no `cwd`, so that a
    harness spawning it with a different `PATH` still finds it.
48. As a harvester of ACM's own output, I want ACM to appear in `list_installations` like any other
    MCP server afterwards, so that nothing special-cases it.

### Durability and audit

49. As a maintainer, I want every apply recorded with its plan hash, grade, outcome, and landed
    writes, so that there is a history even though plans are not stored.
50. As a maintainer, I want discovery to tombstone vanished installations instead of deleting them,
    so that provenance edges never dangle.
51. As a maintainer, I want an unreadable tier to tombstone nothing, so that one malformed
    `opencode.json` cannot empty the inventory.
52. As a maintainer, I want the existing dashboard's `snapshots` and `config` rows untouched, so the
    web page keeps working through this change.

## Implementation Decisions

Decisions below are settled by the resolved tickets; the ticket numbers are noted where a reader may
want the reasoning. Type shapes and the schema are reproduced because they encode decisions that
prose would blur (they come from the grilling tickets, not from code).

### 1. Slice boundary

- Harnesses: Pi, Codex, OpenCode. Claude Code is out (ADR 0002 keeps cloud config out too).
- Categories: `mcp`, `skills`, `instructions`, `hooks`. **`commands` is dropped** — Codex has no
  such surface and the dev does not use them.
- Mirror targets are writable tiers only: `pi:user`, `pi:project`, `codex:user`, `codex:project`,
  `oc:user`, `oc:project`. Not targets: Codex `profile` (launch-time only, `notState`), OpenCode
  `/etc/opencode` (`elevationRequired`), OpenCode `~/.opencode` (real but undocumented; precedence
  against `~/.config/opencode` unverified).
- No UI. The existing TanStack dashboard stays as it is; it reads Claude snapshots the engine never
  writes.

### 2. Domain model

Vocabulary lives in `CONTEXT.md` and must be used in code, tests, and tool output. In brief:

- **Component**: `(category, normalisedName)` plus aliases. Renames are explicit aliases, never
  fuzzy matching.
- **Installation**: `(category, name, scopeBucket, nativeFile, nativePointer)`; id is a hash of that
  tuple so re-discovery upserts and a plan can name a source across processes.
- **Binding**: one harness's claim, carrying `harness`, `tierId`, `method`, `verificationStatus`
  (`unverified | verified | failed | notApplicable`). No version field.
- **Tier**: adapter-declared `{id, nativeLabel, rank, scopeBucket, configPaths, writability}`, with
  `configPaths` the candidate files the tier's config can live in (OpenCode accepts `.json` or
  `.jsonc`);
  writability `writable | elevationRequired | notState | managed`. **Scope bucket** is the derived
  four-value enum (`user | project | project-local | system`); nothing derives a tier from a bucket
  (ADR 0001).
- **Tier health**: `ok | unreadable` per `(harness, tier)`, measured, never assumed.
- **Known fields**: only adapter-understood fields, never a copy of the native file.

### 3. Adapter contract

Descriptor plus optional per-category handlers, checked for agreement at load (a category claimed in
the table without a handler, or the reverse, fails at startup).

```ts
type CapabilityRow = {
  category: Category
  tierId: string
  read:   'supported' | 'partial' | 'unsupported' | Manual
  write:  'supported' | 'partial' | 'unsupported' | Manual
  verify: 'supported' | Manual
  method: { kind: 'file'; format: Format } | { kind: 'cli'; commandTemplate: string } | { kind: 'none' }
  expressible: string[]            // canonical field allowlist; unlisted ⇒ gap (fails closed)
}
type Adapter = {
  descriptor: {
    harness: HarnessId
    tiers: Tier[]
    formats: { match: string; format: Format; pointerSyntax: string }[]
    capability: (category, tierId) => CapabilityRow
    credentialPointers: { pointer: string; kind: 'leaf' | 'file' }[]
    writePaths: Record<'user' | 'project', string[]>     // exact files; directories only for copyFile
    healthProbe?: { command: string; parse: ... }        // OpenCode only
  }
  health(): Promise<Record<string, 'ok' | 'unreadable'>>
  handlers: Partial<Record<Category, CategoryHandler>>
}
type Format = 'json' | 'jsonc' | 'toml' | 'markdown-frontmatter' | 'directory'
```

- **No version surface.** `detectVersion()` is deleted; the adapters target the latest release only
  and nothing gates on a detected version. A mismatch surfaces as a failed write or a failed
  verification, never as an adapter refusal.
- `method` is `file` on **every writable row**. `cli` stays in the vocabulary, unused: `codex mcp
  add` cannot target project scope and re-serialises the whole `mcp_servers` table (killing comments
  in untouched sibling entries), `pi mcp add` drops fields it has no flag for, and OpenCode's writer
  emits V2 shape into V1 files. **No write in this slice runs a harness CLI.**
- `translate()` returns facts, never severity:

```ts
translate(source, target: { harness, tierId }) →
  | { kind: 'notTranslatable', gaps: Gap[] }                       // writes are always []
  | { kind: 'manual', manualSteps: Step[] }                        // nothing writable at all
  | { kind: 'translatable',
      knownFields: Record<string, Json>,
      gaps: Gap[],
      writes: NativeWrite[],
      preserved: string[],
      manualSteps: Step[] }                                        // always present, may be empty
```

- `Gap = { field, reason, replacement? }` with `reason` a closed five (`fieldAbsent`, `shapeOnly`,
  `credential`, `executable`, `categoryAbsent`) and `replacement` `renamed | inverted | dropped`.
  A credential gap's replacement is always `dropped`; the migrate-out instruction lives in its
  mandatory manual step. A sixth reason is a schema change, and a test asserts every reason maps to
  one of three dispositions.
- `read` returns parsed native facts or a parse error keyed to the tier; it is pure over bytes so it
  can be tested without a filesystem.

### 4. The plan document

One JSON document, stateless, content-addressed. Nothing is stored; the agent carries it.

```jsonc
{ "planId": "sha256:…",            // hash of the canonical JSON of the body
  "createdAt": "…", "toolVersion": "…", "kind": "mirror",
  "source": { installationId, harness, tierId, scope, nativeLocation, knownFields, contentDigest },
  "target": { harness, tierId, scope, nativeLocation, alsoReadBy: Harness[] },
  "equivalence": { carried[], mapped[{ transform, fields[], targetField, template? }],
                   gaps[{ field, reason, replacement }], preserved[] },
  "prerequisites": [ … ],
  "permissions": { tierWritability, elevationRequired, trust },
  "conflicts": [ { file, pointer, current, proposed } ],
  "security": { grade: "safe" | "risky",
                secrets: [{ pointer, verdict }],
                executables: [{ file, why }] },
  "writes": [ { op, file, pointer, value | content | source,
                precondition: { exists, digest },
                reversible, priorValue,
                executable, secretValues, irreversible } ],
  "manualSteps": [ { step, why } ],
  "verify": { asserts: [ { file, pointer, equals } ] } }
```

- Ops: `writeAtPointer`, `writeFile`, `copyFile`, `symlink`, plus `runCommand` in the vocabulary with
  an **empty allowlist** that the engine refuses. No create-directory, no package install, no
  removal, no restart.
- `symlink` is allowed only when source and target share a scope bucket, the target path is declared,
  nothing exists at the target, and the precondition digest is of the resolved content. Verification
  resolves the link. Skills use it only when the source is already a directory both harnesses read.
- Expected resulting state is `verify.asserts[]` only — pointer assertions, never a whole-file copy.
- Rollback is described (`reversible`, `priorValue`), never executed. `runCommand` is always
  irreversible. No `.bak` files.
- `apply` validates in order and refuses at the first failure: plan schema, recomputed `planId`,
  every precondition digest, target tier writability, conflict gate. It executes exactly the given
  writes and never re-derives them.
- Verification result: `verified` when every assert holds and `manualSteps` is empty; `unverified`
  when asserts hold but manual steps remain (reported verbatim); `failed` when any assert misses. A
  plan containing an executable write can never land `verified`. Verify never launches a harness.
- One artefact type, no error channel: `notTranslatable`, `alreadyPresent`, and `already shared` all
  return a plan with `writes: []` and the reason in gaps or conflicts.

### 5. Consent, containment, and refusal

Consent is **graded by the engine**, because engine and agent run as the same OS user and no channel
the engine controls can distinguish a human's approval from an agent's assertion. Only MCP
elicitation escapes that, and Pi 1.5.0 has no elicitation.

- `safe`: every write is a pointer or file write into a pre-existing file, inside declared paths, no
  risk flag, no conflict, no credential path. Applies on any client; consent recorded
  `client-policy`, meaning the harness's own permission configuration authorised it.
- `risky`: any executable / secret-values / irreversible write, any `copyFile` or `symlink`, any new
  directory, any conflict, any elevation. Needs one elicitation per apply, plus one tick per risk
  flag. On a client without elicitation the risky writes alone return as `manualSteps` and the safe
  remainder still applies.

Four gates, in order: plan is read-only → graded consent → preflight + containment → risk-flag ticks.
Preflight covers every write before the first byte; a mid-plan failure stops the run and returns
`partial` with `landed[]` and `failed`. One in-flight apply per store; a concurrent call returns
`busy`.

Containment checks, per write: path inside declared `writePaths` for that `(category, tier)`; deepest
existing ancestor's realpath equals the lexical path (no symlink anywhere), target a regular file if
it exists; resolved path under `$HOME` or the project root; not a credential location (`~/.ssh`,
`~/.gnupg`, `~/.aws`, `~/.config/gh`, and each harness's own auth store). `plan` runs the same checks
and reports the result so a doomed plan never reaches a human.

Prohibited: automation policy, blanket approval, `--yes`, an env var that skips a gate, session-wide
consent, standing consent per path or adapter.

### 6. Secret handling

A deterministic classifier runs in-engine over source bytes before any value reaches known fields, a
plan, a tool result, an elicitation form, or a log line. Ordered, first match wins:

| # | Rule | Verdict |
|---|---|---|
| 0 | pointer in the adapter's `credentialPointers` | `secret` |
| 1 | env reference (`${V}`, `{env:V}`, `$V`, `Bearer ${V}`) or `!command` | `clean` (`!command` is executable) |
| 2 | length-anchored provider pattern (`sk-…`, `ghp_…`, `AKIA…`, `xox…`, JWT, `npm_…`, …) | `secret` |
| 3 | PEM private-key block | `secret` |
| 4 | hash shape (hex ≥32, UUID, `sha256:`/`sha1:`/`sha512:`, ULID) **and** pointer name matches `hash\|digest\|checksum\|fingerprint\|id$` | `clean` |
| 5 | pointer name matches key/token/secret/password/credential/bearer/authorization and length ≥ 8 | `suspect` |
| 6 | base64 gate (≥20 chars, has digit and upper case) **and** entropy ≥ 4.4 | `suspect` |
| 7 | pure hex ≥32, entropy ≥ 3.0, pointer name from rule 5 | `suspect` |
| 8 | otherwise | `clean` |

Amended while building ticket 18: rule 1 is evaluated **before** rule 0, because a reference is
secret-free by construction and withholding `${VAR}` at `env.*` would erase the one form a human is
meant to read; and rule 5 leaves long hex to rule 7, so a digest under a credential name is judged on
entropy rather than its name. A name-valued fact (`bearerTokenEnvVar`, `envPassthrough` entries) is a
secret-free form, not a secret.

Entropy is split by alphabet because hex caps at 4.0 and base64 keys sit at 4.33–4.75; one threshold
either flags every hash or misses every hex key. Rule 4 is mandatory: 14 of 49 entropy hits on the
real corpus were Codex `hooks.state.*.trusted_hash` digests.

A `suspect` or `secret` pointer stops the plan for that line and offers, in order: **migrate out**
(gap `credential` + a manual step naming the target's own indirection mechanism), **blind copy** (the
engine reads source and writes target itself; the plan carries a sha256, not the value; `apply`
re-reads the source), or **risk-read** (human ticks `secretValues`, off by default, per write).
Verdicts are recomputed at apply time, so a source that grew a secret between plan and apply is
`stale`.

Interpolation is **not portable** and the adapters must own it: Pi supports `${VAR}` and `!command`;
Codex supports **no** interpolation (a `$VAR` is passed through verbatim, so a copied
`Bearer ${T}` ships the literal string as a token) and needs `bearer_token_env_var`, `env_vars`, or
`env_http_headers`; OpenCode supports `{env:VAR}` and `{file:path}`, and an undefined reference is a
silent empty string. OAuth: mirror the entry (`url`, `command`, `args`, `env`, `headers`, policy
flags), never the grant; each target gets a manual step naming its own login command. Pi's
`oauth.clientSecret` and OpenCode's `oauth.client_secret` are credential pointers exactly as Codex's
is.

`credentialPointers` carry a kind, because three categories point at whole files (`SKILL.md`,
`AGENTS.md`, hook config, generated plugin code) rather than typed leaves.

### 7. Translation rules per category

**MCP** — `writeAtPointer`, `method: file` everywhere.

The canonical vocabulary with each harness's native address, the seven transforms with their
instances, the per-tier allowlists, and the credential pointers are tabulated once in
[docs/mcp-field-tables.md](../../docs/mcp-field-tables.md) and mirrored by
`src/engine/adapters/mcp-write.ts`.

Seven transforms, closed set: `rename` (`env`→`environment`), `invert` (`enabled`⇄`disabled`),
`concat` (`command`+`args`→`command[]`), `unit` (s⇄ms), `infer` (`type` from which fields exist),
`extract` (regex with one capture: Pi `headers.Authorization: "Bearer ${T}"` → Codex
`bearer_token_env_var: "T"`), `wrap` (bare identifier → interpolation reference; the reverse of
`extract`, plus `env_vars: ["K"]` → `env.K`). `mapped[]` entries name the transform, the source
fields it consumes, the target field, and an optional template, because several mappings are
many-to-one.

Points that must not be lost: Pi project MCP **replaces** the user entry of the same name unless the
entry carries no command/url/type, so a Pi write carries the full entry. OpenCode replaces whole
entries and has no field patch, so an OpenCode write is complete. Codex merges per field. Codex
project scope is inert until the *user* config trusts the path → manual step. OpenCode's
`/etc/opencode` can outrank a correct project write → manual step. Codex `.env` is plain `env` and
`startup_timeout_sec` → OpenCode is a `unit` map, not a gap; `startup_timeout_sec` → Pi is
`fieldAbsent`.

Retired with the map: unknown frontmatter keys are preserved by a file copy, not a gap.

**Skills** — `copyFile`, or `symlink` under the rule above. All three implement the Agent Skills
spec, so the target is the shared `.agents/skills/<name>/` at both scopes for all three harnesses.
One copy, several bindings; a second mirror into a harness that already reads it is `already shared`
with no writes. `verify` asserts digest equality on the written directory. A harness-scoped copy
(under the harness's own config dir) is possible but is a deliberate different target, not the
default.

**Instructions** — `writeFile` at user scope into each harness's own `AGENTS.md`, optionally a
symlink to the source. Project scope is `<repo>/AGENTS.md` — **the same file for all three**, so it
returns `alreadyPresent` with no writes. `expressible`: `body`, `path`. Codex caps project docs
(`project_doc_max_bytes`) → manual step when exceeded. OpenCode's `instructions[]` array is not
written by a mirror.

**Hooks** — three different methods, decided by whether a real bridge exists:

| Target | Method | Write | Manual steps |
|---|---|---|---|
| Codex | file | `writeAtPointer` into `hooks.json` | enable `[features] hooks`; `/hooks` trust review (trust is keyed on content hash + positional index) |
| Pi | file | `writeAtPointer` into `hooks.json` → `hooks.<event>[]` | `pi install npm:@vahor/pi-hooks`; restart Pi |
| OpenCode | generated code | `writeFile` a `Plugin.define` module into the project's plugins dir (auto-discovered, no `plugins[]` entry) | restart OpenCode |

Event names are renamed, not copied, and any event with no counterpart is a `fieldAbsent` gap. Codex's
three-level `event → matcher group → handlers` shape has no equivalent on either target, so a
non-`*` matcher is always its own gap. Every write carrying a command is `executable`, needs its own
tick, and can never land `verified`. OpenCode is a hook target but never a hook source (a hook inside
an existing plugin is code we cannot parse): its `read` verdict is `manual` while `write` is
supported — per-verb verdicts.

**Plugins** are not a category in this slice. A plugin mirror is a manual step naming the target
harness's own install command, because every install path executes third-party code.

### 8. Storage

One SQLite file, one owner (ADR 0003). The existing store module keeps its exclusive claim on
`node:sqlite` and gains a `PRAGMA user_version` migration runner; migration 1 is pure
`CREATE TABLE IF NOT EXISTS`, so a fresh clone and an existing database land in the same place.
The `snapshots` / `config` API is untouched, so the dashboard and settings need no edits.

Four canonical tables join the two existing ones: `installations` (identity tuple + aliases +
native location + `content_digest` + `known_fields` + provenance + first/last seen + `removed_at`),
`bindings` (PK `installation_id, harness, tier_id`; `method`, `verification_status`),
`operations` (id, at, kind, plan id, grade, outcome, source/target installation, landed writes as
JSON), and `tier_health` (PK `harness, tier_id`; status, detail, at). Ids are hashes of the identity
tuple, never autoincrement. JSON columns hold aliases, known fields, and landed writes because none
is queried field-wise.

No `plans` table (a plan is stateless; only its hash persists on the target's provenance and on the
operation row), no `components` table (category, name, and aliases inline), no historical
verifications table (the binding holds the latest status). Legacy Claude snapshot rows and any stale
cloud rows are read by nobody and deleted by nobody.

The store is now written by more than one process (MCP server, CLI, and the existing scanner), so
**every write transaction opens with `BEGIN IMMEDIATE`** and the migration guard runs inside one.
WAL and `busy_timeout` stay.

### 9. Inventory and discovery

The store **is** the inventory. Discovery upserts installations and bindings, stamps `last_seen_at`,
and writes `content_digest`, so a hand edit is drift on the same row. An installation absent from an
`ok` tier's result gets `removed_at`; nothing is deleted. An `unreadable` tier tombstones nothing.

Freshness is a parameter, not a mode: a read returns the stored snapshot with its `scannedAt`, and
`fresh: true` re-runs discovery first — the same path the interval loop uses. Staleness can never
reach a write regardless, because planning re-reads the source for its digest and apply re-reads
every target for its preconditions.

Tier health is measured. OpenCode cannot be made to fail on invalid config (probed: every subcommand
exits 0 with empty stderr, and no env var or log level changes that), so its health comes from one
probe per discovery pass —
`OPENCODE_CONFIG=<file> opencode debug config --standalone --print-logs --log-level warn` — whose
stderr line per problem carries `kind=invalid` and `source=<file>`, mapping diagnostics back to
tiers. Gate order cheapest first: local parse fails ⇒ `unreadable` with no spawn; parse succeeds ⇒
probe; any `kind=invalid` naming that source ⇒ `unreadable`; spawn failure ⇒ `unreadable`.

### 10. MCP tool surface

Five tools, identical signatures on all three clients. The elicitation difference shows up in the
result (`consent: "client-policy"`, risky writes moved to `manualSteps`), never in the surface.

| Tool | Input | Output |
|---|---|---|
| `list_installations` | `category?`, `harness?`, `scope?`, `fresh?` | installation rows + harness rows (version, tiers, writability, trust) + tier health + `scannedAt` |
| `inspect_installation` | `installationId` | secret-free known fields, native location, digest, bindings, provenance, `alsoReadBy` |
| `plan_mirror` | `installationId`, `target{harness, tierId}` | the whole plan document, including `security.grade` |
| `apply_plan` | `plan`, `onConflict?` (`abort` default) | `applied \| partial \| refused \| stale \| busy \| declined`, `landed[]`, `manualSteps[]` echoed, verification outcome, `consent` |
| `verify_plan` | `plan` | `verified \| unverified \| failed` with per-assert detail |

No plan id anywhere, no `onGap` knob, no `rollback_operation`, no comparison or research tools.
A sixth tool must not be expressible with the plan document the agent already carries. `plan_mirror`
declares `readOnlyHint: true`; `apply_plan` declares `readOnlyHint: false` + `destructiveHint: true`
so a client's own permission layer can gate on top of the grade. `elicitation/create` is only sent
when the client declared the capability at initialise.

### 11. Runtime and packaging

One installed `acm` executable (ADR 0004). The engine service module is the library; `acm mcp serve`
(stdio, official `@modelcontextprotocol/sdk` 1.32.2, `McpServer.registerTool`, input schemas in zod,
consent via the low-level server's `elicitInput`) and the CLI subcommands (`list`, `inspect`,
`mirror`, `apply`, `verify`, `setup`) are two faces over it. The MCP server imports the service and
never executes the CLI.

- One enforceable import rule replaces architectural prose: nothing in the MCP or CLI modules imports
  `repo`, `plan`, or an adapter.
- A harness entry is the absolute installed bin path plus `["mcp","serve"]`, with **no `cwd`**. Bare
  `acm` on `PATH` is rejected because a harness spawns with a different `PATH`. The project root is
  derived from the module's own location, not `process.cwd()` — this amends the existing note that
  the scanner resolves from the working directory.
- `parseArgs` + zod, no CLI framework. TypeScript, no Effect runtime (reversal condition: a
  supervised long-lived engine process, at which point only the service module changes shape).
- Build: bin field plus shebang, bundled to a single ESM file for Node ≥ 22.5 (the version where
  `node:sqlite` arrived); Bun is the dev runner.
- `acm setup` builds the harness entries as plan-document-shaped writes and applies them through the
  same plan/approve path.
- The engine receives its roots (home, project root, store path) as injected configuration rather than
  reading `process.env` at call sites, so the whole service can be driven against a fixture home. The
  production default resolves from the module location.

### 12. Graded dispositions, in one table

| Situation | Plan `writes[]` | Disposition |
|---|---|---|
| target can express a field | yes | `carried` or `mapped` |
| target has no such field / only a legacy shape | yes, minus that field | gap `fieldAbsent` / `shapeOnly` |
| value is a credential | yes, minus that field | gap `credential` + manual step |
| value executes at harness runtime | yes, flagged `executable` | gap-free write that can never verify |
| whole category has no declarative surface | `[]` | gap `categoryAbsent`, still a plan |
| target already matches | `[]` | `alreadyPresent` |
| target is the source location | `[]` | `already shared` |
| target exists and differs | gated | conflict; `onConflict: replace` required |
| target tier is elevated / managed / not state | no plan | caller-input refusal before planning |
| a higher layer shadows the target | yes | manual step naming the layer |

## Testing Decisions

**What makes a good test here.** Only externally observable behaviour: the plan document, the apply
result, the verify outcome, the rows a list call returns, and the bytes on disk after a write. Never
the internal call sequence, never a private helper, never "the adapter was invoked once". A test that
would still pass after the MCP field table was silently rearranged is worthless, and a test that
breaks when a helper is renamed is worse than no test.

Three seams, and no fourth:

**Seam A — the engine service (primary, integration).** Every test drives the five tool-shaped
functions plus discovery against a temp fixture: a temp home, a temp project root, a temp sqlite file,
and hand-written native config files. This is the only seam that proves the slice end to end, and it
covers: inventory filters and `fresh`, tier health and its tombstone gate, plan shape and equivalence
partition, `planId` recomputation, precondition staleness, conflict gating, apply `partial` with
`landed[]`, `busy`, verify outcomes (`verified` / `unverified` / `failed`), the four containment
refusals, credential-location refusal, and provenance/operation rows.

**Seam B — adapters and the secret classifier (unit, pure).** `read` over bytes and `translate` over
facts, plus the classifier table. This is the design's own contract, not a test-only seam: the
adapter reports facts and returns unions, and the classifier is specified as an ordered table. It is
where the per-harness field tables and the entropy rules get pinned precisely, because those failures
are otherwise only visible as a whole-plan diff. One test per transform, one per gap reason, one per
harness row in the writable-tier table (each asserted to agree with its handler), and one per
classifier rule — including the false-positive guards (Codex `trusted_hash`, a UUID, a public key, an
env-var name) and the Pi→Codex `extract` case that would otherwise ship a literal `${T}`.

**Seam C — the installed binary over stdio (process smoke).** Spawn the built entry as a child, do
`initialize` → `tools/list` → `plan_mirror` → `apply_plan` against a fixture home, and assert the five
tool names, the declared hints, and that one mirror lands bytes on disk. This is the only check that
the packaging works: absolute bin path, shebang, no `cwd` assumption, stdio framing, and capability
negotiation. It is a smoke test, not a behaviour test — everything it asserts about behaviour is also
asserted at Seam A.

**Prior art.** `node --test` with `node:assert`, no test framework, no mocks. Existing examples:
plain-function unit tests for the redaction helper in `scan.cjs`; the settings schema/helpers test;
`store.test.mjs` with a temp-directory SQLite file and a `spawn`ed child for a concurrency assertion.
New tests are `.test.ts` (Node 22.23 strips types; `node --test` already collects one) or `.test.mjs`
where a test needs plain CJS.

**Fixtures.** Hand-written native files checked in per harness (Pi `mcp.json` + `hooks.json` + skill
dir; Codex `config.toml` + `hooks.json` + `AGENTS.md`; OpenCode `opencode.json` incl. the legacy V1
MCP shape + a JSONC file with comments). Never captured from this machine's real configs — they
contain credentials, and the blind-copy path needs a value that is provably never in a plan document,
so at least one fixture must hold a fake-but-secret-shaped value.

**Assertions worth naming.** After any write, re-parse the target and assert the pointer value — not
the file text — except in the two cases where text is the point: comments survive in a TOML/JSONC
sibling table, and an untouched unknown field is still there. For a `safe` grading test, assert the
plan's `security.grade` and each write's flags rather than trusting the classification implicitly.

## Out of Scope

- **Claude Code adapter.** The dashboard's own discovery stays Claude-specific and unused by the
  engine.
- **`commands` category** (no Codex surface) and **plugins** (executable install, manual step only).
- **Automatic, blanket, background, or continuous sync.** Mirroring is agent-initiated and
  per-component.
- **Rollback execution**, backups, `.bak` files, and adoption/drift lifecycles. Rollback is described
  per write, never performed.
- **Any command execution**: `runCommand` stays in the vocabulary with an empty allowlist and the
  engine refuses it.
- **Automation policy / `--yes` / session consent** in every form.
- **Comparison and research tool groups** (`compare_scopes`, `detect_drift`, `research_installation`,
  `get_recipe`), and the recipe/evidence pipeline.
- **Version gating** on harness versions; latest release only, recorded as nothing.
- **Harnesses beyond Pi / Codex / OpenCode** (no Cursor, Gemini CLI, Copilot, …).
- **A UI for the engine.** `acm serve` and any inventory page are a later slice; the existing
  dashboard is inherited unchanged.
- **A daemon, IPC, or HTTP transport.** The service boundary is a module.
- **The write-model questions the builder must probe** are recorded in Further Notes, not decided
  here.

## Further Notes

**Open items the builder must probe before shipping the affected feature** (each is unverified, and
each has a fallback that keeps the slice shippable):

1. Symlinked skill **directories** work for none of the three harnesses as verified. Probe before
   enabling `symlink` for `skills`; fall back to `copyFile` for that category.
2. OpenCode `~/.opencode` vs `~/.config/opencode` precedence is unverified, which is why `oc:home`
   stays out of the tier table.
3. Codex `http_headers_helper` has a schema entry and no documentation. Treat as `executable` and
   exclude it, never write it.
4. Codex `auth.idp.client_secret` appeared in the schema only. Treat as a credential pointer
   regardless.
5. `node:sqlite` may need a newer Node than 22.5 for a *sleeping* busy timeout. Verify before relying
   on the timeout; the pragma itself is fine.

**ADR owed.** The graded-consent model is security-critical and hard to reverse; ticket 08 requires a
record for it. ADRs 0001–0004 already exist, so this becomes 0005 (trust boundary, grading, the four
gates, and the explicit absence of automation).

**Build order that keeps each step reviewable.** Each step should land as its own issue:

1. Store: migration runner, four tables, `BEGIN IMMEDIATE`, and repo functions. Seam A groundwork can
   start here with a fixture store.
2. Secret classifier and its rule table, purely as a function.
3. Adapter skeleton plus descriptor/registry agreement check, with one category (MCP) read +
   translate for one harness end to end.
4. The remaining two harnesses for MCP; then skills, instructions, hooks.
5. Plan building, grading, preflight, containment.
6. Apply and verify, including `partial`, `stale`, `busy`.
7. The five MCP tools over the service; the stdio smoke test.
8. The CLI faces and `acm setup`.

**What to check first if the slice looks wrong.** The plan document is the contract everything else
serves. If a mirror cannot be described completely as `equivalence` + `writes` + `manualSteps` +
`verify` for some real component on this machine, that is a spec failure, not an adapter failure —
stop and amend the plan schema before writing more adapters.

**Vocabulary discipline.** Any word in code, tool output, or docs that is not in `CONTEXT.md`'s
entity list is a smell. The specific traps: `scope` must never mean a tier, "sync" is not a
synonym for mirror, and a gap is never called a warning or a limitation.
