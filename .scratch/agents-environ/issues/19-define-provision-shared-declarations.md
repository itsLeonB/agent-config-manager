# 19: define_provision writes shared declarations

**What to build:** an agent calling `define_provision` can declare a Provision's shared Checks and
Install command — the ones every harness entry inherits — as well as the harness-specific entry's
own, so onboarding a shared-location Provision is one call rather than one per harness. The shared
fields land on the Provision's own table through the pointer-level editor, and a same-key write
replaces only those keys.

**Blocked by:** 18

**Status:** ready-for-agent

- [ ] The tool's input gains optional shared `checks` and `install`, using the same discriminated
      unions the entry fields already use, with descriptions a client can read.
- [ ] A call with shared fields and no entry fields, entry fields and no shared fields, and both,
      each writes only what it names: comments and sibling Provisions survive, and a repeat call
      replaces the shared keys without touching `tags` or the entries.
- [ ] A definition the loader would refuse — including one that leaves an entry with no effective
      Check or Install — reports the loader's line, column, and reason and writes nothing.
- [ ] A Provision defined with shared Checks and Install reads back through `acm status` with each
      declared harness entry reporting Presence.
- [ ] Seam C is extended: the round trip is asserted over the built bundle, and `tools/list`
      carries the new inputs.
