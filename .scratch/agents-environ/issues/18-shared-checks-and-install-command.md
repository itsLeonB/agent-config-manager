# 18: A Provision declares shared Checks and an Install command

**What to build:** an environment file can declare Checks and an Install command once on the
Provision itself, and every harness entry inherits them — an entry may then be an empty table,
which means the harness takes the shared declaration whole and exists so the Provision's rows show
that harness. `acm status` folds the shared Checks into each entry's Presence, and `acm install`
runs the shared Install command at most once per Provision per run, before the first entry that
needs it, recorded as a single Run.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `[provision.<name>]` accepts optional `checks` (either spelling) and `install` (any of the
      three shapes) beside `tags`; `[provision.<name>.<harness>]` accepts an empty table and
      optional `checks`/`install`.
- [x] The whole file is refused with line and column when an entry would end up with no effective
      Check, or when a Provision leaves any entry with no effective Install command — so a
      Provision with no shared `install` still needs one on every entry.
- [x] The loader resolves shared Checks and Install onto each entry; a nearer environment file
      owns the Provision's shared `checks`/`install`/`tags` whole, with no field-level merging.
- [x] `acm status` reports each entry's Presence folded from shared plus its own Checks, and an
      empty entry reports the shared Checks' answer under its own harness.
- [x] `acm install` prints the shared command once, labeled as the Provision's shared command,
      runs it before the first entry that needs it, does not run it again for later entries of the
      same Provision, skips it when no entry of the Provision runs, and records one Run for it.
- [x] Seam A covers the run-once behaviour across several entries and empty entries reporting
      Presence; Seam B covers every new refusal.

## Answer

`[provision.<name>]` now carries optional `checks` (both spellings, through the same decoder an
entry uses) and `install` (any of the three shapes) beside `tags`. An entry's `checks`/`install`
became optional, and `decodeProvision` refuses the file at the entry's table header when the
effective sets would be empty — install is checked before check, the order the entry-level rules
always had. `DeclaredEntry.install` is `InstallCommand | null` and `ProvisionDeclaration` gained
`checks`/`install`; the resolved entry keeps them apart as `install` (own) and `sharedInstall`,
with `checks` already folded shared-then-own, because the runner needs the two Install commands
separate: the shared one runs at most once.

The loader resolves the shared declarations once per file's Provision and rides them onto every
entry that file declares, so merge needed no new rule — a nearer file owns them whole exactly the
way it owns `tags`, because they are built from the winning declaration with no field-level
merging. The dedupe key is `(provision name, Tier root, spelled shared command)`, so two entries
sharing one declaration run it once, a same-named Provision at another tier with a different
command runs its own, and the same spelling at two tiers still runs twice — a relative path means
a different file under each root.

The preview prints the shared command once as `    $ shared: <command>` above the first entry
that will run it (the group's first entry when all are skipped, for review). The run re-evaluates
Presence live before each entry — a shared command that just ran can make a later entry present,
and it then runs nothing — and each command is its own Run, recorded under the triggering entry's
`(provision, harness)` with the presence re-evaluated after it. `recordRun` now takes the Install
command that ran rather than reading `provision.install`, since an entry can run two.
