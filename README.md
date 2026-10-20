# agent-config-manager

Dashboard that inventories your Claude Code setup across:

1. User-scope plugins/MCP servers/skills (this machine)
2. Skills installed globally via the `npx skills` tool (vercel-labs/skills)
3. Plugins/skills configured on claude.ai (cloud) — not MCP connectors, see notes
4. Project-scope plugins/MCP servers/skills, scanned across `~/Projects`
5. Standalone environment tools (RTK, Serena, i-have-adhd always-on) that
   need manual setup in every environment, local and cloud alike

## Usage

All state lives in one SQLite file, `database/dashboard.db`: scan snapshots, the
settings from the `/settings` page, and your comments. Nothing else is written
there except the cloud drop file below.

Scan local state (items 1, 2, 4) into that file:

```
node scan.cjs [projectsRoot]   # defaults to the stored projectsRoot, else ~/Projects
```

Refresh cloud state (item 3) — ask Claude to run the `/refresh-cloud` slash
command. It uses browser automation to scrape claude.ai and writes
`database/cloud.json`; the scanner ingests that file into the database on its
next run. This step is agent-driven, not part of `scan.cjs`.

Run the dashboard (TanStack Start server reads the newest snapshots through a
server function — see [AGENTS.md](AGENTS.md)):

```
bun install
bun run dev
```

Then open `http://localhost:3000`. The **Rescan now** button runs the same scan
on demand, so the CLI is optional once the page is up.

## Container

The same repo builds a single image (`Dockerfile`) that serves the dashboard and
rescans by itself: one scan at start, then every interval. Bun builds,
`node:22-slim` runs (`bun run build`, then `node tools/entrypoint.mjs`).

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
The data directory stays the host's `database/`, so `dashboard.db` and
`cloud.json` remain visible and droppable from the host.

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
then, with settings back on their defaults. `cloud.json` is not part of the store — it is the
drop point for `/refresh-cloud` and can be deleted at any time.

Upgrading from a pre-SQLite install: delete `database/local.json`,
`database/scan-config.json` and `database/env-tools.json`. Nothing reads them
any more — `dashboard.db` is the whole store.

For `bun run dev` against the same data, use the same commands without the
`docker` prefix.

| Env | Default | Meaning |
| --- | --- | --- |
| `HOST_HOME` | unset (container `HOME`) | Scanned home directory, must equal the read-only mount path |
| `PROJECTS_ROOT` | `~/Projects` | Projects directory to scan; a stored `projectsRoot` wins over it |
| `SCAN_INTERVAL_MINUTES` | `15` | Rescan cadence; a stored `scanIntervalMinutes` wins over it |
| `PUBLIC_ORIGIN` | unset | This dashboard's public origin, e.g. `http://acm.localhost`; **required behind a proxy** — the origin guard trusts only the received URL's origin plus this value, never forwarded headers |
| `PORT` | `3000` | Listen port inside the container (and for `tools/serve.mjs` locally) |
| `HOST` | `0.0.0.0` | Listen hostname for `tools/serve.mjs` in the container |

### Deploying to Dokploy

This machine's deployment target is a Dokploy Application built from this
repo's `Dockerfile`, served at `http://acm.localhost` (Traefik, HTTPS off) with
the container port also published on the host as a fallback. The recipe — real
values, mounts, env, port, domain, auto-deploy, rollback by commit, and the
local restart/crash proof — is in [docs/deploy-dokploy.md](docs/deploy-dokploy.md).

## Notes

- `database/` holds real (redacted) local config and is gitignored — its
  `dashboard.db` is written by `scan.cjs` and the settings page, and
  `cloud.json` by `/refresh-cloud`.
- Plugins/skills are matched between user-scope and cloud (by marketplace or
  name) and rendered in one row. An unmatched entry gets a red-highlighted
  "missing" cell with a comment input to note why. Comments are stored in the
  database, so they follow the browser and survive clearing site data. When a
  whole plugin marketplace group is missing on one side, the comment input
  appears once on the group row instead of once per plugin.
- claude.ai connectors (Figma, Notion, Google Drive, etc.) are **not**
  scanned or scraped. They sync automatically into Claude Code's local MCP
  server list (confirmed via `claude mcp list`, which shows them as
  `claude.ai <Name>`) without ever being written to `~/.claude.json` —
  tracking them as separate "cloud" data produced false "missing from user
  scope" flags. The MCP servers section only lists what `scan.cjs` found in
  `~/.claude.json`.
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
  section for setting up a cloud/remote session. The tool id follows its name.
  npx skills is a subsection of Environment tools, not its own section —
  each `npx skills` entry gets a per-skill Cloud install command,
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
bun run test   # node --test, no test dependency
```
