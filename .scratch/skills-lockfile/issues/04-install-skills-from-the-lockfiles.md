# 04: Install skills from the lockfiles

**What to build:** `acm skills install [--dry-run]` reads the user and project skills lockfiles, groups each by source, and runs one `npx skills add` command per group with the harness list the matching environment file declares. The user groups run with `-g`; the project groups run from the Project root without it. A tier with no declared harnesses omits the agent flags. A missing or invalid lockfile warns and the other tier still runs, an entry with no source is skipped with a warning, every group runs even after a failure, and any failed command makes the exit status non-zero. Nothing is written to the store.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] The lockfile reader is a pure function over bytes: it handles version 1 and version 3 files, a missing `skills` key, invalid JSON, and an entry with no `source`.
- [ ] Each group is one command: `npx -y skills@latest add <source> --skill <name>... [--agent <harness>...] [-g] -y`, with repeated `--skill` and `--agent` flags.
- [ ] The user groups run first with `-g`; the project groups run from the Project root without it.
- [ ] A tier with no harness list omits the agent flags; a tier with a list passes every name in it.
- [ ] `--dry-run` prints every command and runs nothing; a real run prints each command and its exit status.
- [ ] A missing user lockfile still installs the project skills, and the reverse; one failed command does not stop the rest.
- [ ] A fake `npx` on `PATH` records the exact argv, order, and exit statuses; the test asserts them without a network or a real install.
- [ ] `bun run check` is green.