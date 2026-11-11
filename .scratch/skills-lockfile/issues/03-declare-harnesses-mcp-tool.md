# 03: The declare_harnesses MCP tool

**What to build:** An agent can write one tier's harness list without hand-editing TOML. The tool replaces the whole `harnesses` key for the chosen tier, an empty list clears it, and the parser validates the result before anything is written, so a list that would invalidate an existing entry is refused with its reason.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] The tool takes a non-empty array of harness names and an explicit tier, with no default tier.
- [ ] Writing a list lands at the top of the chosen file; comments and sibling Provisions survive.
- [ ] An empty list removes the key, and the next read sees no declared harnesses for that tier.
- [ ] A list that excludes a harness an existing entry in the same file uses is refused, and the file is unchanged.
- [ ] A write followed by `list_harnesses` returns the written list for that tier and no other.
- [ ] The MCP stdio test covers `tools/list`, the write, the read, and a refused write; `bun run check` is green.