# 01: Narrow a tombstone to the locations the tier actually read

**What to build:** a discovery pass stops deleting another project's Installation. Today one
inventory can hold several projects, and reading project B tombstones every live row of tier
`pi:project` — including the entry that lives in project A's own config file. After this ticket a
row is tombstoned only when the file it lives in was read on this pass and no longer holds it; a row
whose file this tier never touched is left alone.

The rule turns from "everything live in this `(harness, tier)` that I did not see" into "everything
live in this tier *that sits under a location I declared I read* and did not see". A tier's declared
reads are already the single statement of every location its harness loads, so no adapter learns a
new fact: the same declaration that bounds a write now also bounds a tombstone.

Prefix matching is by path segment, not string prefix: a file under `/a/bc` is not under `/a/b`.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] Scanning project A then project B against one store leaves every one of A's project-scope
      Installations live
- [x] An entry removed from a file the pass did read is still tombstoned, so the inventory can shrink
- [x] A tier that reports `unreadable` still tombstones nothing (the existing rule, unchanged)
- [x] A file whose path shares a string prefix with a declared read but is not inside it is not
      tombstoned by that tier
- [x] `bun run check` green

## Answer

`TierReport` carries the tier's `declaredReads`, computed in `discover()` by the new
`declaredReads(tier)` helper in `src/engine/adapters/types.ts` — every path the tier declares across
all four categories. `recordDiscovery` now reads live rows as `{id, nativeFile}` and tombstones one
only when its `nativeFile` is `under()` those reads, using the same segment-based containment that
bounds a write (`declaresReadPath` is now spelled with it). An `unreadable` tier still returns before
the loop, so it tombstones nothing.
