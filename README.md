# agent-config-manager

Dashboard that inventories your Claude Code setup across:

1. User-scope plugins/MCP servers/skills (this machine)
2. Skills installed globally via the `npx skills` tool (vercel-labs/skills)
3. Project-scope plugins/MCP servers/skills, scanned across `~/Projects`
4. Standalone environment tools (RTK, Serena, i-have-adhd always-on) that
   need manual setup in every environment

The repo also hosts the `acm` engine: it reads Pi, Codex, and OpenCode config natively so one
harness's configuration can be mirrored into another. See [AGENTS.md](AGENTS.md).

Configuration on claude.ai is deliberately out of scope — see
[docs/adr/0002](docs/adr/0002-no-cloud-config-management.md).

## Usage

All state lives in one SQLite file, `database/dashboard.db`: scan snapshots, the
settings from the `/settings` page. Nothing else is written there.

Scan local state (items 1, 2, 3) into that file:

```
node scan.cjs [projectsRoot]   # defaults to the stored projectsRoot, else ~/Projects
```

Run the dashboard (TanStack Start server reads the newest snapshots through a
server function — see [AGENTS.md](AGENTS.md)):

```
bun install
bun run dev
```

Then open `http://localhost:3000`. The **Rescan now** button runs the same scan
on demand, so the CLI is optional once the page is up.

Build the `acm` engine into the single file its `bin` declares, and run it as a
harness would — any working directory, Node ≥ 22.5, no Bun needed at runtime:

```
bun run build:acm               # emits dist/acm.mjs
node dist/acm.mjs list          # or `acm list` once linked
```

## Container

The same repo builds a single image (`Dockerfile`) that serves the dashboard and
rescans by itself: one scan at start, then every interval. Bun builds,
`node:22-slim` runs (`bun run build`, then `node tools/entrypoint.mjs`). The
mechanism and mounts are in [docs/dashboard.md](docs/dashboard.md); hosting is
undecided while the engine rearchitecture lands.

```
docker build -t agent-config-manager .
docker run -d --name acm \
  -p 127.0.0.1:3000:3000 \
  -e HOST_HOME=/home/you \
  -v /home/you:/home/you:ro \
  -v "$PWD/database:/app/database" \
  agent-config-manager
```

The container runs as uid/gid `1000`, so the data directory it writes to must be
owned by that uid (`sudo chown -R 1000:1000 database` if yours is not). The two
mounts are all it needs. `HOST_HOME` is the only host-specific value:
it is the home directory mounted at its own absolute path inside the container
(so absolute skip paths keep meaning) and it becomes the container's `HOME`.
The data directory stays the host's `database/`, so `dashboard.db` remains
visible and droppable from the host.

## Data: back up, restore, reset

`database/` is the whole of the app's state. One file to copy, one file to
delete.

| Task | Command |
| --- | --- |
| Back up | `docker stop acm && node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('database/dashboard.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()" && cp database/dashboard.db ~/dashboard-backup.db` |
| Restore | `docker stop acm && rm -f database/dashboard.db-wal database/dashboard.db-shm && cp ~/dashboard-backup.db database/dashboard.db && docker start acm` |
| Reset | `docker stop acm && rm -f database/dashboard.db database/dashboard.db-wal database/dashboard.db-shm && docker start acm` |

Stop the container first. The store runs in WAL mode, so committed rows can still live in
`dashboard.db-wal` rather than the main file; the checkpoint folds them in before the copy. If
you skip the checkpoint, copy `dashboard.db-wal` as well, and restore both. A leftover `-wal`
beside a replaced `dashboard.db` belongs to the old file, which is why restore and reset delete
the sidecars rather than let SQLite replay them. A reset leaves an empty store; the scanner's
first run recreates the snapshot and the dashboard shows the "no scan stored yet" message until
then, with settings back on their defaults.

Upgrading from a pre-SQLite install: delete `database/local.json`,
`database/scan-config.json` and `database/env-tools.json`. Nothing reads them
any more — `dashboard.db` is the whole store.

For `bun run dev` against the same data, use the same commands without the
`docker` prefix.

| Env | Default | Meaning |
| --- | --- | --- |
| `HOST_HOME` | unset (container `HOME`) | Scanned home directory, must be the container path the host home is mounted at |
| `PROJECTS_ROOT` | `~/Projects` | Projects directory to scan; a stored `projectsRoot` wins over it |
| `SCAN_INTERVAL_MINUTES` | `15` | Rescan cadence; a stored `scanIntervalMinutes` wins over it |
| `PUBLIC_ORIGIN` | unset | This dashboard's public origin, e.g. `http://acm.localhost`; **required behind a proxy** — the origin guard trusts only the received URL's origin plus this value, never forwarded headers |
| `PORT` | `3000` | Listen port inside the container (and for `tools/serve.mjs` locally) |
| `HOST` | `0.0.0.0` | Listen hostname for `tools/serve.mjs` in the container |

## Notes

- `database/` holds real (redacted) local config and is gitignored — its
  `dashboard.db` is written by `scan.cjs` and the settings page.
- Plugins are listed by marketplace, with their enabled state and version, and
  their skills collapsed into a dropdown per plugin. Standalone skills are a
  separate list.
- claude.ai connectors (Figma, Notion, Google Drive, etc.) are **not**
  scanned or scraped. They sync automatically into Claude Code's local MCP
  server list (confirmed via `claude mcp list`, which shows them as
  `claude.ai <Name>`) without ever being written to `~/.claude.json`. The MCP
  servers section only lists what `scan.cjs` found in `~/.claude.json`.
- MCP server credentials (env vars / headers matching token/key/secret/
  password/authorization/credential/bearer) are masked to their last 4
  characters before the snapshot is stored. This does not
  scan for secrets embedded inline in `command`/`args` strings.
- Project scanning treats any directory containing `.git` as a project
  boundary and does not recurse further into it, so nested checkouts inside
  a repo (if any) aren't scanned separately.
- The `skip paths` and `scan interval` values live in the database `config`
  table and are edited on the `/settings` page (skip paths are absolute paths
  not descended into, and not written to the snapshot). Each rescan resolves
  its interval from the stored `scanIntervalMinutes` first, then
  `SCAN_INTERVAL_MINUTES`, then a 15-minute default, floored at one minute —
  so saving takes effect on the next tick with no restart. An install that has
  never been configured has no config rows and scans `~/Projects` every 15
  minutes. An interrupted scan leaves the previous snapshot readable, because
  a snapshot is committed in one transaction.
- The environment tools list is also stored config, edited on `/settings`:
  each tool has a `checkCommand` (run locally via the shell; exit code 0 means
  installed) and an `installCommand` shown as-is in the Environment tools
  section, for setting the tool up on a machine that lacks it. The tool id
  follows its name.
  npx skills is a subsection of Environment tools, not its own section —
  each `npx skills` entry gets a per-skill install command,
  auto-generated from `~/.agents/.skill-lock.json` (no config needed, it's
  derived, not stored config like the env tools): `npx skills add
  <source> --skill "<name>" -g -a claude-code -y` (per the vercel-labs/skills
  CLI docs — `-g` installs at user/global scope, `-a claude-code` targets
  Claude Code, `-y` skips confirmation prompts for non-interactive/CI use).
  One "Copy install commands" button covers both: each env tool gets its own
  `# <name>` comment, while all npx-skills commands share a single
  `# npx skills` comment rather than one per skill.

## Tests

```
bun run test   # builds dist/acm.mjs, then bun test over the source and that bundle
```
