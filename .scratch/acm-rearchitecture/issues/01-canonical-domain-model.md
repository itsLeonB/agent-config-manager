# Canonical domain model for mirroring

Labels: wayfinder:grilling
Type: grilling
Status: resolved
Blocked by: none

## Question

`BRIEF.md` §5–6 defines Component vs Installation, scopes (User / Project / Project-local),
Discovered / Adopted / Managed status, and per-installation fields (harness, scope, native
location, method, version, config state, provenance, management status, verification status).
Decide: do we adopt that model **verbatim** as the canonical domain model for the slice, or
does mirroring force extensions? Specifically:

1. How is an installation's *identity* defined so two installations of the same component in
   different harnesses are linkable?
2. Does the model need an explicit *equivalence / provenance* link recording that installation
   B was mirrored from installation A?
3. Is "management status" needed at all in this slice, given adoption is out of scope and Q1
   defers the lifecycle?
4. How are capability limitations attached — per harness, per component category, per scope?

Stress-test with two concrete scenarios: (a) an MCP server present in Codex with a field
OpenCode does not understand; (b) a skill that exists at user scope in Pi and project scope in
OpenCode. Challenge any fuzzy term with a precise canonical one and record it.

**Zoom:** `BRIEF.md` §5, §6, §8.3. Related: [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md), [Storage and migration decision](./10-storage-and-migration.md).

**Output:** the agreed entity/field list and rationale, written into the handoff spec.

## Comments

2026-11-05 — input from the three config-surface researches (they all landed; see
[Pi](./03-pi-config-surface.md), [Codex](./04-codex-config-surface.md),
[OpenCode](./05-opencode-config-surface.md)). The scope vocabulary this ticket settles cannot
assume one scope shape per harness:

| Harness | Tiers | Sharp edges |
|---|---|---|
| Pi | 2 | user (`~/.pi/agent`), project (`.pi/`) — no project-local tier |
| Codex | 3 | user, `profile` (`<name>.config.toml`, **launch-time only, not writable state**), project; project inert until `trust_level = "trusted"` in *user* config; `requirements.toml`/MDM above all |
| OpenCode | 4+ | `/etc/opencode` is root-managed and **outranks the project**; `~/.opencode` is real but undocumented; project chain merges every ancestor `opencode.json(c)` cwd→root, and `.opencode/*` configs outrank direct ones |

So at least one harness has a tier that is not a mirror target (`profile`), one has a tier the tool
does not own (`/etc/opencode`, MDM), and one has no project-local tier at all. The model needs a
way to represent "this installation exists at a tier ACM cannot write" that is distinct from
"unsupported component".

## Answer

Agreed with the dev over five grilling rounds on 2026-11-05. Vocabulary lives in the new
[`CONTEXT.md`](../../../CONTEXT.md); the scope split has
[ADR 0001](../../../docs/adr/0001-tier-and-scope-split.md).

### Decision: extend BRIEF §5–6, don't adopt it verbatim

BRIEF's Component/Installation split and the per-installation fields survive. Four things change.

### Entities and fields

**Component** — key `(category, normalisedName)`; `category`, `name`, `aliases[]`.
Categories: `instructions`, `skills`, `mcp`, `hooks`, `plugins`, `commands` (the brief's five plus
`commands` for prompt templates / slash commands, which all three harnesses have). Themes, agents,
and OpenCode references stay out of the slice.

**Installation** — key `(category, componentName, scope, nativeLocation)`.

| Flat | Notes |
|---|---|
| `scope` | `user \| project \| project-local \| system`, derived from the binding's tier |
| `nativeLocation` | `{file, pointer}`, e.g. `~/.pi/agent/mcp.json#mcpServers.serena` |
| `contentDigest` | a config edit is drift on the same Installation, not a new one |
| `knownFields` | adapter-understood fields only, normalised. **Never a copy of the native file** |
| `provenance.mirroredFrom` | `{sourceInstallationId, planId, at, toolVersion}` |
| `firstSeenAt`, `lastSeenAt`, `removedAt` | `removedAt` is the tombstone |

| Per binding | Notes |
|---|---|
| `harness`, `tierId` | identity of the tier is adapter-declared |
| `method` | how it got there (package, file copy, `cli:mcp-add`, …) |
| `version` | may be absent |
| `verificationStatus` | `unverified \| verified \| failed \| notApplicable` |

`bindings: []` replaces BRIEF's flat `harness` field, so a shared file (`~/.agents/skills/...`) is
one Installation with several bindings. Everything that can differ per harness hangs off the
binding; nothing is duplicated as nullable flat fields.

**Tier** — adapter-declared, versioned with the adapter:
`{id, nativeLabel, rank, bucket, configPath, writability}` with writability ∈
`{writable, elevationRequired, notState, managed}`. Concrete uses: Codex `profile` → `notState`;
`/etc/opencode` → `elevationRequired`; `requirements.toml` / MDM → `managed`.

**Capability** — `adapter.capability(category, tierId) → supported | partial(unexpressableFields[]) |
unsupported | manual(reason)`. Adapter-owned. **Not** attached to installations, and not
re-discovered per scan: whether a harness can do hooks at project scope is a fact about the adapter.

### Dropped and relocated fields

- **Management status (Discovered / Adopted / Managed) — dropped.** Discovery is not a status, it is
  what happened; "ACM created this" is readable from `provenance.mirroredFrom` and the plan id.
  Adoption arrives with the lifecycle slice, and the field arrives with it.
- **Configuration state → `contentDigest` + `knownFields`.** The store never holds a full native
  config. Reason beyond staleness: Codex can carry an MCP OAuth `client_secret` inside
  `config.toml`, so a wholesale copy would pull a secret into ACM's database.
- **Capability limitations are not an installation field.** Gaps are computed at plan time and
  recorded on the plan. Ticket 11 decides whether a gap blocks, degrades, or asks.

### Scenario (a) — Codex MCP server → OpenCode

Source: `(mcp, serena, user, ~/.codex/config.toml#mcp_servers.serena)`, binding
`{codex, tier=user, method=file}`. Target: `(mcp, serena, user, <repo>/opencode.json#mcp.servers.serena)`,
binding `{opencode, tier=<its user tier>, method=file}`. Codex's `startup_timeout_sec`, `enabled`,
and `.env` sub-table never reach `knownFields`; they are **gaps on the plan**. OpenCode's inverted
`disabled` is written by the adapter, not by the planner. `contentDigest` of the target changes on a
later hand edit → drift on the same Installation, no new row.

### Scenario (b) — Pi skill at user scope → OpenCode at project scope

Source: `(skills, review, user, ~/.pi/agent/skills/review/SKILL.md)`. Target:
`(skills, review, project, <cwd>/.opencode/skills/review/SKILL.md)`. Same Component (category + name),
different bucket; the plan records source tier → target tier and that scope changed. New rule the
walk-through exposed: **if the target location would equal the source location** (e.g. a skill under
`~/.agents/skills/`, which several harnesses read), the mirror is redundant — the planner reports
"already shared" and writes nothing.

### Provenance lifecycle

`mirroredFrom.sourceInstallationId` never dangles: removing a source Installation outside ACM sets
`removedAt` (tombstone), the edge still resolves, and queries filter tombstones by default. Cardinality
is one source per Installation in this slice.

### Consequence for the remaining tickets

- [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md): the tier
  table and `capability(category, tier)` signature are now fixed inputs; the contract must carry them.
- [Capability-gap semantics](./11-capability-gap-semantics.md): the model deliberately says nothing
  about block/degrade/ask beyond "gaps live on the plan".
- [Storage and migration decision](./10-storage-and-migration.md): `bindings`, tombstones, and
  `knownFields` are the three shapes the store must hold; `project-local` stays in the enum though no
  current adapter declares it (ADR 0001 records why).
