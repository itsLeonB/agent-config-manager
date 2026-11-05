# Pi native configuration surface

Labels: wayfinder:research
Type: research
Status: resolved
Blocked by: none

## Question

Research and document Pi's native configuration surface needed by this slice, from official
documentation, the official repository, and release notes (community docs only as a fallback):

1. Config file locations and formats at each scope (user / project / project-local).
2. How it declares MCP servers, skills, hooks, plugins, and instruction files.
3. Version detection.
4. How a component is installed / removed, and how config is merged without destroying unknown
   fields.
5. Anything undocumented, version-dependent, or requiring manual intervention.

Attach source URLs and the research date. Flag unknowns explicitly rather than guessing. This
is a fact-finding input to a decision, not the decision itself. `~/.pi` exists on this machine
— inspect it as corroborating evidence, not as the primary source.

**Zoom:** `BRIEF.md` §7, §8.2. Feeds: [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md).

**Output:** a findings markdown file on the throwaway `research/pi-config` branch, linked from this ticket.

## Answer

Findings: `docs/research/pi-config-surface.md` on the throwaway `research/pi-config` branch
(commit `7b473d6`). Read it without checking out:
`git show research/pi-config:docs/research/pi-config-surface.md`.
Verified against `@earendil-works/pi-coding-agent@1.5.0` (the installed release) on 2026-11-05.

Headlines that constrain the adapter:

1. **Two scopes only** — user `~/.pi/agent` (override `PI_CODING_AGENT_DIR`) and project `.pi/`.
   No project-local/untracked tier. Project has no `auth.json`, `models.json`, `keybindings.json`.
2. **`hooks` are not config.** Pi has no hook declaration format; hooks are extension event
   handlers, i.e. executable TypeScript/JavaScript. Plugins = Pi packages (npm/git/local path),
   declared in `settings.json` `packages: []` and installable with `pi install/remove`.
3. **MCP** is `mcp.json` → `mcpServers`, Claude/Cursor-compatible shape. A project entry *replaces*
   the user entry of the same name, except an entry with no `command`/`url`/`type`, which patches
   only `enabled`/`exposure`/`toolExposure`. Pi-only concepts: `exposure` and `toolExposure`.
   No JSON Schema for `mcp.json`; validate with `pi mcp list` (exit 1 on invalid entry).
4. **Programmatic install/remove exists only for packages and MCP servers.**
   `pi mcp add` "add or replace" replaces the whole named entry — it is not a field merge, and it
   silently drops fields it has no flag for (`auth`, `toolExposure`). Skills, instructions,
   prompts, themes, extensions are file-write/file-delete. `settings.json` also holds Pi's own
   bookkeeping keys (`lastChangelogVersion`, `extensionChangelogVersions`), so any rewrite must
   preserve unknown keys.
5. **Two steps no adapter can complete for the user:** project trust (`~/.pi/agent/trust.json`,
   gates *all* `.pi/` config) and MCP OAuth sign-in. A mirrored project-scope write stays inert
   until trust is granted; a running session needs `/reload` to see any write.
6. Version detection: `pi --version` (bare semver; `1.5.0` here), and per-version installs keep
   their own docs+schemas under `~/.pi/agent/install/releases/<version>/`. The config surface did
   change 1.4.0 → 1.5.0 (`selfUpdateCommand`, MCP `clientRegistration`, package changelogs).
