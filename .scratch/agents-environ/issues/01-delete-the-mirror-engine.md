# 01: Delete the mirror engine and its inventory tables

**What to build:** the codebase shrinks to what the new model keeps. The mirror path — plan, apply, verify, the MCP write surface, the hook write surface, the canonical field tables, `acm setup`, the discovery pass with tombstones and tier health — is deleted rather than left dormant. The tier model loses its write half, so a Tier is a read location and nothing else. The store drops the inventory tables in one migration. What remains still runs: the dashboard renders and rescans, the three harness readers parse, and `bun run check` is green.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] No module builds a plan, applies one, verifies one, writes native config, or installs ACM into a harness. Nothing in the tree imports one.
- [ ] `Tier.writability`, `writePaths`, `declaresWritePath`, `mirrorTarget`, and the adapter's write surfaces are gone; the read path is unaffected.
- [ ] `acm` exposes `mcp serve` only, and `tools/list` returns an empty list.
- [ ] One migration issues four `DROP TABLE IF EXISTS` statements for the inventory tables. Recreating the database file is rejected: it costs more code and loses the dashboard's saved settings.
- [ ] `snapshots` and `config` rows survive the migration untouched, and the dashboard renders and rescans after it.
- [ ] Tests for deleted modules are deleted with them; the surviving modules keep their tests. `bun run check` passes.
- [ ] Kept and still covered: the pointer-level native editor, the secret classifier with its credential pointers, content digesting, the engine configuration module, and the three harness readers.
