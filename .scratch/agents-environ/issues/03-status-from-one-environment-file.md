# 03: `acm status` from one environment file

**What to build:** a human writes `agents_environ.toml` in their home directory with a Provision per thing installed, and `acm status` answers which harnesses have it. Two Check predicates ship: a file that exists, and a file that contains a pattern — enough for an export in `.zshrc` and a block in `AGENTS.md`. An agent gets the same answer as a tool result.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A file with `version = 1` and Provision tables loads. An unknown version, an unknown key, a missing Install command, an unknown harness id, an unknown predicate kind, or an empty `contains` refuses the whole file with line and column, and contributes nothing.
- [ ] `acm status` prints Provision by harness with `present` or `absent`, and `--json` prints the same as data.
- [ ] The MCP tool `list_provisions` returns the same rows, declares `readOnlyHint: true`, and accepts `harness` and `name` filters.
- [ ] Fixtures prove a `.zshrc`-style export and an `AGENTS.md`-style heading report `present`, and a Provision whose pattern is absent reports `absent`.
- [ ] Evaluating a Check spawns no process, reads no network, and writes nothing.
- [ ] A Provision with no entry for some harness appears without a row for that harness.
