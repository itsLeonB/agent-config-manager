# 02: Extract the native path lookup

**What to build:** one read-only lookup answers where each harness keeps configuration at a given tier, so the new service can name a native location without the inventory's tier model. It is the only surviving trace of the old tier declarations: no writability, no scope bucket, no derived enum.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] One function answers the native read locations for a `(harness, tier)` pair, for Pi, Codex, and OpenCode.
- [ ] It carries no writability, no scope bucket, and no target-vs-source distinction.
- [ ] The three harness readers obtain their paths through it.
- [ ] A unit test pins the three harness tables, including OpenCode's JSON and JSONC candidate files.
- [ ] `bun run check` passes and no test changed behaviour.
