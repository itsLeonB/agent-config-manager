# 14: Two tiers, one file

**What to build:** running `acm` in the home directory no longer relabels the home environment file as
a project declaration. The file is read once, every row names the file it came from, and a `--tier`
filter that matches nothing says where it looked.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] When a Project root is `$HOME`, so the `user` and `project` tiers resolve to one path, that file
      loads once under `user` and the project tier contributes nothing.
- [x] `acm status` prints the file each row came from, and `--json` carries it, so a row's tier is
      checkable against the file rather than assumed.
- [x] `acm status --tier <tier>` that matches no entry prints the tiers it read and their files
      instead of an empty table, so an empty answer is never mistaken for an empty environment.
- [x] spec.md's Loading and merging section states the read-once rule.
- [x] Tests cover a `user` file and a project file at one path, and a filter that selects nothing.

## Answer

The read-once rule lives in the loader, because the loader is the only module that knows a tier's file
and it is the one doing the reading. `loadEnvironment` keeps a set of resolved paths and skips a
location already seen, so a Project root spelled `$HOME` — or spelled differently but resolving to it
— never relabels the home file as a project declaration. `Environment` now also carries `readFiles`,
the tiers and files the load actually read.

`HarnessPresence` gained `source`, so the file travels with the row the way `tier` does and reaches
`--json` for free. `formatStatus` prints it as a `source` column shortened against `$HOME` the way the
footer already shortens paths, and when no row survives the filter it prints `tiers read:` and the
files from `readFiles` — so an empty table and an empty environment can no longer be confused.
`--tier` needed no CLI change: the filter already reached `readStatus`, which now answers with where it
looked.

Commit `c1b96ea`, tests `a home project reads the shared environment file only as user, even through an
equal path` and `an unmatched tier reports the tiers and environment files read` in
`src/environ/service.test.ts`.
