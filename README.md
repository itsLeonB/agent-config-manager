# agent-config-manager

Two things live here:

- **The Claude dashboard**: scans the Claude Code setup on this machine — plugins, MCP servers,
  skills, environment tools, projects — and serves it as a local web page with a rescan and a
  settings form. See [docs/dashboard.md](docs/dashboard.md).
- **The engine**: readers for Pi, Codex, and OpenCode native configuration, a secret classifier, and
  a pointer-level editor that keeps comments and sibling entries intact. It is being built into a
  declared environment — one TOML file of named Provisions, each with a check and an install command
  per harness — so a machine can be reproduced with one command instead of by hand. See
  [CONTEXT.md](CONTEXT.md) and [ADR 0007](docs/adr/0007-declare-provisions-and-delete-the-mirror-engine.md)
  for where that is going: `acm status` reads the environment files and `acm install` runs them.

## Install

| Requirement | Why |
| --- | --- |
| Bun 1.x | builds the CLI bundle and serves the dashboard |
| Node 22.13 or newer | runs `dist/acm.mjs`, which imports `node:sqlite` without a flag |

1. Clone the repo and enter it:

   ```bash
   git clone git@github.com:itsLeonB/agent-config-manager.git
   cd agent-config-manager
   ```

2. Install and build:

   ```bash
   bun install
   bun run build:acm
   ```

3. Put `acm` on `PATH` if you want the bundled entry available to a harness:

   ```bash
   make install
   ```

   This writes `dist/acm.mjs` and symlinks it to `~/.local/bin/acm`. Override the location with
   `make install PREFIX=/usr/local`.

4. Run the dashboard:

   ```bash
   bun run dev
   ```

   It serves on <http://localhost:3000>; the first page load scans, and the rescan button on the page
   repeats it.

## Use acm

| Command | What it does |
| --- | --- |
| `acm status` | Prints every Provision with the Presence (`present`, `absent`, `unknown`) of each harness it declares, one row per harness entry, then the project and store it read from. `--json` prints the same rows as data, and `--tier <user\|project\|project-local>` keeps only the entries that tier owns. A refused environment file is reported on stderr with a line and column, and makes the command exit non-zero |
| `acm install` | Runs every Install command whose Presence is not `present`, in file order of the winning entry and from that entry's Tier root. `--dry-run` prints the plan and stops (the default when stdin is not a TTY), `--force` runs even what is present, `--only <name>` narrows to one Provision, and `--tier` narrows to one tier |
| `acm mcp serve` | Speaks the MCP protocol over stdin/stdout. It registers `list_provisions`, which answers the same rows as `acm status --json`; the other environment tools land as the tickets that own them arrive |

Three environment files are read, one per Tier: `~/agents_environ.toml`, the committed
`<project>/agents_environ.toml`, and the gitignored `<project>/agents_environ.local.toml`. Each is
one table per Provision and harness:

```toml
version = 1

[provision.opencode-no-claude.opencode]
check   = { file = "~/.zshrc", contains = "OPENCODE_DISABLE_CLAUDE_CODE" }
install = "./scripts/zshrc-export.sh OPENCODE_DISABLE_CLAUDE_CODE=1"
```

For one Provision and harness the nearest file wins whole — `project-local` over `project` over
`user` — so a nearer entry replaces the farther one, `tags` included, rather than inheriting half of
it. A relative path in a Check or in an Install command resolves against its Tier's root: `$HOME` in
the user file, the Project root in the two project files, which is what lets the same text be
written twice and read correctly in both.

A Check is declared data and is evaluated by reading, so it never runs anything. A malformed file is
refused whole, with the line and column of the fault, rather than loaded halfway, and the files that
do parse still load.

Every invocation takes `--project-root <dir>`: the project an engine pass reads defaults to the
working directory, taken as given and never walked up to a repository marker, and this names another
one. The store stays beside `acm`, so the flag does not drop a second database into the project.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACM_HOME` | `os.homedir()` | Home directory the engine reads harness locations from |
| `ACM_PROJECT_ROOT` | the working directory | The project root: which project-tier locations the engine reads. The store does not follow it — its path is fixed beside the install |
| `CLAUDE_PROJECT_DIR` | — | Read when `ACM_PROJECT_ROOT` is absent. Claude Code starts a user-scope MCP server in its own config directory, so the harness names the project instead |
| `ACM_STORE` | `<installation>/database/dashboard.db` | Store the engine opens |
| `CODEX_HOME` | `~/.codex` | Codex config root, when relocated |

Point the fixture overrides at fixtures: `ACM_HOME` at a fixture home, `ACM_PROJECT_ROOT` at a
fixture project, `ACM_STORE` at a temporary database, and `CODEX_HOME` at the fixture's Codex
directory.

## State

One SQLite file holds what the dashboard persists: the latest scan snapshot and the settings rows,
at `database/dashboard.db` beside the repo, or `ACM_STORE`. Migrations run on open, so an older file
upgrades in place and keeps its rows.

## Checks

```bash
make check    # lint, typecheck, then build the bundle and run the suite
make test     # build the bundle, then run the suite alone
```

The MCP smoke test spawns the built bundle, so a bare `bun test` in a clean checkout fails until
`dist/acm.mjs` exists.
