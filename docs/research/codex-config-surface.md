# Codex native configuration surface

Research date: 2026-11-05. Harness version inspected: `codex-cli 0.166.0`
(standalone release `0.166.0-x86_64-unknown-linux-musl`, installed at
`~/.codex/packages/standalone/releases/0.166.0-x86_64-unknown-linux-musl/bin/codex`,
reached through `~/.local/bin/codex`).

Answers `.scratch/acm-rearchitecture/issues/04-codex-config-surface.md` — facts only, no decisions.

## Sources

Primary, version-pinned:

| Source | What it pins |
|---|---|
| `codex --version` → `codex-cli 0.166.0` | installed binary |
| `https://github.com/openai/codex` tag `rust-v0.166.0` (commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`) | repo docs at that tag |
| `codex-rs/core/config.schema.json` @ `rust-v0.166.0` | JSON Schema (draft-07) for `config.toml`, 258,005 bytes |
| `~/.codex/packages/standalone/releases/0.166.0-x86_64-unknown-linux-musl/codex-package.json` | release identity |

Repo `docs/*.md` at that tag are **3-line redirects**: `config.md`, `agents_md.md`, `skills.md`,
`sandbox.md`, `authentication.md`, `example-config.md` all point at `https://developers.openai.com/codex/…`.
Only `docs/config.md` still carries one unique fact (managed hooks, quoted in §5). Everything else
below was read from the live docs site on 2026-11-05, which is **not version-pinned** — each page was
fetched as Markdown by appending `.md`:

- `https://developers.openai.com/codex/config-basic.md`
- `https://developers.openai.com/codex/config-advanced.md`
- `https://developers.openai.com/codex/config-reference.md`
- `https://developers.openai.com/codex/config-sample.md`
- `https://developers.openai.com/codex/guides/agents-md.md`
- `https://developers.openai.com/codex/skills.md`
- `https://developers.openai.com/codex/hooks.md`
- `https://developers.openai.com/codex/plugins.md`
- `https://developers.openai.com/codex/extend/mcp.md` (a.k.a. `/codex/mcp`)
- `https://developers.openai.com/codex/customization/overview.md`
- `https://developers.openai.com/codex/enterprise/managed-configuration.md`
- `https://developers.openai.com/plugins/build/plugins.md`

The live site rewrites canonical links to `https://learn.chatgpt.com/docs/…`; the two hosts served
byte-identical managed-configuration pages. `https://developers.openai.com/codex/config-schema.json`
308-redirects to `https://learn.chatgpt.com/docs/config-schema.json` and is byte-identical to the
`rust-v0.166.0` schema file.

Corroborating local evidence: `~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.codex/skills/`,
`~/.codex/plugins/cache/`, `~/.codex/version.json`, `~/.codex/installation_id`.

Empirical probes (all in a throwaway `CODEX_HOME=/tmp/cht`, never the real `~/.codex`):
`codex mcp add|get|list|remove`, `codex plugin add|remove`, `codex plugin marketplace add|remove`,
`codex features enable`, `codex doctor --json`, `--strict-config`.

## 1. Config locations and formats, per scope

All settings are **TOML**. JSON is used only for `hooks.json` and plugin manifests; Markdown for
`AGENTS.md` and `SKILL.md`.

| Scope | Root | Notes |
|---|---|---|
| system | `/etc/codex/config.toml` (Unix) | optional; absent on this machine |
| user | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | `CODEX_HOME` relocates everything |
| profile | `$CODEX_HOME/<profile-name>.config.toml`, selected by `--profile <name>` | overlay only, selected at launch |
| project | `<project-root>/.codex/config.toml`, plus one per directory down to `cwd` | **loaded only when the project is trusted** |
| managed (enforced) | `/etc/codex/requirements.toml` (Unix) / `%ProgramData%\OpenAI\Codex\requirements.toml` (Windows); cloud Agent Security bundle; legacy `/etc/codex/managed_config.toml` (Unix) or `~/.codex/managed_config.toml` (Windows); macOS MDM `com.openai.codex:requirements_toml_base64` | admin layer, user cannot override |
| one-off | `-c key=value` CLI flags | parsed as TOML, dotted paths |

Precedence, highest first (`config-basic.md` "Configuration precedence"):

1. CLI flags and `--config` overrides
2. project `.codex/config.toml`, ordered project root → cwd, closest wins (trusted projects only)
3. profile file `$CODEX_HOME/<name>.config.toml`
4. user `$CODEX_HOME/config.toml`
5. cloud-managed `config.toml` defaults (signed-in workspace)
6. `/etc/codex/config.toml`
7. built-in defaults

There is **no separate untracked "project-local" tier** the way Claude Code has
`.claude/settings.local.json`. Project scope is `.codex/` inside the repo, and "local vs shared"
exists only as Git tracking of that directory.

Project config is additionally **filtered by a documented denylist**: Codex ignores
`openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `model_provider`, `model_providers`,
`notify`, `profile`, `profiles`, `experimental_realtime_ws_base_url`, `otel` when they appear in
`.codex/config.toml` (`config-reference.md` §`config.toml`).

Non-Codex-scoped roots that Codex still reads (shared with other harnesses, so a write there is not
Codex-owned):

| What | Paths |
|---|---|
| skills | `$HOME/.agents/skills`, `<repo>/.agents/skills` (cwd up to repo root), `/etc/codex/skills` |
| plugin marketplaces | `~/.agents/plugins/marketplace.json`, `<repo>/.agents/plugins/marketplace.json`, legacy `<repo>/.claude-plugin/marketplace.json` |

## 2. How each component is declared

### MCP servers

`[mcp_servers.<id>]` tables in any config layer (`config-reference.md` §`mcp_servers.<id>.*`;
`extend/mcp.md`). One table covers both transports:

- stdio: `command` (required), `args`, `env`, `env_vars`, `cwd`
- streamable HTTP: `url`, `auth = "oauth" | "chatgpt"`, `oauth.client_id` / `oauth.client_secret` /
  `oauth.callback_url` / `oauth.callback_port`, `bearer_token_env_var`, `http_headers`,
  `http_headers_helper`, `env_http_headers`
- shared: `enabled`, `required`, `startup_readiness`, `startup_timeout_sec` / `_ms`,
  `tool_timeout_sec`, `enabled_tools`, `disabled_tools`, `omit_tools_from`,
  `default_tools_approval_mode`, `tools.<tool>.approval_mode`, `tools.<tool>.output_token_limit`,
  `supports_parallel_tool_calls`, `tool_input_schema_max_bytes`, `scopes`, `oauth_resource`,
  `environment_id`

`oauth.client_secret` is documented as "Stored in configuration" — a credential that lives in
`config.toml`, unlike Pi where credentials sit in `auth.json` / `mcp-auth.json`.

Plugin-provided MCP servers are not user-transport config: `[plugins."<p>@<m>".mcp_servers.<server>]`
exposes only `enabled`, approval mode, `enabled_tools`, `disabled_tools`, per-tool approval.

### Skills

Directory containing `SKILL.md`; `name` and `description` are required frontmatter
(`skills.md`). Optional `scripts/`, `references/`, `assets/`, and `agents/openai.yaml` (UI metadata,
`policy.allow_implicit_invocation`, MCP tool dependencies).

Documented scopes (`skills.md` "Where Codex loads local skills"): `REPO` = `$CWD/.agents/skills`
plus every directory above it to the repo root; `USER` = `$HOME/.agents/skills`;
`ADMIN` = `/etc/codex/skills`; `SYSTEM` = bundled. Name collisions are **not** merged — both appear.

Config-side controls (`config-reference.md`):

- `[[skills.config]]` with `path` (absolute `SKILL.md`) **or** `name` (matches all skills with that
  name) plus `enabled`; last matching entry wins
- `[skills.bundled] enabled` (trusted project config can disable system skills per project)
- `skills.max_context_tokens`, `skills.include_instructions`

Locally observed, **not documented** in `skills.md`: `$CODEX_HOME/skills/` exists and holds
`.system/` (with a `.codex-system-skills.marker`) plus user-installed skills such as `use-railway`.
Whether `$CODEX_HOME/skills` is scanned for user skills is **unverified** — no `codex skills` CLI
exists to list what Codex resolved, and the TUI `/skills` picker is interactive.

### Hooks

Hooks are **real first-class config**, in JSON or inline TOML (`hooks.md`):

- discovered "next to active config layers": `~/.codex/hooks.json`, `~/.codex/config.toml`,
  `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`
- plugin-bundled: `hooks/hooks.json` in the plugin root by default, or a `hooks` key in
  `.codex-plugin/plugin.json` (`./`-prefixed path, array of paths, inline object, or array of objects)
- gated by `[features] hooks` (default `true`; present as `hooks = true` in the local user config)

Shape is three levels: event → matcher group (regex) → handlers.

- events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
  `UserPromptSubmit`, `SubagentStop`, `SubagentStart`, `Stop`, `Interrupt`, `SessionStart`,
  `SessionEnd`, `PreModelRequest`, `PostModelRequest`
- handler `type`: `command` or `mcp_tool`; `prompt` and `agent` handlers "are parsed but skipped"
- per-handler: `command`, `command_windows`/`commandWindows`, `timeout` (seconds; 600 default, 1s for
  `SessionEnd`/`Interrupt`), `statusMessage`, `additionalContextLimit`, `async`

Merge across layers is **additive**: "If more than one hook source exists, Codex loads all matching
hooks. Higher-precedence config layers don't replace lower-precedence hooks." A single layer holding
both `hooks.json` and inline `[hooks]` is merged with a startup warning.

### Plugins

Two declaration layers (`plugins.md`, `config-reference.md` §`marketplaces.*`, `plugins.*`):

```toml
[marketplaces.<name>]
source_type = "local" | "git"
source = "/abs/path" | "https://github.com/o/r.git"
ref = "main"            # optional
sparse_paths = [...]    # optional

[plugins."<plugin>@<marketplace>"]
enabled = true
```

A marketplace is a directory holding `.agents/plugins/marketplace.json` (`name`, `interface`,
`plugins[]` with `source`, `policy.installation`, `policy.authentication`, `category`). A plugin
manifest is a root `plugin.json` (portable Agent Plugins package; Codex-specific fields under
`extensions.com.openai`) with `.codex-plugin/plugin.json` still supported as a compatibility
fallback. Manifests may declare `skills`, `hooks`, MCP servers via `.mcp.json`, browser extensions,
assets, and `interface` UI metadata.

Installed state = presence of the `[plugins."<plugin>@<marketplace>"]` block. The bundle is cached at
`$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`; disabling keeps the block with
`enabled = false`.

Also config-declared but outside the mirror slice's usual categories: `[agents]` (subagents),
`[tui.presets.<digit>]` (saved prompt/command slots), `notify`, `[apps.<id>]` connectors.

### Instruction files

`AGENTS.md` (`guides/agents-md.md`):

- global: `$CODEX_HOME/AGENTS.override.md` if present, else `$CODEX_HOME/AGENTS.md` — **first
  non-empty file only**
- project: project root → cwd; per directory `AGENTS.override.md`, then `AGENTS.md`, then names in
  `project_doc_fallback_filenames`; **at most one file per directory**
- concatenated root → cwd with blank lines, so closer files come later (= override)
- capped by `project_doc_max_bytes` (32 KiB default); empty files skipped
- `model_instructions_file` replaces the base system instructions (the older
  `experimental_instructions_file` was renamed; `config-reference.md` line 2037 says so explicitly)

Undocumented mechanism, observed locally: `~/.codex/AGENTS.md` begins with the line
`@/home/leon/.codex/RTK.md`. Whether `@path` is an import directive or literal text is
**unverified** — no page I read documents it.

There is **no documented file-based custom-prompt / slash-command directory**. Reusable workflows are
skills; ad-hoc prompts come from MCP `prompts`, `[tui.presets.*]`, or files shipped inside a plugin.

## 3. Version detection

- `codex --version` and `codex -V` both print `codex-cli 0.166.0` (verified on this machine).
- `codex doctor --json` emits a redacted machine-readable report that includes
  `"schemaVersion": 1` and `"codexVersion": "0.166.0"` alongside per-check results (verified).
- `$CODEX_HOME/packages/standalone/releases/<version>-<target>/codex-package.json` carries
  `layoutVersion`, `version`, `target`, `variant`, `entrypoint`, `execServer`, `resourcesDir`,
  `pathDir` (verified).
- `~/.codex/version.json` is **update-check state**, not the installed version:
  `{"latest_version":"0.166.0","last_checked_at":"…","dismissed_version":null}`.
- `~/.codex/installation_id` is a random UUID, not a version.

Version-pinned validation artifact: `codex-rs/core/config.schema.json` at tag `rust-v0.166.0`
(JSON Schema draft-07, `additionalProperties: false` at the root, 103 top-level properties incl.
`mcp_servers`, `hooks`, `skills`, `marketplaces`, `plugins`, `projects`, `features`).

## 4. Install / remove, and merge without destroying unknown fields

### What the CLI writes for you

| Component | Install | Remove |
|---|---|---|
| MCP server | `codex mcp add <name> [--env K=V]… [--url U \| -- cmd args…]` (plus `--bearer-token-env-var`, `--oauth-client-id`, `--oauth-client-secret`, `--oauth-resource`) | `codex mcp remove <name>` |
| Plugin | `codex plugin add <plugin[@marketplace]> [--json]` | `codex plugin remove <plugin[@marketplace]> [--json]` |
| Marketplace | `codex plugin marketplace add <path\|owner/repo[@ref]\|URL> [--ref R] [--sparse P]` | `codex plugin marketplace remove <name>`; `codex plugin marketplace upgrade [name]` refreshes Git snapshots |
| Feature flag | `codex features enable <name>` | `codex features disable <name>` |

`codex mcp add` **has no scope flag** and always writes the user config: run inside a trusted
project it still printed `Added global MCP server '…'` and wrote `$CODEX_HOME/config.toml`
(verified). Project-scope MCP servers, project config generally, `AGENTS.md`, skills, `hooks.json`
and plugin manifests are **file writes only**.

`codex plugin add --json` returns `{pluginId, name, marketplaceName, version, installedPath,
authPolicy}` (verified).

### Merge semantics (all verified by probe)

- **Cross-layer config merge is per key.** User `[mcp_servers.shared]` with
  `command/args/env/enabled` plus a project `[mcp_servers.shared]` carrying only
  `startup_timeout_sec = 9.0` produced one server with the user's `command`, `args`, `env`,
  `enabled = false` and the project's timeout. This is the opposite of Pi, where a project entry
  replaces the whole named server.
- **Arrays replace, not concatenate.** User `args = ["--u1","--u2"]` + project `args = ["--p1"]`
  → `["--p1"]`.
- **Deeper project layers win per key.** Root `.codex/config.toml` plus `sub/.codex/config.toml`,
  run from `sub`: nested `args` won, and servers from both layers were active.
- **`codex mcp add <existing-name>` replaces the whole table.** Re-adding `alpha` dropped
  `startup_timeout_sec = 30.0` and the entire `[mcp_servers.alpha.env]` sub-table. There is no
  field-level merge path through the CLI.
- **The writer preserves unrelated content, comments and ordering** outside the table it touches:
  a root comment, an inline comment on `model`, a comment above an unknown key, an unknown scalar
  key (`some_future_key`), and an unrelated `[zzz_last_section]` table all survived `mcp add`,
  `feature` writes, `plugin marketplace add`, `plugin add` and both removes.
- **Comments inside the rewritten table are lost.** `# comment inside alpha` disappeared on
  `mcp add alpha`; `codex mcp remove alpha` left `# trailing comment inside alpha` dangling under
  the surviving keys.
- **The writer fails closed.** With malformed TOML, `codex mcp add` exits with a
  `TOML parse error at line 2, column 6 … key with no value, expected =` and **leaves the file
  unchanged**. With a known key of the wrong type (`approval_policy = 123`) it errors
  `invalid type: unit variant, expected string only in approval_policy` and again leaves the file
  unchanged. Unknown keys are tolerated silently (`some_future_key = "keep me"` produced no warning
  from `codex mcp list` or `codex doctor`).
- **`--strict-config` is narrower than its `--help` text suggests.** Documented as "Error out when
  config.toml contains fields that are not recognized by this version of Codex", but on 0.166.0 it
  is rejected by subcommands: `Error: --strict-config is not supported for codex mcp` and
  `… for codex features` (both verified).
- **`codex plugin remove` deletes the `[plugins."x@y"]` block but keeps `[marketplaces.x]`**;
  `codex plugin marketplace remove` deletes the `[marketplaces.x]` block. The
  `$CODEX_HOME/plugins/cache/<marketplace>/` directory survives both (verified).
- Hooks are not rewritten by any CLI command; `/hooks` (interactive) only records trust.

## 5. Undocumented, version-dependent, or needing manual intervention

- **Project trust is a hard gate and it is user-scope state.** `[projects."<path>"].trust_level =
  "trusted" | "untrusted"` in the user config (`config-reference.md`). Verified:
  with `trust_level = "untrusted"`, a `[mcp_servers.projserver]` in `/tmp/proj/.codex/config.toml`
  was invisible to `codex mcp list`; flipping the same entry to `"trusted"` made it appear.
  Docs state untrusted projects skip project-scoped `.codex/` layers "including project-local config,
  hooks, and rules". A mirror that writes `.codex/config.toml` therefore produces inert config until
  a trust decision exists. Trust lives in the user's config, not in the repo.
- **Hook trust is a second, positional gate.** Non-managed hooks must be reviewed before running;
  trust is recorded against a hash in `[hooks.state."<source>:<event>:<index>:<index>"]` with
  `trusted_hash` and (for plugin hooks) `trusted_content_hash` — the exact key format is observed
  locally, not documented. `hooks.md` adds: "If a plugin update changes a bundled script, Codex
  requires a new review even if the hook definition stays the same." Only bypass is
  `--dangerously-bypass-hook-trust`, documented as dangerous. Any write that inserts or reorders
  hooks in a file shifts the indices and invalidates existing trust for later entries.
- **Managed layers override the user and the CLI.** `requirements.toml` (system path above, cloud
  Agent Security, legacy `managed_config.toml`, macOS MDM) is admin-enforced; "CLI `--config`
  key=value overrides apply to the base, but managed layers override them". `allow_managed_hooks_only
  = true` is honored **only** in `requirements.toml` — the version-pinned `docs/config.md` says
  verbatim: "This setting is only supported in `requirements.toml`; putting it in `config.toml` does
  not enable managed-hooks-only mode."
- **Project config has a denylist** (§1) — a project-scope mirror of `model_provider`, `notify`,
  `otel`, `profiles`, … is silently ignored. `profile` / `[profiles]` are project-inert; profiles are
  their own `$CODEX_HOME/<name>.config.toml` file overlay.
- **Plugin enablement has a ceiling**: `plugins.<plugin>.enabled` "does not override workspace-managed
  enabled states", and a project layer can override user/cloud/system defaults but not workspace
  management.
- **OAuth and credentials need a human.** `codex mcp login <name> [--no-browser] [--scopes …]
  [--oauth-client-registration auto|cimd|dcr]`, `codex mcp logout <name>`. `--no-browser` prints a URL
  and accepts a pasted callback URL, so it is scriptable only with a human in the loop.
  `mcp_servers.<id>.oauth.client_secret` is stored **in `config.toml`** — a secret a mirror must never
  copy. Plugin install may also require `authPolicy: ON_INSTALL` sign-in.
- **Sandbox/approval settings are part of the config an adapter reads and can change.**
  `sandbox_mode` (`read-only` | `workspace-write` | `danger-full-access`), `approval_policy`
  (`on-request` | `never`; `"untrusted"` retired in 0.166), `approval_policy = "granular"`, named
  `[permissions.<name>]` profiles with `default_permissions`, and protected paths inside writable
  roots (`.git`, `.agents`, `.codex`, `.aws`). These govern every process Codex spawns — MCP servers
  and hook commands included.
- **Version-dependent surface, 0.166.0 specifically.** `approval_policy = "untrusted"` retired;
  `experimental_instructions_file` → `model_instructions_file`; `[profiles]`/`profile` ignored in
  project config; `--profile` now takes a "CONFIG_PROFILE_V2" file name; the public repo `docs/` tree
  is now redirect stubs to a live, unpinned site. Reading docs at tag `rust-v0.166.0` alone is
  therefore not sufficient — but the tag's `codex-rs/core/config.schema.json` is.
- **Undocumented / observed only.** `@path` lines in `AGENTS.md`; `$CODEX_HOME/skills/` as a
  user-skill location; the `hooks.state` key format; `[desktop]`, `[tui] screen_reader_detection_done`,
  `notice.*` keys in the local `config.toml` that are app/TUI runtime state rather than user intent.
- `/etc/codex/` does not exist on this machine — the system layer is skipped when absent.

## Capability implications for the adapter contract (facts, not decisions)

- **Scopes.** Codex exposes three writable config scopes — `user` (`$CODEX_HOME/config.toml`),
  `profile` (`$CODEX_HOME/<name>.config.toml`, selectable only at launch), `project`
  (`<repo>/.codex/config.toml`, gated by user-scope trust) — plus read-only-for-users system/managed
  layers (`/etc/codex/config.toml`, `requirements.toml`, cloud, MDM) that outrank anything a mirror can
  write. Skills and plugin marketplaces add two *cross-harness* roots (`~/.agents/*`, `<repo>/.agents/*`)
  that are not Codex-owned.
- **Component categories** with a declared surface: MCP servers, skills, hooks, plugins
  (+ marketplaces), instruction files (`AGENTS.md`, `model_instructions_file`), feature flags,
  sandbox/approval/permission settings, subagents, skill enable/disable rules, saved prompt slots.
  No file-based custom-prompt/slash-command surface. No theme surface found.
- **Native formats.** TOML for every settings file; JSON for `hooks.json` and plugin manifests
  (`plugin.json` / `.codex-plugin/plugin.json`, `.mcp.json`, `.agents/plugins/marketplace.json`);
  Markdown + YAML frontmatter for `SKILL.md`; plain Markdown for `AGENTS.md`. MCP, plugins and
  instructions are data; hooks are data that *execute* (`command` / `mcp_tool` handlers).
- **Programmatic vs file-write.** CLI-managed: MCP servers (user scope only), plugins, marketplaces,
  feature flags. File-write only: project-scope MCP and all project config, `AGENTS.md`, skills,
  `hooks.json`, plugin manifests, subagents, permission profiles. Plugin install additionally
  materialises a cache directory at `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`.
- **Merge contract.** Config layers deep-merge per key, arrays replace, deeper project layers win;
  the CLI's own writer preserves unknown keys, comments and ordering outside the table it edits, drops
  comments inside it, replaces the whole MCP table on re-`add`, and refuses to write an unparsable or
  type-invalid file. A version-pinned JSON Schema exists
  (`codex-rs/core/config.schema.json` @ `rust-v0.166.0`) for offline validation; the docs site's copy
  is unpinned.
- **Steps that always need a human.** Project trust (`[projects.<path>].trust_level`), hook trust
  review (`/hooks`), MCP OAuth login, plugin install-time authentication, and any change inside
  `requirements.toml` / MDM / cloud-managed layers.
