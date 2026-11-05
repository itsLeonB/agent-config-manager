# Codex native configuration surface

Labels: wayfinder:research
Type: research
Status: resolved
Blocked by: none

## Question

Research and document Codex's native configuration surface needed by this slice, from official
documentation, the official repository, and release notes (community docs only as a fallback):

1. Config file locations and formats at each scope (user / project / project-local) — note
   `~/.codex/config.toml` exists on this machine.
2. How it declares MCP servers, skills, hooks, plugins, and instruction files (`AGENTS.md`
   conventions).
3. Version detection.
4. How a component is installed / removed, and how config is merged without destroying unknown
   fields.
5. Anything undocumented, version-dependent, or requiring manual intervention.

Attach source URLs and the research date. Flag unknowns explicitly rather than guessing. This
is a fact-finding input to a decision, not the decision itself. Inspect local files only as
corroborating evidence.

**Zoom:** `BRIEF.md` §7, §8.2. Feeds: [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md).

**Output:** a findings markdown file on the throwaway `research/codex-config` branch, linked from this ticket.

## Answer

Findings: `docs/research/codex-config-surface.md` on the throwaway `research/codex-config` branch
(commit `acbb1f9`). Read it without checking out:
`git show research/codex-config:docs/research/codex-config-surface.md`.
Verified against `codex-cli 0.166.0` on 2026-11-05; schema pinned at repo tag `rust-v0.166.0`.

Headlines that constrain the adapter:

1. **Three scopes, not two** — `user` (`$CODEX_HOME/config.toml`), `profile`
   (`$CODEX_HOME/<name>.config.toml`, launch-time only, not a mirror target), `project`
   (`<repo>/.codex/config.toml`). Project layers load **only** when the user config carries
   `[projects."<path>"].trust_level = "trusted"`; above both sit `requirements.toml` / MDM / cloud
   layers the CLI cannot override. No untracked project-local tier.
2. **Hooks are real config here** — `hooks.json` or inline `[hooks]`, 14 events, `command` or
   `mcp_tool` handlers, behind `[features] hooks`. Cross-layer merge is **additive**. Trust is
   keyed by `[hooks.state."<source>:<event>:<i>:<j>"]` over a **content hash + positional index**,
   so inserting a hook shifts indices and forces re-review. The direct opposite of Pi, where a
   hook is code with no declaration.
3. **MCP merges per field across layers, but the CLI replaces whole tables.** A project
   `[mcp_servers.x]` carrying only `startup_timeout_sec` keeps the user entry's
   `command`/`args`/`env`/`enabled` (arrays replace, not concat). `codex mcp add` on an existing
   server replaces the entire table and dropped the `.env` sub-table in testing — so field-level
   edits, and any project-scope MCP write, must be file writes.
4. **CLI-managed ops are user-scope only and cannot target project scope**: `codex mcp add/remove`
   (no scope flag — writes user config even inside a trusted project), `codex plugin
   add/remove`, `codex plugin marketplace …`, `codex features enable/disable` (all `--json`).
   File-write only: project config, `AGENTS.md`, skills, `hooks.json`, plugin manifests. The CLI
   writer preserves unknown keys/comments/order outside the edited table, drops comments *inside*
   it, and fails closed on unparsable or type-invalid TOML (file left unchanged).
5. **Human-only gates:** project trust, hook trust review (`/hooks`), MCP OAuth
   (`codex mcp login`; `--no-browser` still needs a pasted callback), plugin install-time auth.
   Credential hazard for any mirror: `mcp_servers.<id>.oauth.client_secret` is stored **inside
   `config.toml`**, so copying a TOML table wholesale can copy a secret.
6. Validation is available offline: `codex-rs/core/config.schema.json` at the matching tag
   (draft-07, `additionalProperties: false`, 103 top-level keys). Unverified: where MCP OAuth
   tokens land (`~/.codex/auth.json` / `state_5.sqlite` were not read).
