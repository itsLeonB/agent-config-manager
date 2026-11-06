# 17: Codex and OpenCode inventory, tiers, and tier health

Type: task
**Status:** resolved

**What to build:** `acm list` covering all three harnesses. Each harness row names its tiers, each
tier's writability, and the scope bucket it maps to, so an agent can tell a target tier from one it
must not touch. Codex's TOML config and OpenCode's JSON and JSONC configs are read into the same
installation shape as Pi's. A config the harness silently drops is reported as an unreadable tier
rather than as an empty inventory, and an unreadable tier removes no history.

**Blocked by:** 16.

- [x] one listing call returns installations from Pi, Codex, and OpenCode, filterable by harness and by scope
- [x] all six writable tiers appear with their scope bucket, and the non-target tiers are visible but marked as not writable
- [x] Codex TOML and OpenCode JSONC both read into the same installation shape as Pi's JSON
- [x] a malformed OpenCode config yields an unreadable tier verdict and tombstones nothing, while a clean config tombstones what it no longer lists
- [x] the health verdict is measured per tier and stored, not inferred from an empty result
- [x] tests cover a fixture per harness, including one deliberately broken OpenCode config

## Answer

Landed as `src/engine/adapters/{codex,opencode}/` next to Pi's, with the facts they agree on moved to
`src/engine/adapters/mcp-facts.ts` (canonical `McpFacts`, withholding, digest, pointer segments) and
the tier-file read in `src/engine/adapters/tier.ts`. `listInstallations` now also returns a
`harnesses[]` row per adapter, and `acm list` prints one tier legend line per harness:
`pi  pi:user(user,writable) pi:project(project,writable)`.

Tiers declared: `pi:user`/`pi:project`, `codex:user`/`codex:profile`/`codex:project`,
`oc:project`/`oc:user`/`oc:system`. Six are writable mirror targets; `codex:profile` (`notState`) and
`oc:system` (`elevationRequired`, `/etc/opencode`) are declared but **not read** — discovery skips
any tier that is not writable, so an unwritable layer can never tombstone or invent a row. `rank` is
precedence order, which is why OpenCode's list starts at project and ends at `/etc/opencode`.

Choices worth knowing beyond the ticket:

- A `Tier` now declares `configPaths[]` instead of one `configPath`, because OpenCode accepts
  `opencode.json` or `.jsonc` at the repo root and under `.opencode/`; every file that exists is
  read, and a missing file is a healthy empty tier.
- OpenCode health is the file parse plus a zod shape check, not spec §9's
  `opencode debug config` probe: this slice runs no commands (user story 26), so a config that
  parses but that OpenCode still rejects reads as `ok`. `shortcut:` in `opencode/index.ts`.
- `mcp.timeout` (OpenCode's global phase defaults) is skipped rather than read as a legacy server,
  and a legacy flat entry without `type`/`command`/`url` is not a server — same rule Pi applies to a
  user-tier entry.
- Codex `oauth` and `http_headers_helper` are deliberately unnamed in the reader, so a secret or an
  executable in `config.toml` never becomes a fact. Codex `startup_readiness`, `enabled_tools`, and
  `scopes` stay in the native file until a ticket needs them (typed only when the shape was known).
- OpenCode's `disabled` is inverted into canonical `enabled`; its millisecond timeouts are converted
  to the canonical seconds that Codex and Pi already use, so a mirror rescales once.


