# 06: Three environment files, merge, and relative paths

**What to build:** running `acm` in a repository converges the environment that machine actually has: the user file, the committed project file, and the gitignored project-local file read together, with the nearer file winning per Provision and harness. A path inside a Check or an Install command means the project in a project file and the home directory in the home file, so the same text reads correctly in both.

**Blocked by:** 04

**Status:** resolved

- [x] All three files are read when the Project root has the two project files; the user file is always read.
- [x] For one `(provision, harness)`, `project-local` shadows `project`, which shadows `user`. A shadowing entry replaces that whole entry, tags included.
- [x] A relative path in a Check or an Install command resolves against its tier's root: `$HOME` for `user`, the Project root otherwise. A leading `~\` or `/\` stays absolute.
- [x] A fixture proves the same Provision text at two tiers reads two different files.
- [x] `--tier` restricts both `status` and `install`.
- [x] A malformed project file contributes nothing while the user tier still loads.

## Comments

Implemented in `db3bd92` on the integration branch `feat/agents-environ`; the two-axis
code review of that branch is recorded in the merge commit for the review fixes.
