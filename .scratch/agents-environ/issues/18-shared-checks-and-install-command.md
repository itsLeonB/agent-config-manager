# 18: A Provision declares shared Checks and an Install command

**What to build:** an environment file can declare Checks and an Install command once on the
Provision itself, and every harness entry inherits them — an entry may then be an empty table,
which means the harness takes the shared declaration whole and exists so the Provision's rows show
that harness. `acm status` folds the shared Checks into each entry's Presence, and `acm install`
runs the shared Install command at most once per Provision per run, before the first entry that
needs it, recorded as a single Run.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `[provision.<name>]` accepts optional `checks` (either spelling) and `install` (any of the
      three shapes) beside `tags`; `[provision.<name>.<harness>]` accepts an empty table and
      optional `checks`/`install`.
- [ ] The whole file is refused with line and column when an entry would end up with no effective
      Check, or when a Provision leaves any entry with no effective Install command — so a
      Provision with no shared `install` still needs one on every entry.
- [ ] The loader resolves shared Checks and Install onto each entry; a nearer environment file
      owns the Provision's shared `checks`/`install`/`tags` whole, with no field-level merging.
- [ ] `acm status` reports each entry's Presence folded from shared plus its own Checks, and an
      empty entry reports the shared Checks' answer under its own harness.
- [ ] `acm install` prints the shared command once, labeled as the Provision's shared command,
      runs it before the first entry that needs it, does not run it again for later entries of the
      same Provision, skips it when no entry of the Provision runs, and records one Run for it.
- [ ] Seam A covers the run-once behaviour across several entries and empty entries reporting
      Presence; Seam B covers every new refusal.
