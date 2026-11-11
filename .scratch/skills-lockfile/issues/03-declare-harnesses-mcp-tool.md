# 03: The declare_harnesses MCP tool

**What to build:** An agent can write one tier's harness list without hand-editing TOML. The tool replaces the whole `harnesses` key for the chosen tier, an empty list clears it, and the parser validates the result before anything is written, so a list that would invalidate an existing entry is refused with its reason.

**Blocked by:** 02

**Status:** resolved

- [x] The tool takes a non-empty array of harness names and an explicit tier, with no default tier. (An empty array is the clear the spec and the other checklist items settle on: it removes the key.)
- [x] Writing a list lands at the top of the chosen file; comments and sibling Provisions survive.
- [x] An empty list removes the key, and the next read sees no declared harnesses for that tier.
- [x] A list that excludes a harness an existing entry in the same file uses is refused, and the file is unchanged.
- [x] A write followed by `list_harnesses` returns the written list for that tier and no other.
- [x] The MCP stdio test covers `tools/list`, the write, the read, and a refused write; `bun run check` is green.

## Answer

`src/environ/declare.ts` owns `declareHarnesses({ tier, harnesses })`: it finds the tier's file
through `environmentFiles`, refuses the file's own parse refusal before touching it, replaces the
top-level `harnesses` key through `writePointer`, or removes the key with the new
`deleteTomlKey` when the list is empty, then re-parses the candidate bytes and writes only what
the loader would accept. The outcome reuses `DefineOutcome` (`defined` / `refused` / `failed`),
re-exported from `service.ts` as `DeclareOutcome`/`DeclareRequest`.

Two gaps in the pointer editor had to close first, in `src/engine/edit.ts`: `writeToml` could not
write a root key at all (it appended a `[]` table header), so a `parent.length === 0` branch now
replaces an existing root key in place — comment kept — or inserts before the first table header
(and its leading comment/blank lines), or appends when the document is all root keys; and
`deleteTomlKey` removes a root key plus every line a multi-line value runs over, bounded to the
region before the first table header so a same-named key inside a table is untouched.

The MCP face registers `declare_harnesses` in `src/mcp/router.ts` with a required `tier` enum
(`user`, `project`) and a `harnesses` string array; a refusal answers `not declared: <line>:<col>:
<reason>` via the shared `refused` helper, which gained a verb parameter. `acm_instructions` lists
the tool.

Tests: `src/environ/declare.test.ts` (Seam A — fixture home/project, byte-exact file assertions,
per-tier reads, refused-write-unchanged, out-of-list tier), `src/engine/edit.test.ts` (root-key
write and `deleteTomlKey`), and `src/mcp/server.test.ts` (Seam C — `tools/list` shape, write,
`list_harnesses` round-trip per tier, refused write, empty-list clear over stdio). `bun run check`
is green: 311 tests.
