# 04: `acm install`

**What to build:** one command converges a machine. It prints every Provision and its exact Install command before the first command runs, skips what is already `present`, runs the rest in its tier's root, and ends with a summary a human can read and a wrapper script can trust. No prompt: a fresh machine converges in one command.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Every Provision, harness, tier, and exact command is printed before the first command starts.
- [ ] A Provision whose Presence is `present` is skipped; `--force` runs it anyway.
- [ ] Each command starts in its tier's root, with stdin closed. A command that reads stdin fails instead of hanging the run.
- [ ] ACM passes no extra environment variables: the command inherits the parent environment unchanged.
- [ ] A failing command is reported and the run continues. The exit status is non-zero when any command failed or any Presence is still not `present` afterwards.
- [ ] Commands run in file order, user file first.
- [ ] `--dry-run` prints and stops, and is the default when stdin is not a TTY.
- [ ] `--only <name>` restricts the run to the named Provisions.
- [ ] The summary names what was already present, what ran, what failed, and what is still absent.
- [ ] A run never writes an environment file.
