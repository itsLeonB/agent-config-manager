# 11: An entry declares a set of Checks

**What to build:** one `(provision, harness)` entry can require several things at once, so "the plugin
is installed **and** its hooks are trusted" is one row. Its Presence folds the Checks: `absent` if any
is absent, `unknown` if any is unknown, otherwise `present`. A file written with a single `check` keeps
loading unchanged.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] An entry may declare `checks`, one or more, and either predicate shape is legal; `check = { … }`
      means a one-element list and `version = 1` is unchanged.
- [x] The fold is `absent` over `unknown` over `present`, and a row's detail names every Check that
      did not answer `present` with its own reason.
- [x] An empty `checks` list, or a `check` beside `checks`, refuses the file with line and column.
- [x] The rules that are per Check stay per Check: `contains` with `pointer` in one predicate still
      refuses, and `equals` without `pointer` still refuses.
- [x] `acm status`, `acm install`, and the list tool all read the folded Presence, and an entry that
      is not `present` is run by `acm install`.
- [x] spec.md's Presence section states the fold.
- [x] Tests cover the three folds, the sugar equivalence, and the empty-list refusal.

## Answer

`DeclaredEntry` and `ResolvedProvision` now carry `checks: Check[]` — one field, not a singular beside a
list. The parser accepts `checks = [ {…}, {…} ]` and keeps `check = {…}` as the one-element sugar;
spelling both, or an empty list, refuses the file at that key with line and column. The per-Check
rules moved nowhere: they are still evaluated one predicate at a time.

The fold lives in `check.ts` as `evaluateChecks` over a list plus an exported `foldAnswers`: any
`absent` wins, then any `unknown`, else `present`. Because the ticket asks a row's detail to name every
Check that did not answer `present` *with its own reason*, an `absent` answer now carries a reason too
(`<file> is not there`, `does not contain <pattern>`, `has no <pointer>`, `is not the declared value`,
`is not on PATH`) — so spec.md's Presence paragraph was amended to say `detail` is not `unknown`-only.
`service.ts` and `runner.ts` both read the fold, so status, install and the list tool cannot disagree.

`define.ts` gained an optional `checks` list beside the singular `check`, and writes whichever it was
given; a `check` write over a `checks` entry (or the reverse) is refused by the parser rather than
silently half-replacing an entry. Ticket 15 owns the tool's own schema.

Tests: the fold's three cases and the all-present case, the sugar equivalence, the empty-list and
both-spelled refusals, a fold reaching one row with the failing Check named, a run triggered by one
failing Check, and a `checks` definition read back by status.
