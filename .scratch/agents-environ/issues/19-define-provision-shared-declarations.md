# 19: define_provision writes shared declarations

**What to build:** an agent calling `define_provision` can declare a Provision's shared Checks and
Install command — the ones every harness entry inherits — as well as the harness-specific entry's
own, so onboarding a shared-location Provision is one call rather than one per harness. The shared
fields land on the Provision's own table through the pointer-level editor, and a same-key write
replaces only those keys.

**Blocked by:** 18

**Status:** resolved

- [x] The tool's input gains optional shared `checks` and `install`, using the same discriminated
      unions the entry fields already use, with descriptions a client can read.
- [x] A call with shared fields and no entry fields, entry fields and no shared fields, and both,
      each writes only what it names: comments and sibling Provisions survive, and a repeat call
      replaces the shared keys without touching `tags` or the entries.
- [x] A definition the loader would refuse — including one that leaves an entry with no effective
      Check or Install — reports the loader's line, column, and reason and writes nothing.
- [x] A Provision defined with shared Checks and Install reads back through `acm status` with each
      declared harness entry reporting Presence.
- [x] Seam C is extended: the round trip is asserted over the built bundle, and `tools/list`
      carries the new inputs.

## Answer

`define_provision` now takes `sharedChecks` and `sharedInstall` beside the entry's own `check`,
`checks`, and `install`; `install` is optional because the shared Install command or the entry's
existing one can cover it, and the parser still refuses a definition that leaves an entry with no
effective Check or Install command. The shared fields write `[provision.<name>]`'s `checks`/`install`
keys through the pointer editor, keeping the file's singular `check` spelling when it already has
one, and a call with no entry fields still declares the harness as an empty table via
`ensureTomlTable` so the shared declaration has a Presence row to report.

Seam A covers shared-only, entry-only, and combined writes, repeat shared writes leaving `tags` and
entries untouched, singular-spelling preservation, and the loader refusals; Seam C asserts the new
inputs in `tools/list` and round-trips shared declarations plus empty harness entries through the
built bundle into `acm status --json`.
