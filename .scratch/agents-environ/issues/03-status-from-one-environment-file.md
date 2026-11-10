# 03: `acm status` from one environment file

**What to build:** a human writes `agents_environ.toml` in their home directory with a Provision per thing installed, and `acm status` answers which harnesses have it. Two Check predicates ship: a file that exists, and a file that contains a pattern — enough for an export in `.zshrc` and a block in `AGENTS.md`. An agent gets the same answer as a tool result.

**Blocked by:** 02

**Status:** resolved

- [x] A file with `version = 1` and Provision tables loads. An unknown version, an unknown key, a missing Install command, an unknown harness id, an unknown predicate kind, or an empty `contains` refuses the whole file with line and column, and contributes nothing.
- [x] `acm status` prints Provision by harness with `present` or `absent`, and `--json` prints the same as data.
- [x] The MCP tool `list_provisions` returns the same rows, declares `readOnlyHint: true`, and accepts `harness` and `name` filters.
- [x] Fixtures prove a `.zshrc`-style export and an `AGENTS.md`-style heading report `present`, and a Provision whose pattern is absent reports `absent`.
- [x] Evaluating a Check spawns no process, reads no network, and writes nothing.
- [x] A Provision with no entry for some harness appears without a row for that harness.

## Comments

Implemented in `6103d05` on the integration branch `feat/agents-environ`; the two-axis
code review of that branch is recorded in the merge commit for the review fixes.
