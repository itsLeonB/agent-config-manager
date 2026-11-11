# 04: Install skills from the lockfiles

**What to build:** `acm skills install [--dry-run]` reads the user and project skills lockfiles, groups each by source, and runs one `npx skills add` command per group with the harness list the matching environment file declares. The user groups run with `-g`; the project groups run from the Project root without it. A tier with no declared harnesses omits the agent flags. A missing or invalid lockfile warns and the other tier still runs, an entry with no source is skipped with a warning, every group runs even after a failure, and any failed command makes the exit status non-zero. Nothing is written to the store.

**Blocked by:** 02

**Status:** resolved

- [x] The lockfile reader is a pure function over bytes: it handles version 1 and version 3 files, a missing `skills` key, invalid JSON, and an entry with no `source`.
- [x] Each group is one command: `npx -y skills@latest add <source> --skill <name>... [--agent <harness>...] [-g] -y`, with repeated `--skill` and `--agent` flags.
- [x] The user groups run first with `-g`; the project groups run from the Project root without it.
- [x] A tier with no harness list omits the agent flags; a tier with a list passes every name in it.
- [x] `--dry-run` prints every command and runs nothing; a real run prints each command and its exit status.
- [x] A missing user lockfile still installs the project skills, and the reverse; one failed command does not stop the rest.
- [x] A fake `npx` on `PATH` records the exact argv, order, and exit statuses; the test asserts them without a network or a real install.
- [x] `bun run check` is green.
## Answer

`src/environ/skills.ts` owns the lockfile reader and the installer; `acm skills install [--dry-run]`
in `src/cli/main.ts` is the only caller, re-exported through `src/environ/service.ts` like the run.

The reader is a pure function over bytes (`parseSkillsLock`), with `readSkillsLock(file, tier)`
as the thin filesystem wrapper for existence and readability: it accepts the shared
`{ version, skills }` shape both lockfiles use (global v3, project v1 — the version field is not
gated, so a newer schema's entries still read), warns on unreadable bytes, invalid JSON, or a
missing/non-map `skills` key, and skips an entry without a string `source` with a warning. Member
order comes from a byte-level walk, not `Object.entries`, because `JSON.parse` orders
integer-like keys numerically and the lockfile's file order is the truth. The root and per-entry
shapes parse through zod at the I/O boundary. The global path is the fixed
`~/.agents/.skill-lock.json` — the spec names it and no environment variable moves it; the project
path is `<project>/skills-lock.json`.

`skillsCommands` is the pure grouping half: entries group by `source` in first-seen order, names keep
file order, and each group spells `npx -y skills@latest add <source> --skill <name>... [--agent
<harness>...] [-g] -y` — user tier first with `-g`, project tier from the Project root without it, and
a tier with no declared harnesses omits `--agent`. The harness lists come from
`loadEnvironment(config).harnessesByTier`, the per-file lists ticket 02 added.

`skillsInstallRun` prints warnings to stderr, prints each command (shell-quoted via
`installCommand`'s `shellWord`, now exported from `command.ts`, and printed through `printable` so
file bytes cannot forge a line — the argv itself is untouched), spawns `npx` with argv — no shell —
and prints `exit <status>` per command; a non-zero status, a spawn error, or a spawn that throws
(a NUL byte in an argument, say) makes the exit status 1 while every group still runs. `--dry-run` prints the commands and `dry run: nothing was run`.
Nothing touches the store.

Tests: `src/environ/skills.test.ts` covers Seam B (reader shapes) and Seam A (a fixture with a fake
`npx` on PATH recording argv and cwd per call — exact argv, order, `-g` placement, `--agent` set and
omission, `--dry-run`, warnings, failure continuation, exit status). `src/cli/main.test.ts` gained
the Seam C smoke: the built bundle on `acm skills install --dry-run` with fixture lockfiles.
`bun run check` is green: 316 tests.
