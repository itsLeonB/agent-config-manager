# 11: An entry declares a set of Checks

**What to build:** one `(provision, harness)` entry can require several things at once, so "the plugin
is installed **and** its hooks are trusted" is one row. Its Presence folds the Checks: `absent` if any
is absent, `unknown` if any is unknown, otherwise `present`. A file written with a single `check` keeps
loading unchanged.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] An entry may declare `checks`, one or more, and either predicate shape is legal; `check = { … }`
      means a one-element list and `version = 1` is unchanged.
- [ ] The fold is `absent` over `unknown` over `present`, and a row's detail names every Check that
      did not answer `present` with its own reason.
- [ ] An empty `checks` list, or a `check` beside `checks`, refuses the file with line and column.
- [ ] The rules that are per Check stay per Check: `contains` with `pointer` in one predicate still
      refuses, and `equals` without `pointer` still refuses.
- [ ] `acm status`, `acm install`, and the list tool all read the folded Presence, and an entry that
      is not `present` is run by `acm install`.
- [ ] spec.md's Presence section states the fold.
- [ ] Tests cover the three folds, the sugar equivalence, and the empty-list refusal.
