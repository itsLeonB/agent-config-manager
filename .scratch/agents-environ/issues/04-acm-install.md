# 04: `acm install`

**What to build:** one command converges a machine. It prints every Provision and its exact Install command before the first command runs, skips what is already `present`, runs the rest in its tier's root, and ends with a summary a human can read and a wrapper script can trust. No prompt: a fresh machine converges in one command.

**Blocked by:** 03

**Status:** resolved

- [x] Every Provision, harness, tier, and exact command is printed before the first command starts.
- [x] A Provision whose Presence is `present` is skipped; `--force` runs it anyway.
- [x] Each command starts in its tier's root, with stdin closed. A command that reads stdin fails instead of hanging the run.
- [x] ACM passes no extra environment variables: the command inherits the parent environment unchanged.
- [x] A failing command is reported and the run continues. The exit status is non-zero when any command failed or any Presence is still not `present` afterwards.
- [x] Commands run in file order, user file first.
- [x] `--dry-run` prints and stops, and is the default when stdin is not a TTY.
- [x] `--only <name>` restricts the run to the named Provisions.
- [x] The summary names what was already present, what ran, what failed, and what is still absent.
- [x] A run never writes an environment file.

## Comments

Implemented in `500b8dc` on the integration branch `feat/agents-environ`; the two-axis
code review of that branch is recorded in the merge commit for the review fixes.
