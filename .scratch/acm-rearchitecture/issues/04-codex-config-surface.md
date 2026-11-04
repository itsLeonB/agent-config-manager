# Codex native configuration surface

Labels: wayfinder:research
Type: research
Status: open
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
