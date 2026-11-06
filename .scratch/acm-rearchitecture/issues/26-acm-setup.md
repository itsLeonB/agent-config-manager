# 26: acm setup self-install

Type: task
**Status:** ready-for-agent

**What to build:** one command that installs ACM into all three harnesses as an ordinary MCP server
entry, using the same plan-and-apply path as every other mutation rather than a private write. The
entry points at the absolute installed binary with the server arguments and no working directory.
Running it again is harmless. Afterwards ACM appears in the inventory like any other server, and a
harness that cannot be written is refused rather than half-installed.

**Blocked by:** 25.

- [ ] the written entry is the absolute binary path plus the server arguments, and carries no working directory
- [ ] installation goes through a plan that is shown and applied, not a direct file write
- [ ] a second run reports the entry as already present and writes nothing
- [ ] ACM appears in the inventory as an ordinary installation afterwards, with no special-casing
- [ ] an unwritable target harness is refused before any write, and the other harnesses' outcomes are reported separately

