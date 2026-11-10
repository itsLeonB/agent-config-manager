# 03: Record the decision and the vocabulary

**What to build:** the reason the project root comes from the working directory is written down
where the next reader will look, because the code it replaces said the opposite on purpose.

An ADR arguing the trade-off against the three alternatives that were on the table — the working
directory exactly, walking up to a repository marker, and taking the root as an argument of each
tool call — with the two costs accepted: a harness started below the repository root scopes to that
subdirectory, and a user-scope MCP entry under Claude Code would have started in its own
configuration directory had `CLAUDE_PROJECT_DIR` not been in the chain.

A glossary entry for **project root**, worded so it is distinct from the store location (which stays
anchored where `acm` is installed, and is still shared) and from a tier (which is declared by a
harness, not derived from a path).

The engine section of `AGENTS.md` currently says the project root is derived from the nearest
`package.json` above the entry point. That stays true for the store and stops being true for the
project; the sentence has to say which is which, or the next agent implements the old rule.

**Blocked by:** 02. These documents describe behaviour, so they land once the behaviour does.

**Status:** resolved

- [x] An ADR under `docs/adr/` records the decision, the alternatives, and both accepted costs,
      numbered and named in the style of its neighbours
- [x] `CONTEXT.md` defines **project root** in glossary voice only, with no implementation detail,
      and an `_Avoid_` line that keeps it apart from store location and tier
- [x] The engine paragraph in `AGENTS.md` distinguishes the project root (the working directory or
      its override) from the store location (nearest `package.json` above the entry point)
- [x] `map.md` carries a decisions line for this change

## Answer

[ADR 0006](../../../docs/adr/0006-project-root-is-the-working-directory.md): the working directory
wins over the walk-up, the per-call argument, and the incumbent module-location rule, with both
costs named as consequences. Two sentences were false after ticket 02 and are not now: ADR 0004's spawn paragraph (amended in
place, since it is the ADR that said the opposite) and the `AGENTS.md` line that the working
directory is never consulted — roots are resolved once in `src/engine/config.ts`, not by an adapter.
Five more said the same thing and were found while reviewing: `README.md`'s `--project-root`
paragraph and the `ACM_PROJECT_ROOT` row of its variable table, `spec.md` (which AGENTS.md calls the
authority), and the ticket-14 records in `map.md` and `issues/14`. The ticket-14 ones are amended in
place with a pointer, not rewritten, because they are closed records of what was decided then. This
effort had no map, so `map.md` was created and carries 01 and 02 beside this line.
