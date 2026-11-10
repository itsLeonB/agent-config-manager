# 10: Address what a pointer actually names

**What to build:** a Check can answer for an array element and for a key whose name contains a dot, and
a pointer ACM cannot spell refuses the file instead of quietly reporting absence. A new `includes`
predicate answers whether the array at an address holds a value, which is how a plugin list and a hook
entry list become answerable without a regex over the whole file.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `{ file, pointer, includes }` answers `present` when the array at that address holds a deeply
      equal element, `absent` when the array holds no such element, and `unknown` when the address
      holds something that is not an array.
- [x] A segment in double quotes addresses a key whose name contains a dot, and a numeric segment
      addresses an array element, in a JSON document and a TOML document alike.
- [x] A pointer whose quoting cannot be split refuses the whole file with its line and column, so an
      address ACM cannot spell is never reported as `absent`.
- [x] The pointer splitter is one function shared by the reader and the validator, rather than split
      inline where the Check is evaluated.
- [x] spec.md's Checks and Presence stories and the Environment file predicate list carry `includes`.
- [x] Tests cover an array of strings, an array of objects, a quoted key containing a dot, and an
      unspellable pointer.

## Answer

`splitPointer` in `src/engine/edit.ts` is now the one spelling of an address: it returns segments that
are either a key or an array index, skips the whitespace TOML headers legally carry around a `.`, and
refuses what it cannot split instead of guessing. It is the upgraded form of the old TOML header path
parser, so the writer (`tomlTables`) and the reader walk the same grammar — a numeric TOML segment
becomes a key on the way back, because a table header digit *is* a key.

`readPointer` takes the raw pointer and splits it itself, so `check.ts` no longer splits inline; the
validator (`parse.ts`) calls the same function and refuses the file at the `pointer` key with
`pointer cannot be spelled: <reason>` when it fails. `readJson` and `readToml` both walk an array by
index, which they previously could not.

The sixth predicate `{ file, pointer, includes = <value> }` is `present` when the array at the address
holds a deeply equal element, `absent` when it holds none (a missing address included), and `unknown`
with a reason when the address holds a non-array. `includes` without `pointer`, beside `equals`, or
beside `contains` refuses the file: one predicate, one answer.
