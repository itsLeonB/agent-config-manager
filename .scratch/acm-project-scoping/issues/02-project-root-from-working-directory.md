# 02: The project is the working directory, for both faces

**What to build:** an `acm` installed once and configured globally reads the project the harness was
opened in, not the project `acm` happens to be installed in. The project root becomes
`ACM_PROJECT_ROOT ?? CLAUDE_PROJECT_DIR ?? the working directory`, canonicalised, so an MCP entry
written once at user scope serves every repository without a single absolute path in it — and every
entry installed before this change starts working without being rewritten.

Both faces resolve the root the same way: the MCP server a harness spawns, and the CLI a human runs.
`--project-root` stays the explicit override.

The working directory is taken exactly as given, never walked up to a repository marker: the pass
must read the layers the harness in front of it read, and a walk-up would describe config that
harness never loaded. `CLAUDE_PROJECT_DIR` sits in the chain because Claude Code starts a user-scope
MCP server in its own configuration directory, the one harness whose default working directory is
not the project.

The inventory answers as a project-scoped view: Installations whose native file is inside the
resolved root, plus the `user` and `system` scopes, and nothing belonging to another project. The
answer states which root it used, so an agent that was spawned somewhere unexpected sees that
instead of guessing from an empty list.

`acm setup` needs no change: what it writes into a harness entry is already the canonical
invocation, so the entries it installed earlier pick this up for free.

**Blocked by:** 01. Until tombstones stop reaching across projects, flipping the default would make
the first scan of a second project delete the first project's Inventory.

**Status:** resolved

- [x] A user-scope MCP entry with no arguments, spawned from a project directory, lists that
      project's Installations
- [x] `acm list` run in a project lists that project's Installations, and the same holds when run
      from a subdirectory: the subdirectory is the project, matching what the harness would read
- [x] `--project-root` and an inherited `ACM_PROJECT_ROOT` still win over the working directory, and
      are themselves canonicalised
- [x] `CLAUDE_PROJECT_DIR` is used when the override variables are absent
- [x] A symlinked path and its target record one Installation, not two
- [x] The listing reports the root it resolved
- [x] A project with no harness config yields an empty inventory plus the reported root, never an
      error and never another project's rows
- [x] None of the five MCP tools takes a project argument, and a tool call cannot reach outside the
      root the server was started with
- [x] The MCP server module's comment no longer claims the working directory is never consulted
- [x] `bun run check` green

## Answer

`resolveProjectRoot(cwd)` in `src/engine/config.ts` is the one statement of the chain:
`ACM_PROJECT_ROOT ?? CLAUDE_PROJECT_DIR ?? process.cwd()`, through `realpathSync` so a symlinked
path and its target are one root and therefore one row set. `--project-root` keeps its meaning by
writing `ACM_PROJECT_ROOT` before the config is resolved, so the CLI and the spawned MCP server
reach the same rule; the store path still comes from `deriveProjectRoot(MODULE_DIR)` and is
unchanged.

Scoping is a service-side filter, not a store one: `inProject()` in `src/engine/service.ts` keeps a
row when its scope is not `project`/`project-local`, or when its `nativeFile` is `under()` the
resolved root — the same segment-based containment ticket 01 gave tombstones. It wraps
`listInstallations()` and `findInstallation()`, so `inspect` and `mirror` cannot resolve an id from
another project either, and `Inventory` now carries `projectRoot` (printed by `acm list`, present in
its `--json`).
