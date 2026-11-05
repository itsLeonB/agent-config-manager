# Per-category canonical field tables for the slice

Labels: wayfinder:grilling
Type: grilling
Status: open
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

Out of this ticket: hooks and plugins (both `manual` per ticket 07) and anything in
`BRIEF.md` §9's recipe pipeline.

**Zoom:** [Pi](./03-pi-config-surface.md), [Codex](./04-codex-config-surface.md),
[OpenCode](./05-opencode-config-surface.md) — the three researches hold the native surfaces;
`BRIEF.md` §5, §9.4. Builds on: [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md),
[The mirror operation and its plan representation](./07-mirror-operation-and-plan.md).

**Output:** the allowlist tables in the handoff spec, one table per `(harness, category)` with the
tier column carrying `method` and `expressible`.
