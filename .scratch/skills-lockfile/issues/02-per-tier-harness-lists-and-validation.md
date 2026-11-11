# 02: Per-tier harness lists and validation

**What to build:** Each environment file's `harnesses` list is its own, and the lists never merge. A file that declares a list refuses any entry naming a harness outside it; a file with no list accepts any non-empty, NUL-free name. The loader exposes one list per tier, `list_harnesses` and the status footer answer per tier, and `define_provision` checks the target file's list before it writes.

**Blocked by:** 01

**Status:** resolved

- [x] The parser accepts a file with a list and refuses an entry outside it, with line and column.
- [x] A file with no list accepts any non-empty, NUL-free harness name, so existing files keep loading.
- [x] The loader carries a per-tier record and no merged list; a file's list never reaches another tier.
- [x] `listHarnesses(tier?)` answers one tier or all; `list_harnesses` returns `{ user: [...], project: [...] }`.
- [x] `acm status` prints the harness lists per tier, and `--json` carries the same shape.
- [x] `define_provision` refuses a harness the target file's list does not name; an absent or empty list constrains nothing.
- [x] The parser refusals, the per-tier shape, and the definition check are covered by tests; `bun run check` is green.

## Answer

The parser validates each entry key against the file's own `harnesses` list inside
`decodeProvision`, after the existing empty/NUL check, refusing at the entry's key with
`harness '<name>' is not one of this file's harnesses: <list>`. A file with no list — or an
empty one — declares no constraint, so free-form harness names keep loading.

The loader no longer merges lists: `Environment.harnessesByTier` is a `Record<EnvironmentTier,
string[]>` filled from each parsed file, and `Status.harnesses` carries the same record. The
default three-harness answer is gone everywhere.

`listHarnesses` has two call shapes like `readStatus`: `listHarnesses()` returns both tiers keyed
by tier, `listHarnesses({ tier })` returns that tier's list. The `list_harnesses` MCP tool now
answers `{ user: [...], project: [...] }`.

`acm status`'s footer appends `harnesses: user <list|none declared>; project <list|none
declared>`, and `statusDocument` adds the same `harnesses` record so `--json` and the MCP
`list_provisions` document carry it.

`defineProvision` checks `request.harness` against the target file's parsed `harnesses` list right
after the pre-write parse, refusing with the parser's reason at the `harnesses` key's line and
column (via the new `harnessesKeyPlace` export in `parse.ts`) before any bytes are written.

Tests: parser refusals and loads in `parse.test.ts` (Seam B), per-tier records and refusals in
`tiers.test.ts` and `service.test.ts` (Seam A), the definition check in `define.test.ts`, and the
stdio smoke coverage for `list_harnesses` plus a refused `define_provision` in `server.test.ts`
and the footer/`--json` shape in `main.test.ts` (Seam C). `bun run check` is green: 301 tests.
