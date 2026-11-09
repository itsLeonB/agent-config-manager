# agent-config-manager

`acm` reads the native configuration of Pi, Codex, and OpenCode, stores what it finds, and mirrors one harness's entry into another: MCP servers, skills, instructions, and hooks. It runs as a CLI or as an MCP server, so an agent can do the same work.

Every write goes through a plan: `mirror` prints the document, `apply` executes it, `verify` re-reads the target and reports each assertion.

## Install

| Requirement | Why |
| --- | --- |
| Bun 1.x | builds the CLI bundle |
| Node 22.5 or newer | runs `dist/acm.mjs`, which depends on `node:sqlite` |

1. Clone the repo and enter it:

   ```bash
   git clone git@github.com:itsLeonB/agent-config-manager.git
   cd agent-config-manager
   ```

2. Install, build, and put `acm` on `PATH`:

   ```bash
   make install
   ```

   This runs `bun install`, writes `dist/acm.mjs`, and symlinks it to `~/.local/bin/acm`. Override the location with `make install PREFIX=/usr/local`; if `acm` is not found afterwards, add that `bin` directory to `PATH`.

3. Register `acm` as an MCP server in each harness's user tier. It plans one write per harness, applies it, then re-reads the file to verify:

   ```bash
   acm setup
   ```

   Add `--on-conflict replace` to overwrite an entry a human already wrote at that address. The default is `abort`: an existing entry is left alone and reported.

Re-run `make install` after pulling, since the bundle is built, not read from source. `make uninstall` removes the symlink only: entries `acm setup` wrote into harness configs stay until you delete them there.

## Use acm

`list`, `inspect`, and `setup` take `--json`. `mirror`, `apply`, and `verify` print JSON and nothing else.

| Command | What it does | Writes |
| --- | --- | --- |
| `acm list` | Scans the native configs, then prints the stored inventory: category, name, scope, tiers, native address, digest, id prefix | Store only |
| `acm list --category mcp --harness codex --scope user --all` | Same, filtered. Categories: `mcp`, `skills`, `instructions`, `hooks`. Harnesses: `pi`, `codex`, `opencode`. `--all` includes removed rows | Store only |
| `acm inspect <id\|prefix>` | Prints one installation: known fields, native location, bindings, digests, each credential withheld with a verdict | Nothing |
| `acm mirror <id\|prefix> --target <harness:tier> --plan` | Prints the plan document for that move. No scan, so nothing is persisted | Nothing |
| `acm apply <plan.json\|->` | Executes the plan document exactly as given, one file at a time, then records what landed | Target harness config |
| `acm verify <plan.json\|->` | Re-reads the target and asserts each of the plan's expectations | Nothing |
| `acm setup [--on-conflict abort\|replace]` | Installs this `acm` into all three harnesses through a plan | Target harness configs |
| `acm mcp serve` | Speaks the MCP protocol over stdin/stdout | Per tool |

A mirror target must be a writable tier:

| Tier | Harness | Layer | Mirror target |
| --- | --- | --- | --- |
| `pi:user` | Pi | user | yes |
| `pi:project` | Pi | project | yes |
| `codex:user` | Codex | user | yes |
| `codex:project` | Codex | project | yes |
| `oc:user` | OpenCode | user | yes |
| `oc:project` | OpenCode | project | yes |
| `codex:profile` | Codex | launch profile | no, `notState` |
| `oc:system` | OpenCode | `/etc/opencode` | no, `elevationRequired` |

One MCP server, Pi into Codex, in five commands:

```bash
acm list --category mcp            # find the id prefix in the last column
acm inspect 3f9c1ab2               # read it first: fields, secrets, executables
acm mirror 3f9c1ab2 --target codex:user --plan > plan.json
acm apply plan.json --on-conflict abort
acm verify plan.json
```

`apply` reports `applied`, `partial`, or `refused`. `partial` means a write failed partway and nothing was rolled back: the message names the file and the manual steps the plan carried.

## MCP server

`acm mcp serve` exposes five tools on stdio over the same service functions as the CLI: `list_installations`, `inspect_installation`, `plan_mirror`, `apply_plan`, and `verify_plan`. Planning tools write nothing. `apply_plan` asks the client to tick each risk flag the plan carries before it writes.

```json
{
  "mcpServers": {
    "acm": {
      "command": "/home/you/.local/bin/acm",
      "args": ["mcp", "serve"]
    }
  }
}
```

`acm setup` writes this entry for you, with the absolute path of the binary it was started with.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACM_HOME` | `os.homedir()` | Home directory the engine reads harness tiers from |
| `ACM_PROJECT_ROOT` | nearest `package.json` above the entry | Project root the engine reads project tiers from. The default store follows it |
| `ACM_STORE` | `<projectRoot>/database/dashboard.db` | Store the engine opens |
| `CODEX_HOME` | `~/.codex` | Codex config root, when relocated |

The first three are also the test boundary: point them at a fixture home plus a temporary store and the engine never touches the real machine.

## State

One SQLite file holds the inventory and the record of what each apply landed: `database/dashboard.db` beside the repo, or `ACM_STORE`. Delete it and `acm list` rebuilds the inventory from the native configs. Migration runs on open, so an older file upgrades in place.

## Checks

```bash
make check    # lint, typecheck, then build the bundle and run the suite
make test     # build the bundle, then run the suite alone
```

The MCP smoke test spawns the built bundle, so a bare `bun test` in a clean checkout fails until `dist/acm.mjs` exists.
