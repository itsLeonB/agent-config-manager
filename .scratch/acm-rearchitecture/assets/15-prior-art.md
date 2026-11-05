# Prior art: engine + MCP server + UI packaging (facts + citations)

Asset for [Prior art: how comparable tools package an engine + MCP server + UI](../issues/15-prior-art-engine-mcp-ui-packaging.md).
Researched 2026-11-05 against each project's own source, manifest, or spec. No blog posts, no
secondary summaries. **No decisions are recorded here** — ticket 14 owns those.

How the evidence was gathered: repository source at `main` (paths cited as `owner/repo/blob/main/...`),
the MCP Bundle spec, the SQLite spec, and the two MCP servers this machine actually ships
(`~/.codex/plugins/cache/openai-bundled/codex-app-tools/26.1027.51404/`,
`~/.pi/agent/npm/node_modules/context-mode/`) — those two are first-party artifacts of a host, so
they count as primary for the spawn-shape question. Line numbers refer to the files as read on
2026-11-05.

## 0. Corpus: what was kept, and why

| Kept | Why (one line) |
|---|---|
| **MCPB** (`modelcontextprotocol/mcpb`) | The official answer to "host ships/runs a server the user never builds"; defines runtime provisioning per language. |
| **Codex desktop + `codex-app-tools` plugin** | The only case found where a UI **owns** the engine and the MCP server is a thin shim; verifiable locally, not from docs. |
| **Serena** | Closest structural match to what ticket 14 is weighing: one install, subcommand MCP entry, in-process web dashboard, per-harness `setup` command. |
| **mcpm** (`pathintegral-institute/mcpm.sh`) | The most concrete file-writing multi-harness config model: one manager class per client, three base classes by file format. |
| **1MCP** (`1mcp-app/agent`) | Single-writer runtime with explicit ownership/generation claims + stdio proxy + single-file SEA binaries + an admin SPA. |
| **Continue** | Engine hosted inside the UI process (extension), plus a distinct third strategy for foreign config: import and normalize, never write. |

Dropped, one line each: **Cherry Studio / Jan / ChatWise** — closed or heavy internals, no cheap
primary source within this ticket's budget, and Codex already covers "Electron app owns engine".
**metamcp / mcpbundler** — sites are marketing pages, no source read. **Claude Code `.mcp.json`,
OpenCode, Pi** — used inline as spawn-shape/host evidence instead of a full block (Continue's
importer already parses the Claude-desktop/Claude-code schema, and this machine's Pi config is the
live example of the bare-command shape).

---

## 1. MCPB — bundles as the host's unit of installation

Source: [`README.md`](https://github.com/modelcontextprotocol/mcpb/blob/main/README.md),
[`MANIFEST.md`](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).

- **Topology.** No daemon, no shared store. A bundle is a zip of the server plus `manifest.json`;
  the *host application* (Claude for macOS/Windows) installs it and launches it. One child per
  installed bundle per host session. Nothing in the spec gives two processes anything to share, so
  the concurrency question does not exist at this layer.
- **Spawn shape.** Four declared server types — `node`, `python`, `binary`, `uv` (MANIFEST.md §
  Server Types). The manifest carries the command: `server.mcp_config.command` is `"node"` in the
  spec's own example, with dependencies bundled in `node_modules/`; `python` requires packages under
  `server/lib/` or a full `server/venv/` and "cannot portably bundle compiled dependencies (e.g.
  pydantic)"; `binary` wants static linking; `uv` (v0.4+) ships only `pyproject.toml` and the host
  installs the deps — for `uv`, `mcp_config` is *optional* because "host manages execution".
  Compatibility floors live in `compatibility.runtimes.{node,python}`.
- **What breaks.** The command `node` is not resolved against the user's PATH by accident of luck:
  the README recommends Node "to reduce installation friction… Node.js ships with Claude for macOS
  and Windows". So the host supplies the interpreter and the bundle supplies the code. The failure
  mode that remains is the Python one the spec admits to — compiled deps cannot be bundled, hence
  the `uv` type.
- **Engine vs MCP entry.** They are the same artifact. There is no engine to reach from a CLI, and
  therefore no boundary to defend: the host *is* the boundary.
- **UI shape and what it bought.** None. The product is the host's install dialog, `user_config`
  prompts, and auto-update. Cost: the bundle path buys nothing for a user who wants a terminal.
- **Multi-harness config.** Out of scope by design — one bundle per host. `user_config` values are
  interpolated into the *host's* config via `${user_config.api_key}`, not written into a foreign
  harness's file.

## 2. Codex desktop + `codex-app-tools` plugin (local primary evidence)

Sources: `~/.codex/plugins/cache/openai-bundled/codex-app-tools/26.1027.51404/` (`plugin.json`,
`.mcp.json`, `scripts/launch_codex_app_tools_mcp`, `server.mjs`), `~/.codex/config.toml`, and
`codex mcp list --json` on this machine.

- **Topology.** The Electron app owns the engine and all state. The MCP server is a **stdio↔local
  socket shim**: `server.mjs` reads `CODEX_APP_TOOLS_PIPE_PATH` (line 34695) and calls
  `net.createConnection(this.pipePath)` (line 34833). Each harness session spawns its own shim
  process; the shims talk to the single app instance over the socket and write no database. The
  packaged app is an Electron app (`/usr/lib/chatgpt/resources/app.asar`) and ships its own runtime:
  `cua_node/bin/node` is a 127 MB Node binary under the app resources.
- **Spawn shape.** Absolute command + **relative entry** + pinned cwd, in
  `.mcp.json`: `command` is the absolute path to `scripts/launch_codex_app_tools_mcp`, `args` is
  `["./server.mjs"]`, `cwd` is the absolute plugin version directory. The launcher is `/bin/sh` and
  resolves the interpreter itself: it resets `PATH` to a fixed prefix, then tries
  `CODEX_MCP_NODE_PATH`, `CODEX_BROWSER_USE_NODE_PATH`, `${CODEX_ELECTRON_RESOURCES_PATH}/cua_node/bin/node`,
  a `CODEX_CLI_PATH`-relative `cua_node/bin/node`, and
  `$XDG_CACHE_HOME/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`; only then bare
  `command -v node`; otherwise `exit 127` with "could not find a Node runtime. Reinstall or update
  Codex."
  A second, different shape exists on the same machine — `cua_repl` runs
  `/usr/lib/chatgpt/resources/cua_node/bin/node --import file:///…/require-browser-access.mjs
  /usr/lib/chatgpt/resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs`: interpreter
  and entry both inside the app bundle, with an absolute `file://` ESM preload.
  `server.mjs` is a single 1.3 MB pre-bundled ESM file with dependencies inlined (`@modelcontextprotocol/server`
  appears as inlined code, not as a `node_modules` entry).
- **What breaks.** The absolute path contains the version (`…/26.1027.51404/`), so every path is
  re-materialised per upgrade; `cwd` pinning is what makes the relative `./server.mjs` work at all;
  the launcher exists specifically because the harness's environment cannot be trusted to have
  `node`; `env_vars` is an explicit allowlist of parent variables to forward
  (`CODEX_APP_TOOLS_PIPE_PATH`, `CODEX_MCP_NODE_PATH`, `HOME`, `PATH`, …), not an inherit-all; and
  `startup_timeout_sec: 10` / `tool_timeout_sec: 3600` are per-server knobs a long-running tool needs.
- **Engine vs MCP entry.** Separate artifacts in separate delivery channels: the plugin ships
  `server.mjs` + `.mcp.json` (`.codex-plugin/plugin.json` points at it via `"mcpServers": "./.mcp.json"`),
  the app ships the runtime and the engine. The boundary is an IPC protocol, not a packaging rule —
  nothing stops the shim importing app code, because nothing can.
- **UI shape and what it cost.** The Electron app *is* the engine owner. Consequences visible in the
  shipped manifest: the server ships `"enabled": false`, `default_tools_approval_mode: "approve"`,
  and per-tool `approval_mode: "prompt"` for every tool that mutates app state. Tools are only useful
  while the app runs.
- **Multi-harness config.** Codex is a *target* for others, not a writer: it reads
  `[mcp_servers.<name>] {command, args, env, env_vars, startup_timeout_sec}` from
  `~/.codex/config.toml` (`codex mcp list --json` prints exactly that shape).

## 3. Serena — one install, MCP as a subcommand, dashboard inside the server process

Sources: [`src/serena/config/client_setup.py`](https://github.com/oraios/serena/blob/main/src/serena/config/client_setup.py),
[`pyproject.toml`](https://github.com/oraios/serena/blob/main/pyproject.toml),
[dashboard docs](https://github.com/oraios/serena/blob/main/docs/02-usage/060_dashboard.md),
[client docs](https://github.com/oraios/serena/blob/main/docs/02-usage/030_clients.md).

- **Topology.** One process per harness session (`serena start-mcp-server …`), no daemon, and no
  single-writer store to arbitrate: state is `serena_config.yml` (global) plus project-local
  `.serena/project.yml` and memories. Multiple instances are *expected* — the dashboard docs state
  the port is 24282 "but a higher port may be used if the default port is unavailable/multiple
  instances are running".
- **Spawn shape.** `uv tool install -p 3.13 serena-agent`, then a **bare command name on PATH**:
  `serena start-mcp-server --context=codex --project-from-cwd` becomes Codex's
  `command`/`args` (docs, Codex section). What breaks: it depends on uv's shim directory being on the
  harness's spawn PATH; the README explicitly warns against installing via an MCP/plugin marketplace
  because those "contain outdated and suboptimal installation commands"; the VS Code section
  documents a per-host argument difference (`--project ${workspaceFolder}` vs `--project-from-cwd`)
  tied to a VS Code issue.
- **Engine vs MCP entry.** Same package, same module graph: `pyproject.toml` declares one script
  set (`serena = "serena.cli:top_level"`, plus `serena-agent`, `serena-hooks`), and both the MCP entry
  and the admin commands are subcommands of it (`start-mcp-server`, `setup <client>`, `project …`).
  `--context=<harness>` specializes the tool surface per host rather than shipping per-host code.
  No import boundary is enforced or needed.
- **UI shape and what it bought.** The dashboard is a **web app hosted inside the MCP server
  process**, reachable at `http://localhost:24282/dashboard/index.html`, opened through one of three
  wrappers: a native app wrapper with tray icon, a tray manager that aggregates multiple instances,
  or the default browser (configurable via `web_dashboard_interface`). It shows live tool calls,
  edits `serena_config.yml` / `project.yml` / memories, and can **shut down the MCP server**. Costs:
  one HTTP listener per session with port fallback, UI lifetime tied to the session, and the
  aggregation problem pushed into a separate tray manager.
- **Multi-harness config.** `serena setup <client>` — one `ClientSetupHandler` subclass per harness,
  and each one **shells out to that harness's own CLI** instead of writing its file:
  `claude mcp add --scope user serena -- …`, `codex mcp add serena -- …`,
  `codebuddy mcp add --scope user serena -- …`, `grok mcp add --scope user serena -- …`.
  Applicability is probed by running `<cli> --version` (and for Grok, `grok mcp add --help` and a
  stdout prefix check). Per-harness differences are modelled as `--context=<name>` plus the client's
  own flags — the file formats stay the harness's problem.

## 4. mcpm — one engine, fifteen client config formats, written directly

Sources: [`clients/base.py`](https://github.com/pathintegral-institute/mcpm.sh/blob/main/src/mcpm/clients/base.py),
[`clients/client_registry.py`](https://github.com/pathintegral-institute/mcpm.sh/blob/main/src/mcpm/clients/client_registry.py),
[`managers/codex_cli.py`](https://github.com/pathintegral-institute/mcpm.sh/blob/main/src/mcpm/clients/managers/codex_cli.py),
[`managers/opencode.py`](https://github.com/pathintegral-institute/mcpm.sh/blob/main/src/mcpm/clients/managers/opencode.py),
[`managers/vscode.py`](https://github.com/pathintegral-institute/mcpm.sh/blob/main/src/mcpm/clients/managers/vscode.py),
[`managers/continue_extension.py`](https://github.com/pathintegral-institute/mcpm.sh/blob/main/src/mcpm/clients/managers/continue_extension.py).

- **Topology.** Stateless CLI over on-disk config; no daemon and no database. A daemon appears only
  when it deliberately runs someone else's servers (`mcpm run`, `mcpm profile run`, `mcpm share`).
  Two `mcpm` processes editing the same client file are last-write-wins — nothing serialises them.
- **Spawn shape.** Distribution is `curl | bash`, brew, pipx, uv (`README`). The servers it installs
  are addressed as source kinds it knows how to update: git (`git pull --ff-only`), npx/uvx
  (auto-update at runtime), binary.
- **Engine vs MCP entry.** mcpm is a **manager, not an MCP server** (a FastMCP proxy module exists
  for sharing, but the product is the CLI). Complete separation; no boundary question.
- **UI shape.** CLI/TUI only. No desktop or web surface.
- **Multi-harness config.** This is the useful part. `ClientRegistry._CLIENT_MANAGERS` maps 15 client
  keys to manager classes; three abstract bases by *file format* (`BaseClientManager`,
  `JSONClientManager`, `YAMLClientManager`), and each manager declares two knobs —
  `client_key`, `configure_key_name` — plus `to_client_format` / `from_client_format`. Concrete
  per-harness deltas the code encodes:
  - container key: `mcpServers` (Claude Desktop) vs `mcp_servers` (Codex) vs `mcp` (OpenCode) vs
    `servers` (VS Code);
  - **Codex is TOML**, handled by overriding `_load_config`/`_save_config` on the JSON base with
    `tomli`/`tomli_w` — a `JSONClientManager` subclass that is not JSON;
  - **OpenCode** needs JSONC comment stripping, `type: "local"` with `command` as a *string array*,
    env under `environment`, remote as `type: "remote"`;
  - **VS Code** needs a sibling `inputs: []` array and `type: "stdio"`;
  - **Continue** is YAML through `ruamel` with `preserve_quotes` and 2/4 indent settings, and
    `mcpServers` is a **list**, not an object; the workspace `.continue/config.yaml` wins over
    `~/.continue/config.yaml` when it exists;
  - install detection is `shutil.which("<cli>")`; paths are per-OS (APPDATA / Library / `~/.config`).
  Files are written directly (json.dump / tomli_w / ruamel) — no harness CLI is invoked.

## 5. 1MCP — single runtime with ownership claims, and two spawn channels

Sources: [`src/commands/serve/cooperativeRuntime.ts`](https://github.com/1mcp-app/agent/blob/main/src/commands/serve/cooperativeRuntime.ts),
[`src/commands/serve/runtimeScope.ts`](https://github.com/1mcp-app/agent/blob/main/src/commands/serve/runtimeScope.ts),
[`src/commands/cliSetup/setupFiles.ts`](https://github.com/1mcp-app/agent/blob/main/src/commands/cliSetup/setupFiles.ts),
[`package.json`](https://github.com/1mcp-app/agent/blob/main/package.json),
[`sea-config.json`](https://github.com/1mcp-app/agent/blob/main/sea-config.json).

- **Topology.** One long-lived `1mcp serve` runtime per **Runtime Scope**, where the scope is simply
  the directory of the config file in use (`runtimeScope: path.dirname(configFilePath)`). Ownership is
  explicit: a claim record with a `claimId` generation, PIDs for supervisor and worker, and a control
  endpoint. A second runtime that finds the scope owned refuses — "A runtime already owns this
  Runtime Scope or ownership is uncertain… no takeover was attempted" — recovers only *stale*
  records, and retains ownership rather than guessing when a stop cannot be confirmed (30 s budget).
  Clients reach the runtime over streamable HTTP (`http://127.0.0.1:3050/mcp?app=<client>`) or
  through `1mcp proxy`, which is a stdio child that bridges to the HTTP runtime.
- **Spawn shape.** Two channels for the same code: (a) npm global — `bin: {"1mcp": "./build/index.js"}`,
  i.e. needs the user's Node; (b) **per-platform single-file binaries** built as Node SEA
  (`sea-config.json`, `sea:binary:{macos,macos:x64,linux,linux:arm64,win,win:arm64}`), i.e. no Node on
  the machine at all. What breaks: channel (a) depends on the npm prefix being on PATH and on the
  user's Node version; channel (b) multiplies release artifacts per platform/arch; and every stdio
  client behind the runtime inherits the runtime's liveness — the README says CLI mode "requires a
  running `1mcp serve` instance", and the proxy "still depends on serve".
- **Engine vs MCP entry.** One package, one bin, several subcommands: `serve` (the runtime), `proxy`
  (stdio bridge), the agent-facing `cli` mode (`instructions`/`inspect`/`run`), and `admin`. No import
  boundary is enforced; the boundary is process + HTTP + a config file.
- **UI shape and what it bought.** A React admin console (`web/admin/…`) served by the runtime, with
  an admin API that includes backend restart (`adminBackendRestartService.ts`). The UI owns engine
  lifecycle by talking to the runtime's own control surface — it does not embed the engine. Cost: the
  UI has no data unless the runtime is up, and it shares the runtime's fate.
- **Multi-harness config.** `1mcp cli-setup --codex` or `--claude` (exactly one target per call,
  enforced). It writes **support files, not MCP config**: a managed doc (`.codex/1MCP.md` /
  `.claude/1MCP.md`), a hook file (`.codex/hooks.json` / `.claude/settings.json`, read with **JSON5**
  and upserted so user content survives), a startup doc (`AGENTS.md` / `CLAUDE.md`), and a skill under
  `.agents/skills` / `.claude/skills` — with separate global and `--scope repo` path tables.
  For Codex it **refuses to patch `config.toml`** and prints the block the user must add
  (`approval_policy`, `sandbox_mode`, `[sandbox_workspace_write] network_access`,
  `[features] codex_hooks`), because the keys it needs sit outside `mcp_servers`.

## 6. Continue — engine inside the editor, foreign config imported not written

Sources: [`core/context/mcp/MCPConnection.ts`](https://github.com/continuedev/continue/blob/main/core/context/mcp/MCPConnection.ts),
[`core/context/mcp/json/loadJsonMcpConfigs.ts`](https://github.com/continuedev/continue/blob/main/core/context/mcp/json/loadJsonMcpConfigs.ts),
[`packages/config-yaml/src/schemas/mcp/convertJson.ts`](https://github.com/continuedev/continue/blob/main/packages/config-yaml/src/schemas/mcp/convertJson.ts).

- **Topology.** The engine lives in the host process (`MCPManagerSingleton`); MCP servers are child
  processes spawned per connection. Shared state is config files (`~/.continue/config.yaml`,
  workspace `.continue/`), not a database, so there is no single-writer arbitration to document.
- **Spawn shape.** `command`/`args`/`env` from its own YAML, launched with the official SDK's
  `StdioClientTransport`. Host-specific repairs the code has to make: on Windows a batch-script
  command is wrapped as `cmd.exe /c <command> <args>` (unless the window is attached to a WSL remote);
  `cwd` defaults to the workspace root and falls back to the user's home directory when the workspace
  is remote; env is `COMMONS_ENV_VARS` passlist plus per-server `env`; a spawn `ENOENT` is mapped to
  "command not found — install the {uv,uvx,node,npx} CLI".
- **Engine vs MCP entry.** Separate packages in one monorepo (`core`, `gui`, `extensions/vscode`,
  `extensions/cli`, `packages/config-yaml`); the schema package is the contract between them.
- **UI shape and what it bought.** A VS Code extension plus a GUI — the UI *is* the host process, so
  it owns the engine by construction and pays for it: MCP servers die with the window, and the only
  non-GUI path is a separate CLI extension.
- **Multi-harness config.** Two moves, neither of which writes another harness's file:
  (1) **import** — `loadJsonMcpConfigs` scans `~/.continue/mcpServers` and workspace
  `.continue/mcpServers`, skipping `config.json`/`settings.json`, and tries each JSON file as either a
  "claude-code-like" schema (which also carries `projects`) or a "claude-desktop-like" schema;
  (2) **normalize** — `convertJson` maps the foreign shape into Continue's own schema: `${VAR}`
  becomes `${{ secrets.VAR }}`, `command` becomes `type: stdio`, `url` becomes sse/http, env files are
  dropped with a warning ("envFile is not supported in Continue MCP configuration").

---

## 7. Option space

### 7a. Topology × spawn × UI × config writing

| Project | Topology | Spawn shape | Engine vs MCP entry | UI | Foreign config writing |
|---|---|---|---|---|---|
| MCPB | one child per bundle per host | manifest + host-provided runtime (`node` ships with host), or bundled `node_modules`/venv/binary | same artifact | none — host is the UI | none |
| Codex (plugin) | Electron app owns engine; N shim processes ↔ one app over unix socket | absolute sh `/bin/sh` launcher + `cwd` pin + relative `./server.mjs`; bundled node inside app | separate artifacts, IPC boundary | Electron app owns engine | n/a (is a target) |
| Serena | one process per session, no daemon; shared YAML config; multi-instance expected | bare `serena` on PATH (`uv tool install`); `--context=<harness>` | same package, subcommands | web dashboard **inside** the MCP process; tray wrapper can aggregate | shells out to each harness CLI (`claude/codex/grok mcp add`) |
| mcpm | stateless CLI, no daemon | brew/pipx/uv/curl | manager, not a server | CLI/TUI | writes files directly; 15 clients; JSON/YAML/TOML/JSONC |
| 1MCP | **one runtime per config dir**, ownership claims + generations; clients via HTTP or `proxy` | npm bin **and** per-platform SEA binaries | one package, many subcommands | React admin SPA served by the runtime; can restart backend | writes support files only (hooks/docs/skills), refuses `config.toml`, prints instructions |
| Continue | engine in host process, children per server | `StdioClientTransport`; `cmd.exe /c` on Windows; cwd = workspace | monorepo packages, schema contract | VS Code extension / GUI owns engine | imports + normalizes foreign JSON; writes nothing foreign |

### 7b. Spawn shape → what actually breaks

| Shape | Who resolves the interpreter | Failure mode | Seen in |
|---|---|---|---|
| Absolute interpreter + absolute entry | the installer | path baked with a version; breaks on upgrade | Codex `cua_repl` (`…/cua_node/bin/node …/cua-repl.mjs`) |
| Launcher script + `cwd` pin + relative entry | a shell shim that probes 5 candidates then PATH | no `node` anywhere → `exit 127` with a reinstall message | Codex `codex-app-tools` |
| Bare command name on PATH | the user's install (uv/npm/pipx shim dir) | harness spawns with a different PATH than the shell → `ENOENT` | Serena (`serena …`), Pi (`context-mode`), Codex `serena` entry |
| `npx`/`uvx` at spawn time | the package manager, per launch | first-run download; needs network + registry trust; version drift | mcpm's "npx/uvx auto-update at runtime" category; Continue's ENOENT hint |
| Runtime bundled in the app | the app | only usable while the app is installed | Codex `cua_node` (127 MB `node`) |
| Single-file binary (SEA) | nobody | release matrix per platform/arch | 1MCP `sea-config.json` + `sea:binary:*` |
| Manifest + host-provided runtime | the host app | language-dependent gaps (Python compiled deps) | MCPB |

### 7c. Shared-store concurrency, for the record

- SQLite WAL is a *single-host* mechanism: "All processes using a database must be on the same host
  computer; WAL does not work over a network filesystem" and "there can only be one writer at a time"
  ([sqlite.org/wal.html](https://sqlite.org/wal.html)).
- A live local precedent for an MCP server spawned many times over one SQLite file: context-mode's
  [ADR-0002](https://github.com/mksglu/context-mode/blob/main/docs/architecture/adr/0002-single-db-git-distribution.md)
  — one `context.db` per project, `node:sqlite` with `{timeout: 5000}`, `BEGIN IMMEDIATE` on every
  write transaction, `PRAGMA user_version` migrations run once inside `BEGIN IMMEDIATE`, liveness in
  separate `owners/<server-id>.pid` files rather than in the shared DB, and a measured run of
  8 writers + 4 FTS readers + a 20 MB indexer with **0 busy errors**. It also records that
  `better-sqlite3` was rejected because of recurring native-ABI breakage, and that Node ≥ 24.15.0 is
  required for `node:sqlite` with a sleeping busy `timeout` and FTS5. Its implementation sets
  `journal_mode = WAL` and `busy_timeout` per connection (local package,
  `build/db-base.js:313` and the `busy_timeout` pragma at 237/278).

---

## 8. What this implies for ticket 14 (options only — no decision)

1. **Keep one process per client, WAL-shared SQLite (today's shape, plus the gaps closed).** Cheapest
   continuation: no daemon to supervise, MCP entry is the same code path the dashboard uses. The field
   does this only with discipline: `BEGIN IMMEDIATE` for every write, `busy_timeout`, migrations under
   `user_version` inside a write transaction, and ownership/liveness kept in sidecar files, not in the
   shared tables (context-mode ADR-0002). Cost: every consumer must hold the same discipline forever,
   and the DB must stay on one host — no NFS/network volume.
2. **Single-writer runtime + thin stdio shim (1MCP's shape).** One owner of the store, explicit
   claim/generation records, stale-owner recovery, clients attach over HTTP or through a stdio bridge.
   Buys an unambiguous write owner and one place for the UI to talk to. Cost: a daemon to start, stop
   and supervise, plus the "runtime isn't running" failure mode in every harness — 1MCP answers it
   with a documented preflight (`serve --status`, `--restart`) and still had to build ownership
   recovery.
3. **UI owns the engine, MCP server is a shim (Codex's shape).** Only if the UI becomes a desktop app;
   buys nothing for a server-rendered dashboard, and it costs tool gating (`enabled: false`, approval
   prompts) plus a socket protocol to maintain.
4. **Spawn shape is an independent axis.** The options, each already shipped by someone: absolute
   `process.execPath` + absolute entry (Codex `cua_repl`); launcher shim that probes for a runtime then
   falls back to PATH (Codex plugin); bare command on PATH (Serena, Pi); `npx`/SEA binary (1MCP ships
   both). The observable failure each guards against is the same one: the harness's spawn environment
   has a different PATH and a different cwd than the user's shell.
5. **Config writing is a three-way choice, all three shipped.** Write files directly with one adapter
   per harness (mcpm; 15 clients, three base classes and per-client overrides); shell out to each
   harness's own CLI (Serena `setup <client>`); or import-and-normalize without writing foreign files
   (Continue). A fourth, narrower stance is 1MCP's: write only the files no harness CLI owns (hooks,
   docs, skills) and print instructions for the rest.

---

## 9. Evidence that bears on ticket 14's current assumptions

Facts, not decisions. Each of these contradicts or qualifies something ticket 14 currently assumes.

- **Assumption: "the MCP server will spawn as `process.execPath` + an absolute entry path with `cwd`
  pinned to the repo root."** Codex's own plugin does the *opposite* on two counts: the entry is
  relative (`./server.mjs`) and it works only because `cwd` is pinned to the *plugin version
  directory*, not to a project root — and the interpreter is not `execPath`, it is a shell launcher
  that probes five candidate runtimes before PATH. Pinning `cwd` to the repo root also changes what
  relative paths inside the server mean, and 1MCP demonstrates the alternative: bind the runtime to
  the *config file's* directory and let callers pass `--project <path>` per call.
  (`~/.codex/plugins/cache/openai-bundled/codex-app-tools/26.1027.51404/.mcp.json`,
  [`runtimeScope.ts`](https://github.com/1mcp-app/agent/blob/main/src/commands/serve/runtimeScope.ts),
  [1MCP README worktrees section](https://github.com/1mcp-app/agent/blob/main/README.md))
- **Assumption: "the UI stays a server-rendered web dashboard."** Two shipped designs sit either side
  of it: Serena hosts a web dashboard *inside* the MCP server process (no separate server, port
  fallback when several sessions run, and the dashboard can shut the server down), and 1MCP serves a
  React admin SPA from its runtime with an API that restarts the backend. Both keep "web UI" but move
  *who hosts it* and *who owns the lifecycle*. The only case where a UI owns the engine outright
  (Codex) is a desktop app, and it pays with IPC plumbing and tool gating.
  ([Serena dashboard docs](https://github.com/oraios/serena/blob/main/docs/02-usage/060_dashboard.md),
  [`adminBackendRestartService.ts`](https://github.com/1mcp-app/agent/blob/main/src/domains/admin/adminBackendRestartService.ts))
- **Assumption: "a single SQLite file can be written by both the dashboard process and MCP-server
  processes."** It can, but only under conditions this repo has not yet all met. `store.cjs` already
  sets `journal_mode = WAL` and `busy_timeout = 5000`, yet it has no `BEGIN IMMEDIATE`, no migration
  guard (`user_version` is unread) and no liveness sidecar — the three things context-mode's ADR
  names as load-bearing, and it measures 0 busy errors only with all three plus `{timeout: 5000}`.
  SQLite itself restricts the arrangement to one host: "WAL does not work over a network filesystem"
  — so a bind mount shared from another machine, or a network-backed volume, breaks it, while the
  current same-host bind mount is fine. Version floor: `node:sqlite` with a sleeping busy `timeout`
  needs Node ≥ 24.15.0 per that ADR's measurement (this repo's `node:sqlite` usage and the container's
  Node 22 deserve a check before relying on it).
- **Not assumed but worth knowing:** for Codex, the MCP keys are not the whole config surface — 1MCP
  refuses to patch `config.toml` and prints the block, and Serena shells out to `codex mcp add` — so a
  design that writes Codex config directly owns keys (`approval_policy`, `sandbox_mode`,
  `features.codex_hooks`) that are not about MCP at all.

## 10. Sources

- MCPB: <https://github.com/modelcontextprotocol/mcpb/blob/main/README.md>, <https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md>
- Codex local artifacts: `~/.codex/plugins/cache/openai-bundled/codex-app-tools/26.1027.51404/{.codex-plugin/plugin.json,.mcp.json,scripts/launch_codex_app_tools_mcp,server.mjs}`, `~/.codex/config.toml`, `codex mcp list --json`
- Serena: <https://github.com/oraios/serena/blob/main/src/serena/config/client_setup.py>, <https://github.com/oraios/serena/blob/main/pyproject.toml>, <https://github.com/oraios/serena/blob/main/docs/02-usage/060_dashboard.md>, <https://github.com/oraios/serena/blob/main/docs/02-usage/030_clients.md>
- mcpm: <https://github.com/pathintegral-institute/mcpm.sh/blob/main/src/mcpm/clients/base.py>, `.../client_registry.py`, `.../managers/{codex_cli,opencode,vscode,continue_extension}.py`
- 1MCP: <https://github.com/1mcp-app/agent/blob/main/src/commands/serve/cooperativeRuntime.ts>, `.../serve/runtimeScope.ts`, `.../cliSetup/setupFiles.ts`, `.../package.json`, `.../sea-config.json`, <https://github.com/1mcp-app/agent/blob/main/README.md>
- Continue: <https://github.com/continuedev/continue/blob/main/core/context/mcp/MCPConnection.ts>, `.../core/context/mcp/json/loadJsonMcpConfigs.ts`, `.../packages/config-yaml/src/schemas/mcp/convertJson.ts`
- Pi's spawn shape (bare command / remote URL): `~/.pi/agent/mcp.json`
- SQLite WAL limits: <https://sqlite.org/wal.html>
- Multi-writer SQLite contract for a multi-client MCP server: <https://github.com/mksglu/context-mode/blob/main/docs/architecture/adr/0002-single-db-git-distribution.md>; implementation `~/.pi/agent/npm/node_modules/context-mode/build/db-base.js`
