# OpenCode native configuration surface

Research date: 2026-11-05. Harness version inspected: **opencode v2.2.5**
(`/home/leon/.opencode/bin/opencode`, a 252 MB Bun-compiled ELF; npm `@opencode/cli@2.2.5` is the
matching v2 package — v1 still publishes as `opencode-ai@1.19.5`, so the two channels do not share
a package name).

Answers `.scratch/acm-rearchitecture/issues/05-opencode-config-surface.md` — facts only, no decisions.

## Sources

Primary, version-pinned to 2.2.5 — the installed binary itself:

```
opencode --version                    → opencode v2.2.5
opencode --help  + one help call per subcommand   (mcp, plugin, auth, debug, models, session, service, upgrade, uninstall)
opencode debug paths | debug config | debug agents
opencode mcp list | opencode plugin list
opencode api get /api/info            → {"version":"2.2.5", ...}
strings /home/leon/.opencode/bin/opencode   (env-var names, schema URLs)
```

Official v2 documentation (the `/docs/` tree still carries the v1 banner "OpenCode v2 is now
available"; v2 lives under `/v2/docs/`):

- <https://opencode.ai/v2/docs/config>, `/mcp-servers`, `/plugins`, `/agents`, `/commands`,
  `/skills`, `/instructions`, `/policies`, `/troubleshooting`
- <https://opencode.ai/v2/docs/migrate-v1> — the V1→V2 field-by-field contract
- <https://opencode.ai/v2/docs/build/plugins> and `/build/plugins/server` — plugin/hook API
- Machine-readable schema the docs name as source of truth: <https://opencode.ai/config.json>
  (fetched 2026-11-05; top-level keys + `$defs`), and the CLI schema
  `https://opencode.ai/v2/cli.json` (the literal constant in the 2.2.5 binary).

Official repo named in the docs site: <https://github.com/anomalyco/opencode> (v2 branch layout
**unverified** — not consulted for this note).

Corroborating local evidence: `~/.config/opencode/` (`opencode.json`, `plugins/`, `vendor/`,
`service.json`), `~/.opencode/` (only `bin/`), `opencode plugin list`, and seven throwaway
`/tmp` sandboxes exercised against 2.2.5 (write behaviour in §4). No project-scope
`opencode.json(c)` exists anywhere under `~/Projects`, so project behaviour is documented +
sandbox-verified only.

## 1. Config locations and formats, per scope

Formats: **JSON and JSONC** (comments and trailing commas allowed), plus Markdown+frontmatter for
agents/commands/skills and TypeScript/JavaScript for plugins. `$schema` is
`https://opencode.ai/config.json` (v2 docs §Format; observed in every file on this machine).

Tiers, lowest → highest precedence (`/v2/docs/config` §Locations; `debug config` emits this same
order as an array, and later entries win):

| Tier | Location | Notes |
|---|---|---|
| managed/system | `/etc/opencode/opencode.json(c)` (+ `agents/ commands/ skills/ plugins/`); macOS MDM `ai.opencode.managed` plist | **outranks global *and* project** — inverted vs most harnesses. Root-only to write |
| global | `~/.config/opencode/opencode.json(c)` + resource dirs | `XDG_CONFIG_HOME`-aware (`debug paths` → `config`) |
| global (2nd, undocumented) | `~/.opencode/opencode.json(c)` + resource dirs | real in 2.2.5, absent from the v2 docs location table — see §5 |
| custom (env) | `OPENCODE_CONFIG=/path/file.json` | single document; undocumented in v2 docs, live in 2.2.5 (verified) |
| project chain | every `opencode.json(c)` from filesystem root down to cwd, **then** every
`.opencode/opencode.json(c)` in the same order | "every discovered `.opencode` config overrides every direct config" |
| inline (env) | `OPENCODE_CONFIG_CONTENT='{...}'` | highest of the file tiers in observed order |

Project-scope resource dirs: `<project>/.opencode/{agents,commands,skills,plugins,tools,themes}/`.
Singular names (`agent/`, `command/`, `skill/`, `plugin/`, `mode/`) are still discovered for
backwards compatibility (`/v2/docs/migrate-v1`).

Merge rule, documented: sources are merged in order, later overrides earlier, and "Settings that do
not conflict are preserved" — i.e. per-key merge at the top level, not whole-document replacement.
Nested merge is only described where it matters per category (§2). Arrays behave per key:
`instructions`, `skills`, `plugins` are documented as **combined** across documents; `agents` and
`commands` merge by name in configuration order (`/v2/docs/agents` §Merging, `/v2/docs/commands`
§Loading).

V1's `/docs/config` page documents three further tiers that the v2 page does not repeat: remote
org config from a `.well-known/opencode` endpoint, inline `OPENCODE_CONFIG_CONTENT`, and macOS
managed preferences. `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG_DIR` /
`OPENCODE_CONFIG_PROJECT_DISABLE` all still appear as strings in the 2.2.5 binary; the remote
`.well-known/` fetch is **unverified** in v2 (only the literal `/.well-known/` string is present).

Observed on 2.2.5 (`opencode debug config`, real HOME): exactly three sources —
`~/.config/opencode/opencode.json` (document), `~/.config/opencode` (directory),
`~/.opencode` (directory). The user's global file is **V1-shaped** (`mcp.<name>` with
`enabled: true`, `timeout: 30000`) and is reported normalised as `mcp.servers.<name>` with
`disabled: false`, `timeout: {startup, catalog, execution}` — normalisation is in memory and the
file is not rewritten (`/v2/docs/migrate-v1` §Use your existing configuration).

## 2. How it declares MCP servers, skills, instructions, hooks/plugins, agents/commands

**MCP servers** — JSON key `mcp`, names under `mcp.servers`. "V2 does not place server names
directly under `mcp`" (`/v2/docs/mcp-servers` §Config); the flat V1 form is still accepted
(`config.json` gives `mcp.additionalProperties` the legacy `McpLocalConfig`/`McpRemoteConfig`
shapes as an alternative). Local entries: `type: "local"`, `command: string[]`, `cwd`,
`environment` (map, `{env:NAME}` substitution only — `$NAME` is not expanded), `disabled`,
`codemode`, `timeout`, `protocol`, `pool`. Remote: `type: "remote"`, `url` (absolute Streamable
HTTP), `headers`, `oauth` (object or `false`, snake_case: `client_id`, `client_secret`, `scope`,
`callback_port`, `redirect_uri`, `auth_server_metadata_url`), `disabled`, `codemode`, `timeout`,
`protocol`, `pool`. Note the V2 inversion: **`disabled: true`, there is no `enabled` field** —
`enabled` exists only on the legacy shape. `mcp.timeout.{startup,catalog,execution}` are global
defaults (30 s / 30 s / 12 h); a server's own `timeout` object overrides matching keys.

Merge for MCP is **whole-entry replace by name**: "A higher-precedence project config replaces the
entire server object with the same name … otherwise repeat every required field in the override"
(`/v2/docs/mcp-servers` §Config). There is no field-level patch mode (contrast Pi's patch entry).

**Skills** — Agent Skills: `SKILL.md` (frontmatter `name`, `description`, optional
`metadata.opencode/autoinvoke: false` / `disable-model-invocation`). Discovery is fixed and
cross-harness (`/v2/docs/skills` §Discovery): global `~/.config/opencode/skills`,
`~/.claude/skills`, `~/.agents/skills`; project `.opencode/skills`, `.claude/skills`,
`.agents/skills`, each searched from cwd up to the project root, six directories deep. Skill ID
comes from the path, not the frontmatter name; later sources win by ID. `skills` in config adds
directories or HTTP **catalogs** (a base URL with `index.json`). Note: writing to
`~/.claude/skills` or `~/.agents/skills` is not an OpenCode-scoped write.

**Instructions** — `AGENTS.md` only; the V1 `CLAUDE.md` fallback is gone in V2
(`/v2/docs/instructions`, `/v2/docs/migrate-v1` §Instruction files). Loaded: global
`~/.config/opencode/AGENTS.md`, then every `AGENTS.md` from the workspace up to home (or up to the
project root for workspaces outside home), combined, conflicts unresolved. `instructions: string[]`
in config adds paths, globs (`~/` allowed) and HTTP(S) URLs, appended after `AGENTS.md`, combined
across all config documents. `OPENCODE_DISABLE_PROJECT_CONFIG=1` drops project discovery only.

**Hooks** — **no config surface and no declaration format.** `hooks` is not a top-level key in
`https://opencode.ai/config.json` (checked: 46 keys, none named `hooks`). Hooks are code registered
inside a plugin: `ctx.session.hook("prompt" | "context" | "compaction" | "generate" | "title", fn)`
plus tool hooks and a subscribed event stream (`/v2/docs/build/plugins/server` §Hooks). A "hook"
is therefore an implementation detail of a plugin package, exactly as in Pi.

**Plugins** — two mechanisms, both real:
1. Directory discovery: any file under `.opencode/plugins/` (project) loads automatically; on this
   machine `~/.config/opencode/plugins/i-have-adhd.js` is also discovered and `opencode plugin list`
   reports it as `local` with its absolute path — a **global** plugins dir that the docs do not list.
2. Config: `plugins: (string | {package, options})[]` — npm name, `pkg@version`, scoped name, git
   spec, relative/absolute dir, `file://` URL, or the object form with plugin options. One entry
   loads every part (server / tui / gui / rpc). V2 plugin API is `Plugin.define({id, setup})` from
   `@opencode/plugin`; **V1 plugin implementations do not run in V2** (`/v2/docs/migrate-v1`
   §Plugins) while 2.2.5 still *lists* V1-style `.js` files in `.opencode/plugins/`.

**Agents** — Markdown `.opencode/agents/<name>.md` / `~/.config/opencode/agents/<name>.md`
(nested path becomes part of the ID), body = system prompt, frontmatter/JSON fields per
`Config.AgentEncoded`: `description, mode (primary|subagent|all), model (provider/model[#variant]),
system, permissions[], steps, hidden, color, disabled, request` (`/v2/docs/agents`). Or inline under
the `agents` map. Overriding a built-in uses the same ID. Merge: later scalars replace, request maps
merge by key, permission rules **append**.

**Commands** — Markdown `.opencode/commands/<name>.md` (nested path → `/team/review`), body =
template, frontmatter `description, agent, model, subagent, subtask(deprecated)`; or inline under
`commands` with `template`. `$ARGUMENTS`, `$1..$n`, and `!`backtick`` shell blocks are expanded
before submission (`/v2/docs/commands`). Markdown and JSON share one registry; later sources replace
by name; edits are re-read without restart.

**Also config-declared, relevant to "instructions" transfer:** `references` (named local dirs or Git
repos as supporting context), `policies` (ordered allow/deny that can hard-block an MCP server,
skill or plugin), `permissions` (ordered tool rules), `providers`.

## 3. Version detection

- `opencode --version` → `opencode v2.2.5` (single string, human format).
- `opencode api get /api/info` → `{"version":"2.2.5","pid":…,"capabilities":{…}}` — machine-readable,
  but needs (or starts) the background server.
- No package/version file on disk: the install is one binary at `$HOME/.opencode/bin/opencode`
  (+ a 47-byte `opencode2` sh wrapper). `opencode debug paths` prints `home data cache config state
  tmp bin log repos db` for the resolved environment.
- Channels differ: `@opencode/cli` is the v2 npm package (2.2.5 = `latest` on 2026-11-05);
  `opencode-ai` is still the v1 line (1.19.5); the curl installer writes
  `https://opencode.ai/v2/install` → `$HOME/.opencode/bin`.

## 4. Install / remove, and merging without destroying unknown fields

CLI-managed (programmatic):

| Operation | Command | Scope it writes |
|---|---|---|
| add MCP | `opencode mcp add <name> --url …` / `… -- <cmd…>` (`--env` repeatable, `--header` repeatable, `--global`) | project `opencode.json` by default; `--global` → existing global `opencode.json(c)` |
| list / verify MCP | `opencode mcp list` (shows `connected` / auth state) | read-only |
| MCP OAuth | `opencode mcp auth [name]`, `opencode mcp logout <name>` | credentials outside project config |
| add plugin | `opencode plugin add <npm-or-git-spec>` | **global config only**; local paths rejected ("must be an npm registry package or Git package specifier") |
| remove plugin | `opencode plugin remove <spec>` | global config only; leaves the cached package on disk |
| check/update plugins | `opencode plugin check|update [target]` | global config |
| inspect config sources | `opencode debug config [--standalone]` | read-only JSON array of `{type, path, info}` |
| list agents / plugins | `opencode debug agents`, `opencode plugin list [--builtin]` | read-only |

Not CLI-managed — file write or file delete only: **agents, commands, skills, instructions,
`references`, `policies`, `permissions`, and MCP removal** ("To remove a server, delete its entry
from the project or global configuration"). There is no `mcp remove` subcommand in 2.2.5.

Merge safety, measured on 2.2.5 in throwaway `/tmp` projects:

| Experiment | Result |
|---|---|
| `mcp add` with no config present | creates `./opencode.json` (JSON, not JSONC), 2-space indent, native `mcp.servers` shape, prints the path |
| `mcp add` into an existing `opencode.jsonc` with `//` comments, unknown top-level key, unknown key inside another server | target file used (no second file created); comments preserved; unknown fields preserved; **formatting of untouched nodes is sometimes reflowed** (a one-line `["echo","hi"]` array came back expanded in one run, untouched in another) — comment-preserving, not byte-identical |
| `mcp add` with a name that already exists | **whole entry replaced**: `command`, an unknown field inside that entry, and a trailing comment attached to it were all dropped |
| `mcp add` into a **V1-shaped** file (`mcp.<name>` flat) | appends a native `mcp.servers{}` block *next to* the legacy flat entries → half-migrated mixed document (still loads, because mixed V1/V2 members inside `mcp` are recognised) |
| `plugin remove` on a commented global `opencode.jsonc` | comment + unknown top-level field preserved, `plugins` array reflowed, entry removed |
| `plugin add @dietrichgebert/ponytail` | comment preserved; appends a **bare specifier** (no version pin); caches to `~/.cache/opencode/npm/<pkg>@latest` |
| malformed `opencode.json` in a project | `debug config` **omits it silently, exit 0, nothing on stderr**; the only signal is `level=WARN message="configuration normalization diagnostic" … kind=invalid action="rejected malformed JSON or JSONC document"` in `~/.local/share/opencode/log/opencode.log` |

So: any writer must use a comment-preserving JSONC editor (the binary itself uses
`jsonc-parser`-style `modify` with `{tabSize:2, insertSpaces:true}` — visible in the `cli.json`
migration code path), must not rely on the CLI to preserve entry-level fields, and must expect
whitespace normalisation.

## 5. Undocumented, version-dependent, or needing manual intervention

- **`~/.opencode/` is a second global config root in 2.2.5** — `opencode.json(c)` plus resource
  dirs (`agents/` verified: an agent file placed there appeared in `debug agents`). It is not in the
  v2 docs location table. `debug config` lists it *after* `~/.config/opencode`, so it appears to
  outrank it; the winner was **not** verified against a conflicting value (unverified, ordering
  inferred from source-list order).
- **Two config dialects in one schema.** `https://opencode.ai/config.json` still carries the whole
  V1 surface (`agent`, `mode`, `command`, `reference`, `snapshot`, `plugin`, `autoupdate`,
  `enabled_providers`, `disabled_providers`, `small_model`, `subagent_depth`, `permission`, `tools`,
  `attachment`, `layout`, `logLevel`, `server`, `share`, `enterprise`). Normalisation is in memory:
  **what the file says and what `debug config` reports differ** (`enabled` → `disabled`, flat `mcp`
  → `mcp.servers`, `timeout: 30000` → `{startup,catalog,execution}`).
- **Mixed-format limits:** V2 recognises mixed V1/V2 members inside `mcp`, `compaction` and
  `experimental`, but **not** inside individual `agents`, `providers`, `commands` or `models` — keep
  each nested entry in one dialect. Agent *files* are read as one dialect too: a file using any of
  `permissions`, `request`, `system`, `disabled` is read as V2 and its V1 fields are ignored with a
  warning.
- **V1 plugin code does not execute in V2** (new plugin API). Porting is a rewrite, not a rename.
- **`disabled` vs `enabled`** is an easy silent inversion: writing `enabled: true` still loads
  (legacy shape), writing `enabled: false` on a *V2* entry is ignored → the server connects.
- **Managed/system config outranks project config**, and managed settings plus `policies` can block
  MCP servers, skills and plugins outright. A correct project write can be inert by admin policy.
- **Invalid config is a silent no-op at runtime.** Rejection is only visible in
  `~/.local/share/opencode/log/opencode.log` (`role=server`), never on stderr, never via exit code.
  `opencode debug config` is the practical validation probe.
- **Read-only-looking commands need the background server.** `debug config`, `debug agents`,
  `mcp list`, `plugin list` all go through the client-server architecture; in an isolated `HOME`
  they failed with `Managed service port 49374 on 127.0.0.1 is already in use` until
  `--standalone` was passed. `--standalone` (or a private `XDG_*` set) is required for any
  out-of-band adapter call.
- **Human-only gates:** OAuth sign-in for remote MCP servers (`mcp auth` opens a browser; over
  SSH/container the callback URL has to be pasted back by hand); `/mcps` toggling; root to write
  `/etc/opencode`; macOS MDM payloads.
- **Client-vs-server split:** terminal preferences live in **one global** `~/.config/opencode/cli.json`
  (schema `https://opencode.ai/v2/cli.json`), auto-migrated once from V1 `tui.json`; it is not
  layered per project and is not read by the background service. Plugin TUI parts belong there.
- `service.json` (`~/.config/opencode/service.json`) holds the local API password — runtime state,
  never a mirror target.
- Env vars named in the v2 docs: `OPENCODE_PASSWORD`, `OPENCODE_DB`, `OPENCODE_LOG_LEVEL`,
  `OPENCODE_DISABLE_PROJECT_CONFIG`. Present in the binary but undocumented in v2:
  `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`,
  `OPENCODE_CONFIG_PROJECT_DISABLE`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`,
  `OPENCODE_CLI_CONFIG_CONTENT`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_MODELS_PATH|URL`.
- **Cross-harness read paths that are not OpenCode's:** `~/.claude/skills`, `~/.agents/skills`,
  `.claude/skills`, `.agents/skills` are discovered by OpenCode but owned by other tools.

## Capability implications for the adapter contract (facts, not decisions)

- **Scopes:** four writable tiers actually exist — system (`/etc/opencode`, root), global
  (`~/.config/opencode`, plus undocumented `~/.opencode`), project (an `opencode.json(c)` at any
  ancestor directory, or a `.opencode/` config), and runtime overrides (`OPENCODE_CONFIG`,
  `OPENCODE_CONFIG_CONTENT`). Project-in-ancestor-dir merging plus ".opencode always beats direct
  config" makes "the project scope" ambiguous in a monorepo; the effective set is discoverable only
  through `opencode debug config`.
- **Categories OpenCode supports:** instructions (`AGENTS.md` + `instructions`), skills, MCP
  servers, plugins (packages or directories), agents (Markdown or JSON), commands (Markdown or
  JSON), plus `references`, `permissions`, `policies`, `providers`. **Hooks are not a category** —
  they only exist inside plugin code.
- **Native formats:** JSON/JSONC for config; Markdown+frontmatter for agents, commands, skills,
  instructions; TS/JS (ESM, `Plugin.define`) for plugins. Three of those need a real translation
  step; plugins cannot be mirrored as data at all.
- **Programmatic vs file-write:** programmatic = `mcp add` / `mcp auth` / `mcp logout` (no `mcp
  remove`), `plugin add|remove|check|update` (global only, npm/git specs only), and `debug config`
  as the read/validate probe. File-write = everything else: agents, commands, skills, instructions,
  references, policies, permissions, MCP *removal*, and any project-scope plugin entry.
- **Write safety:** a writer must edit JSONC in place, preserve unknown keys and comments, expect
  formatting normalisation, and write whole MCP entries (replace-by-name semantics at load time,
  plus `mcp add` itself replacing the entry). Writing a V2 entry into a V1-shaped file produces a
  mixed document rather than a migration.
- **Verification without a human:** `opencode debug config` (sources + normalised content),
  `opencode debug agents`, `opencode plugin list`, `opencode mcp list` — all server-backed, all
  requiring `--standalone` when run outside the user's normal service environment. Malformed config
  yields exit 0 and empty stderr; only the log file reports it.
- **Steps that always need the human:** OAuth sign-in for remote MCP servers, anything under
  `/etc/opencode` or MDM, and any behaviour gated by managed `policies`.
