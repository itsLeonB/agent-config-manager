# 02: Extract the native path lookup

**What to build:** one read-only lookup answers where each harness keeps configuration at a given tier, so the new service can name a native location without the inventory's tier model. It is the only surviving trace of the old tier declarations: no writability, no scope bucket, no derived enum.

**Blocked by:** 01

**Status:** resolved

- [x] One function answers the native read locations for a `(harness, tier)` pair, for Pi, Codex, and OpenCode.
- [x] It carries no writability, no scope bucket, and no target-vs-source distinction.
- [x] The three harness readers obtain their paths through it.
- [x] A unit test pins the three harness tables, including OpenCode's JSON and JSONC candidate files.
- [x] `bun run check` passes and no test changed behaviour.

## Comments

Implemented in `10bd7a5` on the integration branch `feat/agents-environ`; the two-axis
code review of that branch is recorded in the merge commit for the review fixes.
