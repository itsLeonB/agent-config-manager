# 02: Per-tier harness lists and validation

**What to build:** Each environment file's `harnesses` list is its own, and the lists never merge. A file that declares a list refuses any entry naming a harness outside it; a file with no list accepts any non-empty, NUL-free name. The loader exposes one list per tier, `list_harnesses` and the status footer answer per tier, and `define_provision` checks the target file's list before it writes.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] The parser accepts a file with a list and refuses an entry outside it, with line and column.
- [ ] A file with no list accepts any non-empty, NUL-free harness name, so existing files keep loading.
- [ ] The loader carries a per-tier record and no merged list; a file's list never reaches another tier.
- [ ] `listHarnesses(tier?)` answers one tier or all; `list_harnesses` returns `{ user: [...], project: [...] }`.
- [ ] `acm status` prints the harness lists per tier, and `--json` carries the same shape.
- [ ] `define_provision` refuses a harness the target file's list does not name; an absent or empty list constrains nothing.
- [ ] The parser refusals, the per-tier shape, and the definition check are covered by tests; `bun run check` is green.