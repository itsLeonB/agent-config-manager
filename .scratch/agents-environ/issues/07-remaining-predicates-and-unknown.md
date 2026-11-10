# 07: Remaining Check predicates and `unknown`

**What to build:** a Check can address a value inside a native config file, so an MCP entry, a Codex hook, or a plugin entry is detectable by address, with an optional expected value so a disabled entry does not count as installed. A Check can also ask whether a name is on `PATH`. When a Check cannot answer, it says `unknown` with a reason instead of claiming absence.

**Blocked by:** 03

**Status:** resolved

- [x] `{ file, pointer }` reports `present` when a value exists at that address, in a JSON, JSONC, or TOML file, with the address written the same way in both.
- [x] `{ file, pointer, equals }` requires the value to match by deep equality, so `disabled = true` reports `absent`.
- [x] `{ onPath }` reports `present` only for a regular executable file, and `absent` when the name is missing or not executable.
- [x] A file that does not parse, a missing directory, and an invalid pattern each report `unknown` with a detail that explains it. `unknown` is never folded into `absent`.
- [x] A `{ file }` Check on a file that does not exist reports `absent`, not `unknown`.
- [x] `acm install` runs a Provision whose Presence is `unknown`.

## Comments

Implemented in `a3d4b7d` on the integration branch `feat/agents-environ`; the two-axis
code review of that branch is recorded in the merge commit for the review fixes.
