# Agent Config Manager

A local-first management layer for AI coding-agent configuration: it discovers how components are
configured in each harness natively, and mirrors one installation into another harness without
replacing the native format. This file holds the vocabulary the code and the specs must agree on.

## Entities

**Component**: the thing itself, independent of where it is configured — a skill, an MCP server,
a hook. Keyed by `(category, normalised name)`; renames are recorded as explicit aliases, never
matched fuzzily.
_Avoid_: package, resource, tool, item

**Installation**: one Component as it exists in one place on disk. Keyed by
`(category, component name, scope, native location)`. Everything that can differ per harness
(method, version, verification) hangs off its bindings, not off the Installation.
_Avoid_: install, instance, entry, record

**Binding**: one harness's claim on an Installation, carrying `harness`, `tier`, `method`,
`version`, `verification status`. Most Installations have one; a file in a shared location
(`.agents/skills/`) has several.
_Avoid_: harness list, owner

**Tier**: the harness's own configuration layer, declared by the adapter with its native label,
rank, config path, scope bucket, and writability. `profile` (Codex) and `/etc/opencode` are tiers.
_Avoid_: scope, level, layer

**Scope bucket**: the four-value cross-harness classification a tier maps to — `user`, `project`,
`project-local`, `system`. Derived from the tier, never inferred from a path.
_Avoid_: scope (when a tier is meant), level

**Capability**: what a harness can express for a Component category at a given tier:
`supported`, `partial` (with the fields it cannot express), `unsupported`, or `manual`. Owned by
the adapter, declared for `(harness, category, tier)`, never stored on an Installation.

**Known fields**: the subset of an Installation's native configuration the adapter understands and
persists in normalised form. Unknown fields stay in the native file and are preserved by the
writer; they are never copied into ACM's store.
_Avoid_: config state, parsed config, payload

**Native location**: `{file, pointer}` — the config file plus the address inside it
(`~/.pi/agent/mcp.json#mcpServers.serena`, `<repo>/.codex/config.toml#mcp_servers.serena`). Part of
an Installation's identity.

**Mirror**: given a source Installation, produce a plan that creates an equivalent Installation in
another harness and tier, translating per that harness's declared capability, surfacing what could
not be carried, then applying and verifying under explicit approval.
_Avoid_: sync, copy, port, convert

**Gap**: a field or behaviour present in the source Installation that the target harness cannot
express. Recorded on the plan, never on the Installation.
_Avoid_: limitation, difference, loss

**Plan**: the reviewed, approval-gated description of one mutation (here: one mirror), including
its gaps and its verification result. Distinct from execution; nothing is written before approval.

## Rules that follow from the vocabulary

- Discovery never implies write permission. Trust and elevation are properties of a tier, not of an
  Installation.
- An Installation whose `native location` is shared by two harnesses needs no mirror between them.
- Provenance points backwards: a mirrored Installation records `mirroredFrom` (source Installation,
  plan, time, tool version). A removed source becomes a tombstone so the edge still resolves.
