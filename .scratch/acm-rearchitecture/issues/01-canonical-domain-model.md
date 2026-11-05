# Canonical domain model for mirroring

Labels: wayfinder:grilling
Type: grilling
Status: claimed
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
