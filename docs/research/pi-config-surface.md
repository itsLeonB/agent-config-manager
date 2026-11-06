# Pi native configuration surface

Research date: 2026-11-05. Harness version inspected: `@earendil-works/pi-coding-agent@1.5.0`
(also installed locally: 1.4.0, kept for diffing).

Answers `.scratch/acm-rearchitecture/issues/03-pi-config-surface.md` — facts only, no decisions.

## Sources

Primary, version-pinned: the documentation shipped inside the installed npm package,

```
~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/
```

Files used: `configuration.md`, `settings.md`, `mcp.md`, `skills.md`, `packages.md`, `cli.md`,
`security.md`, `extensions.md`, `prompt-templates.md`, `json.md`.
Package page: <https://www.npmjs.com/package/@earendil-works/pi-coding-agent> (1.5.0 = npm `latest`).
JSON Schemas in the same package: `schemas/{settings,keybindings,models,theme}.schema.json`.

Public per-page doc URLs: **unverified** — `https://pi.dev/docs/{configuration,mcp,skills}` returned
404 on 2026-11-05, so every citation below points at the package-internal doc path plus the version.
Corroborating local evidence: `~/.pi/agent/` on this machine, and `pi --version` → `1.5.0`.

## 1. Config locations and formats, per scope

Two scopes only. There is **no third "project-local / untracked" tier** (unlike OpenCode):

| Scope | Root | Format |
|---|---|---|
| user ("agent directory") | `~/.pi/agent` (override: `PI_CODING_AGENT_DIR`) | JSON / Markdown / TS-JS |
| project | `<cwd>/.pi` | JSON / Markdown / TS-JS |

`docs/configuration.md`; `docs/settings.md` ("Project settings override agent-directory settings.
Resource lists are combined.").

Agent directory (`~/.pi/agent/…` → project equivalent):

| Path | Component |
|---|---|
| `settings.json` | settings, resource lists, package declarations, built-in extension toggles |
| `keybindings.json` | keybindings |
| `mcp.json` | MCP servers |
| `models.json` → project has none (user-only) | endpoints/models |
| `auth.json` | API keys, OAuth (-user-only, never mirrored) |
| `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` (`.MD` variants too) | user instructions |
| `SYSTEM.md` (replaces prompt), `APPEND_SYSTEM.md` (appends) | system-prompt fragments |
| `extensions/` | extensions (= hooks, plugins) |
| `skills/` | skills |
| `prompts/` | prompt templates |
| `themes/` | themes |
| `trust.json`, `mcp-auth.json`, `mcp.log`, `mcp-project-approvals.json`, `mcp-last-seen-version.json`, `models-store.json`, `crashes.json` | Pi runtime state — **not** user-authored config |

Project `.pi/` has no `auth.json`, no `models.json`, no `keybindings.json`; the rest mirror the
agent dir. `SYSTEM.md` / `APPEND_SYSTEM.md`: the trusted project file wins over the agent-dir file
with the same name; same-named files are not concatenated.

Skills also load from the cross-harness `~/.agents/skills/` and `.agents/skills/` (Agent Skills
locations); project `.agents/skills/` is searched from `cwd` up to the repo root
(`docs/skills.md`). **`.agents/skills/` is shared with other harnesses — writing there is not a
Pi-scoped write.**

## 2. How it declares MCP servers, skills, hooks, plugins, instruction files

**MCP** — `mcp.json` with one `mcpServers` object, "the format matches other MCP clients"
(`docs/mcp.md`). Per-entry: `command`/`args`/`env`/`cwd` (stdio) or `url`/`headers`/`oauth` (HTTP);
plus `type`, `timeout`, `enabled`, `exposure`, `toolExposure`, `description`. Server names limited
to `[A-Za-z0-9_-]`; `-` and `_` collide. SSE rejected. `env`/`headers` accept `${VAR}` and
`!command` value substitution. Locally observed extra field: `auth: { provider: ... }` (radius) —
present in `~/.pi/agent/mcp.json`, not documented in the field list.

Project merge rule (this is the important one for mirroring): a project entry **replaces** the
user entry of the same name. A project entry with no `command`/`url`/`type` is a *patch* that
overrides only `enabled`, `exposure`, `toolExposure` and keeps everything else, "including `env`,
`headers`, and `auth`". So an override entry that accidentally carries a `command` silently
duplicates credentials/args rather than patching.

**Skills** — directory with `SKILL.md` (Agent Skills spec: frontmatter `name`, `description`,
`license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`). Located in
`skills/` dirs (recursive), listed explicitly in settings `skills: []`, or shipped by a package.
Name collisions keep the first discovered and warn; a `SKILL.md` with no `description` is not
loaded; malformed fields warn rather than fail.

**Hooks** — Pi has **no hook configuration file and no hook declaration format**. The equivalent
is an extension that registers event handlers (`pi.on(...)`), e.g. `tool_call`, `session_*`,
`agent_*`, `input`, `project_trust` (`docs/extensions.md` §Events). A "hook" therefore means
*code*, and hook lifecycle/compatibility is a property of the extension file, not of config.

**Plugins** — Pi packages: npm (`npm:@scope/pkg@1.2.3`), git (`git:github.com/u/r@v1` or a URL),
or a local path. Declared in `settings.json` `packages: []`, installable with
`pi install <source> [--local]`. A package may carry extensions, skills, prompts, themes; a
`pi` key in its `package.json` narrows which resources load. Identity for dedupe: npm by package
name, git by repo URL without ref, local by absolute path.

**Instruction files** — `AGENTS.md` (also `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`) discovered from
the agent dir, `cwd`, and every ancestor directory; `AGENTS.override.md` replaces the sibling
`AGENTS.md`/`CLAUDE.md` **in that directory only**. Discovery ignores project trust
(`docs/configuration.md` "Context files").

**Prompt templates / themes** — `prompts/*.md` (frontmatter `description`, `argument-hint`;
filename = `/command`, `$1`/`$@`/`${1:-default}` substitutions) and `themes/*.json`.

**Settings resource lists** are how a component can be declared instead of dropped in a directory:
`packages`, `extensions`, `skills`, `prompts`, `themes` — each supports globs, `!pattern`
exclusion, `+path` exact include, `-path` exact exclude.

## 3. Version detection

`pi --version` (`-v`) prints a bare semver — verified on this machine: `1.5.0`. The binary is
`~/.pi/agent/bin/pi`; installs are kept per-version under `~/.pi/agent/install/releases/<version>/`,
where `node_modules/@earendil-works/pi-coding-agent/package.json` carries the same `version` and
the docs+schemas for that exact version. No documented machine-readable version JSON beyond that.

Doc surface changed 1.4.0 → 1.5.0 (diffed locally): `selfUpdateCommand` setting added;
`httpIdleTimeoutMs` / `websocketConnectTimeoutMs` accept `"disabled"`; MCP OAuth gained
`clientRegistration: auto | dcr | cimd` and the CIMD client-ID behaviour; package changelogs added
(`pi.changelogPath`, `collapseChangelog` covers extension packages). Anything reading these keys
must be version-aware.

## 4. Install / remove, and merge without destroying unknown fields

Prefer Pi's own writers; they keep sibling state:

| Component | Install | Remove |
|---|---|---|
| Package | `pi install <source> [--local]` | `pi remove <source> [--local]` (alias `uninstall`) |
| MCP | `pi mcp add <name> [--env K=V] [--cwd D] [--exposure M] [--description T] [--local] -- <cmd> [args…]` or `--url <url> [--header K=V] [--bearer-token-env-var N] [--oauth-*]` | `pi mcp remove <name> [--local]` (keeps stored OAuth creds) |
| Skill / instruction / prompt / theme | write the file | delete the file |
| Extension | write the file, or `pi install` a package | delete the file, or `pi remove` |
| Settings toggle, per-resource enable/disable | `pi config [--local]` (interactive, Tab switches scope) | same |

Merge/preservation facts:

- `pi mcp add` "add or replace" **replaces the whole named entry** — it is not a field merge. A
  field the CLI has no flag for (e.g. `auth`, `toolExposure`) is lost if `add` is used to modify an
  existing server. `docs/mcp.md`: "Exposure and enabled-state changes are saved to the file that
  defines the server without replacing unrelated content" — true for the `/mcp` UI and interactive
  toggles, **not** for `add`.
- `settings.json` is shared with Pi's own bookkeeping. Locally observed keys not in the settings
  reference: `lastChangelogVersion`, `extensionChangelogVersions`. Any read-modify-write must
  preserve unknown keys and not reformat away Pi's state.
- Cross-scope merge: settings — project overrides user, resource lists concatenate; `packages` —
  project entry replaces the user entry unless `autoload: false`, which makes it a filtering delta;
  MCP — see §2; `SYSTEM.md`/`APPEND_SYSTEM.md` — project wins, no concatenation.
- Pi's own failure mode is non-destructive: a package that fails to install is warned about,
  skipped, and retried next start (`/reload`); `pi install`/`pi update --extensions` exit non-zero.
  An invalid `mcpServers` entry is "reported and skipped" so other servers still connect.
- Validation available offline: `schemas/settings.schema.json` (also `$schema` URL
  `https://pi.dev/schemas/settings.schema.json`), `keybindings`, `models`, `theme`. **No schema
  ships for `mcp.json`** — that file can only be validated by `pi mcp list` (exit 1 on invalid
  entry or failed connect).

## 5. Undocumented, version-dependent, or needing manual intervention

- **Project trust is a hard gate, and it is Pi state, not user config.** Protected resources
  (`.pi/settings.json`, `.pi/mcp.json`, `.pi/{extensions,skills,prompts,themes}`,
  `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, project/ancestor `.agents/skills`) do not load until a
  decision is saved. Decisions live in `~/.pi/agent/trust.json` keyed by canonical directory;
  fallback `defaultProjectTrust` (`ask` default, agent-dir-only setting) plus CLI
  `-a/--approve` / `-na/--no-approve`. A mirror that writes project-scope Pi config produces
  **inert files** until trust is granted — the adapter cannot complete that step for the user.
  `sessionDir` is read before trust resolves.
- `.pi/mcp.json` is read only for already-trusted projects (`docs/cli.md`), and `pi mcp login -l`
  requires the server to be defined in `.pi/mcp.json`.
- **Hooks/plugins are executable code**; extensions run in-process with full user permissions
  (`docs/security.md`). There is no declarative hook manifest to translate.
- **`mcp.json` has undocumented fields** (`auth`, seen locally) and no schema; `exposure` defaults
  to `codemode` and its values (`codemode`/`deferred`/`direct`/`hidden`, alias `codemode-deferred`)
  are Pi-only concepts with no analogue in other harnesses.
- **Pi runtime session state changes exposure/enabled in memory only** ("Changes to enabled state or
  exposure apply only to the current session") for extension-registered servers; the file wins.
- `-e`/`--extension` try-without-installing caches under `~/.pi/agent/tmp/extensions/` and
  re-resolves npm/git every start — an install that is not in `settings.json`. Not a scope to model.
- CLI/manual steps that have no config-only equivalent: `/mcp login|logout` (OAuth),
  `/trust` (project trust), `pi update` (self-update), `/reload` after out-of-session edits
  (a mirror write is invisible to a running session until `/reload`).
- Skill discovery is deliberately cross-harness (`~/.agents/skills`, `.agents/skills`), so "Pi's
  skill list" is not the same set as "skills Pi owns".
- Sub-agent style extras observed in the local tree but **not** config surface this slice should
  touch: `missions/`, `pi-subagents/`, `npm/`, `sessions/`, `git/`, `web-search-cache/`, `bin/`.

## Capability implications for the adapter contract (facts, not decisions)

- Scopes: `user` and `project`. No untracked project-local tier.
- Categories Pi supports: instructions, system-prompt fragments, skills, MCP servers, prompt
  templates, themes, extensions, packages (as a distribution wrapper for the previous two).
- Native formats: JSON for settings/MCP/models/keybindings/theme; Markdown+frontmatter for
  skills/prompts/instructions; TypeScript/JavaScript for extensions. Four component categories
  therefore need a real translation step, and "extensions" cannot be mirrored as data at all.
- Install/remove is available programmatically for packages and MCP only; everything else is
  file write or file delete.
- Two things always need the human: project trust, and OAuth sign-in for remote MCP servers.
