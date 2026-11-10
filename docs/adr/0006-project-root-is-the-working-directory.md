# Read the project from the working directory, and anchor only the store where `acm` is installed

`acm` is installed once and registered once, at user scope, but which project's configuration it
reads is decided per call: the project root is `ACM_PROJECT_ROOT ?? CLAUDE_PROJECT_DIR ?? <working
directory>`, canonicalised so a symlinked path and its target are one root. The directory is taken
exactly as given and never walked up to a repository marker. The store keeps its old anchor — the
nearest `package.json` above the module — so every project adds rows to one inventory instead of
forking a database into each repository.

Both faces resolve the root the same way, because the entry a harness holds is an absolute
`acm mcp serve` with no `cwd` and no project argument: the project is the one the harness in front
of `acm` was opened in, not the one `acm` was installed in. The inventory answers as a project-scoped
view of that root and states which root it used, so an agent spawned somewhere unexpected sees that
instead of reading an empty list as an empty project.

## Considered Options

- **The working directory, exactly** (chosen). The pass reads the layers the harness in front of it
  read, because it is standing where that harness stood. One installed `acm` serves every repository,
  and every entry installed before this change starts working without being rewritten.
- **Walk up to a repository marker** (`.git`, or the nearest `package.json` the store already looks
  for). It would make a subdirectory mean the repository, which is a guess: nothing in a harness's
  own config resolution walks up on the engine's behalf (OpenCode's ancestor chain is the one
  exception, and its own declared chain, not ours to reconstruct), so a project layer the harness
  never loaded would enter the inventory as if the harness had loaded it.
- **Take the root as an argument of each tool call.** The most explicit, and it makes a wrong root a
  visible input rather than an inherited fact. Rejected because the caller is an agent, and a
  required argument is one it must derive — from a path it may have wrong, or from the same working
  directory, one step removed and unauditable. `--project-root` survives as the CLI's explicit
  override, so the explicit form still exists where a human types it.
- **The module's own location, the incumbent** (ADR 0004). True for the store and false for the
  project: it makes a globally configured `acm` report the project it was installed from, for every
  repository.

## Consequences

- **Accepted cost: a harness started below the repository root scopes to that subdirectory.** A
  session opened in `repo/packages/api` gets that directory as its project root, so the repository's
  own project layer is not in its inventory. This is deliberate — it is what that harness read — and
  the listing names the root, so the difference is visible rather than silent.
- **Accepted cost: `CLAUDE_PROJECT_DIR` is in the chain for one reason.** Claude Code starts a
  user-scope MCP server in its own configuration directory, and it is the one installed harness
  whose default working directory is not the project. Without that variable in the chain, a
  Claude-spawned server would have scoped every repository to the configuration directory. Pi, Codex
  and OpenCode spawn in the project and need no equivalent.
- **The store stays where `acm` is installed and stays shared.** Project root and store location are
  two different paths with two different rules: the first follows the caller, the second follows the
  install. Only the first moved.
- **No tool takes a project argument**, and a project-tier location outside the root is unreachable:
  the five MCP tools answer from that root's view and cannot resolve an id belonging to another
  project. User and system tiers are the exception by construction — a `codex` user-scope file under
  `$HOME` is outside every project root and stays readable and writable, because it belongs to no
  project.
- **Amends ADR 0004.** Its spawn consequence said the project root comes from the module's own
  location rather than `process.cwd()`; that holds for the store only.
