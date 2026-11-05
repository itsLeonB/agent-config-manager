# Harness adapter contract and capability model

Labels: wayfinder:grilling
Type: grilling
Status: resolved
Blocked by: none

## Question

`BRIEF.md` §7–8.2 says each adapter describes identification/version detection, supported
component categories, supported scopes, native config paths, discovery/parsing, install/remove,
config merge/preservation, verification, and compatibility limitations; an adapter "must not
claim support for a feature that the harness itself does not support" and may report an
operation as **unsupported / partially supported / requiring manual intervention**.

Decide the exact contract for the three adapters (Pi, Codex, OpenCode):

1. What does an adapter *declare* — a capability matrix, per-operation support, or both?
2. How are "unsupported / partial / manual" represented to the engine so the mirror planner can
   react deterministically?
3. How do native paths and formats stay visible and traceable through the model?
4. How does version detection work, and what happens when a harness version is unrecognised?
5. Is the contract one shared TypeScript interface, or a capability descriptor plus
   per-category handlers?

**Zoom:** `BRIEF.md` §7, §8.2. Inputs: [Pi native configuration surface](./03-pi-config-surface.md), [Codex native configuration surface](./04-codex-config-surface.md), [OpenCode native configuration surface](./05-opencode-config-surface.md). Related: [Canonical domain model for mirroring](./01-canonical-domain-model.md).

**Output:** the contract shape and capability vocabulary in the handoff spec.

## Answer

Settled with the dev over two grilling rounds on 2026-11-05. Ticket sub-questions 2 and 5 were
answered together: once the contract collapsed to one table, both fell out of it.

### 1. Contract shape — descriptor + per-category handlers

```ts
type Adapter = {
  descriptor: {
    harness: HarnessId
    tiers: Tier[]                                  // ADR 0001
    formats: { match: string; format: Format; pointerSyntax: string }[]
    capability: (category: Category, tierId: string) => Capability
  }
  detectVersion(): { raw: string; semver: string | null }
  handlers: Partial<Record<Category, CategoryHandler>>   // read, translate, write, verify
}
```

A missing handler means unsupported, and must agree with the descriptor: the registry checks the
two at adapter load, so no adapter can claim a category in its table and ship no handler (or the
reverse). Capability is never re-discovered per scan.

Rejected: one fat `HarnessAdapter` interface with a method per verb per category. In all three
harnesses skills and instructions are near-identical file work (`SKILL.md` + frontmatter,
`AGENTS.md`, `.opencode/skills/…`); only MCP and hooks genuinely differ per harness. A fat
interface would triple the file-write and markdown-frontmatter logic and hide where the
differences really are.

### 2. One declaration table, verbs as columns

Capability matrix and per-operation support are the same artefact: one row per `(category, tier)`,
no separate matrix.

```
{ category, tierId,
  read:   supported | partial | unsupported | manual(reason)
  write:  supported | partial | unsupported | manual(reason)
  verify: supported | manual(reason)
  method: cli(commandTemplate) | file(format) | none
  expressible: string[] }
```

`expressible` is an **allowlist of canonical field names**. An unlisted field is a gap by default,
so a field introduced by a harness upgrade fails closed instead of being silently copied.
Denylists were rejected: they fail open.

`method` is per row because it genuinely varies by tier: Codex `mcp add` is user-scope only, so a
project-scope MCP write must be a file write; OpenCode has no `mcp remove` at all.

### 3. Facts to the planner, never policy

`translate()` returns a discriminated union. The adapter does not decide severity — that is
[Capability-gap semantics](./11-capability-gap-semantics.md)' policy, applied to the plan after the
fact.

```ts
translate(source: Installation, target: { harness, tierId }) →
  | { kind: 'notTranslatable', unexpressible: Gap[] }
  | { kind: 'manual', manualSteps: { step: string; why: string }[] }
  | { kind: 'translatable',
      knownFields: Record<string, Json>,
      unexpressible: Gap[],           // Gap = { field, reason, replacement? }
      writes: NativeWrite[],          // { file, pointer, value } | { command }
      preserved: string[],            // unknown fields left untouched in place
      verify: VerifySpec }
```

`replacement` (`renamed | inverted | dropped`) is where OpenCode's inverted `disabled` and Codex's
`startup_timeout_sec` are handled: the adapter maps or drops, the planner never sees a native field
name. No arm carries `warnings[]` or nullable fields, so the planner cannot half-read a result.

### 4. Native paths and formats survive to the plan

Format and pointer syntax are adapter-declared per path shape, because format is not one-per-harness
(Codex mixes `config.toml`, `hooks.json`, `AGENTS.md`, `SKILL.md`; OpenCode is JSONC; Pi is JSON plus
markdown plus directories):

`Format = json | jsonc | toml | markdown-frontmatter | directory`

Adapters therefore declare per-file pointer syntax, which is how Codex's
`hooks.state."<source>:<event>:<i>:<j>"` stays expressible.

The plan carries `sourceNativeLocation`, `targetNativeLocation`, a **target-file excerpt plus
diff**, and `preserved[]`. Never a whole-file copy — both for the secret hazard (Codex can hold
`mcp_servers.<id>.oauth.client_secret` inside `config.toml`) and so the store never becomes a
second copy of native config.

### 5. Versioning: skipped for this slice

`detectVersion()` stays, returning `{ raw, semver }`, and its value is recorded as a fact on the
harness row. **Nothing gates on it**: no supported-range check, no adapter-version pinning, no
refusal of a write because the detected version differs. The three adapters target the latest
release only, as observed by the researches (Pi 1.5.0, Codex 0.166.0, OpenCode 2.2.5). A detected
version is never a reason to refuse a write.

Why: versioned capability tables are a maintenance surface with no evidence yet of how often the
surfaces move, so deciding the policy before any real use would be a guess.

`shortcut:` version gating deferred until the system has run against a harness upgrade — the
observed bumps (Pi's 1.4 → 1.5 MCP surface, Codex dropping the `.env` sub-table) are the test to
design it against. Until then a mismatch surfaces as a failed write or a failed verification, never
as an adapter-level refusal.

### Consequence for the remaining tickets

- [The mirror operation and its plan representation](./07-mirror-operation-and-plan.md): the plan
  schema must hold `knownFields`, `unexpressible[]`, `writes[]`, `preserved[]`, and the target
  excerpt + diff.
- [Capability-gap semantics](./11-capability-gap-semantics.md): scope is narrower than its ticket
  assumed — severity is the planner's, the adapter reports facts only. Its hooks-as-code
  sub-question is untouched by this answer.
- Per-category translation tables (the canonical field names that populate `expressible`) stay in
  the map's fog: they need the plan from ticket 07 first.
