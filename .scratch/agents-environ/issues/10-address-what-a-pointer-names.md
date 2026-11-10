# 10: Address what a pointer actually names

**What to build:** a Check can answer for an array element and for a key whose name contains a dot, and
a pointer ACM cannot spell refuses the file instead of quietly reporting absence. A new `includes`
predicate answers whether the array at an address holds a value, which is how a plugin list and a hook
entry list become answerable without a regex over the whole file.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `{ file, pointer, includes }` answers `present` when the array at that address holds a deeply
      equal element, `absent` when the array holds no such element, and `unknown` when the address
      holds something that is not an array.
- [ ] A segment in double quotes addresses a key whose name contains a dot, and a numeric segment
      addresses an array element, in a JSON document and a TOML document alike.
- [ ] A pointer whose quoting cannot be split refuses the whole file with its line and column, so an
      address ACM cannot spell is never reported as `absent`.
- [ ] The pointer splitter is one function shared by the reader and the validator, rather than split
      inline where the Check is evaluated.
- [ ] spec.md's Checks and Presence stories and the Environment file predicate list carry `includes`.
- [ ] Tests cover an array of strings, an array of objects, a quoted key containing a dot, and an
      unspellable pointer.
