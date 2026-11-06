# 19: Mirror plan into a Codex target

Type: task
**Status:** ready-for-agent

**What to build:** `acm mirror <installation> --target codex:user --plan` prints one complete plan
document for moving an MCP server from Pi to Codex, and writes nothing. The document enumerates where
every source field went — carried, mapped with the transform named, dropped with a reason, or
preserved — lists the exact native addresses to write with the target's current digest as a
precondition, shows the target diff and not a whole-file copy, names any manual step, and carries the
plan's own hash and its safe-or-risky grade. A target tier that cannot be written is refused before a
plan is produced.

**Blocked by:** 16, 17, 18.

- [ ] the plan document carries the source and target identity, the field partition, the writes with per-file preconditions, the manual steps, the verification assertions, and the grade
- [ ] planning changes nothing on disk
- [ ] the plan's id is recomputed from its own body, and a body edited by hand fails that check
- [ ] every source field appears exactly once in the partition; an unexpressible field becomes a gap and an unknown one is marked preserved
- [ ] the rename, unit, extract, and wrap transforms each appear in a test with a real field pair, including the header-to-token-variable case that would otherwise ship a literal reference
- [ ] a non-writable or non-existent target tier is refused as caller input, before any plan exists
- [ ] a shared native location reports which other harnesses also read it

