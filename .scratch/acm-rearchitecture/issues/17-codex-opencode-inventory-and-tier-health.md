# 17: Codex and OpenCode inventory, tiers, and tier health

Type: task
**Status:** ready-for-agent

**What to build:** `acm list` covering all three harnesses. Each harness row names its tiers, each
tier's writability, and the scope bucket it maps to, so an agent can tell a target tier from one it
must not touch. Codex's TOML config and OpenCode's JSON and JSONC configs are read into the same
installation shape as Pi's. A config the harness silently drops is reported as an unreadable tier
rather than as an empty inventory, and an unreadable tier removes no history.

**Blocked by:** 16.

- [ ] one listing call returns installations from Pi, Codex, and OpenCode, filterable by harness and by scope
- [ ] all six writable tiers appear with their scope bucket, and the non-target tiers are visible but marked as not writable
- [ ] Codex TOML and OpenCode JSONC both read into the same installation shape as Pi's JSON
- [ ] a malformed OpenCode config yields an unreadable tier verdict and tombstones nothing, while a clean config tombstones what it no longer lists
- [ ] the health verdict is measured per tier and stored, not inferred from an empty result
- [ ] tests cover a fixture per harness, including one deliberately broken OpenCode config

