# OpenCode native configuration surface

Labels: wayfinder:research
Type: research
Status: resolved
Blocked by: none

## Question

Research and document OpenCode's native configuration surface needed by this slice, from official
documentation, the official repository, and release notes (community docs only as a fallback):

1. Config file locations and formats at each scope (user / project / project-local) — note
   `~/.config/opencode` and `~/.opencode` exist on this machine.
2. How it declares MCP servers, skills, hooks, plugins, and instruction files.
3. Version detection.
4. How a component is installed / removed, and how config is merged without destroying unknown
   fields.
5. Anything undocumented, version-dependent, or requiring manual intervention.

Attach source URLs and the research date. Flag unknowns explicitly rather than guessing. This
is a fact-finding input to a decision, not the decision itself. Inspect local files only as
corroborating evidence.

**Zoom:** `BRIEF.md` §7, §8.2. Feeds: [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md).

**Output:** a findings markdown file on the throwaway `research/opencode-config` branch, linked from this ticket.

## Answer

Findings: `docs/research/opencode-config-surface.md` on the throwaway `research/opencode-config`
branch (commit `661d0f4`). Read it without checking out:
`git show research/opencode-config:docs/research/opencode-config-surface.md`.
Verified against opencode **2.2.5** (`@opencode/cli@2.2.5`) on 2026-11-05, from the V2 docs
(`/v2/docs/` — the unversioned `/docs/` tree is still V1), the config JSON Schema, and 7 binary
probes in throwaway sandboxes.

Headlines that constrain the adapter:

1. **Four tiers, merging is cwd→root across every ancestor**: `/etc/opencode` (root-managed and it
   **outranks** the project), `~/.config/opencode`, `~/.opencode` (real, holds `opencode.json(c)`
   *and* resource dirs, absent from the docs location table), and a per-ancestor project chain.
   Every `.opencode/*` config outranks every direct `opencode.json(c)`; merge is per-key and
   arrays (`instructions`, `skills`, `plugins`) combine. The precedence winner between
   `~/.opencode` and `~/.config/opencode` is **unverified** (flagged in the findings).
2. **Hooks are not config** (same as Pi): `hooks` is absent from the 46-key config schema; hooks are
   `ctx.session.hook(...)` calls inside a `Plugin.define` package. V1 plugin code does not run in V2.
3. **MCP is `mcp.servers.<name>` with `disabled` (not `enabled`), and merge is whole-entry
   replace** — no field-level patch, so a higher-precedence entry silently drops omitted fields.
   Legacy flat `mcp.<name>` + `enabled: true` is still accepted and normalised in memory, so the
   file shape and what `opencode debug config` reports differ.
4. **The CLI manages almost nothing:** `mcp add|auth|logout` (there is **no `mcp remove`**) and
   `plugin add|remove|check|update`, all **global config only**, npm/git specs only. Agents,
   commands, skills, instructions, references, policies, permissions, and MCP removal are
   file-write only. `mcp add` writes V2 shape into a V1-shaped file, leaving a mixed document.
5. **Writes preserve comments and unknown keys but not bytes** (whitespace reflows), and **an
   invalid `opencode.json` fails silently**: exit 0, empty stderr, config dropped, only a
   `kind=invalid` normalization diagnostic in `~/.local/share/opencode/log/opencode.log`. Any
   mirror must verify its own writes; the CLI will not tell it.
6. Human gates: OAuth (`mcp auth`, browser or pasted callback), `/etc/opencode` + MDM, and managed
   `policies` that can block a server/skill/plugin no matter how correct the file is.

Cross-harness consequence now visible with all three researches in: **hooks can be mirrored as data
into Codex only**; Pi and OpenCode hooks are code and must be reported unsupported (or generated as
an extension/plugin source, a separate decision). Credential handling differs per harness:
Codex can carry an MCP `client_secret` in `config.toml`, Pi/OpenCode keep OAuth state outside the
served tables.
