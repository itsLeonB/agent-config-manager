# 05: One tier per run, a confirm prompt, and the harness gate

**What to build:** `acm skills install` runs one tier per invocation — the project tier by default,
the user tier with `-g`/`--global`. On a TTY the default run prints every command and asks before
running them; `-y`/`--yes` skips the ask, `--dry-run` prints and stops, and a non-TTY run without
`-y` prints and stops. A selected tier whose environment file declares no `harnesses` list — absent
file or absent key — warns and exits non-zero before any command is built, so `--agent` is always
present and the `skills` CLI's detector is never consulted. Spec: `.scratch/skills-lockfile/spec.md`
stories 5, 22–26 and the amended installer/execution decisions.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `-g`/`--global` selects the user tier; no flag selects the project tier; both tiers means two invocations.
- [x] An unknown flag is refused with the usage line, as today.
- [x] TTY default: commands print, a `[y/N]`-style prompt asks, yes runs, no (or EOF) runs nothing and exits 0.
- [x] `-y`/`--yes` prints and runs without asking; `--dry-run` prints and stops; non-TTY without `-y` prints and stops.
- [x] The confirm prompt is an injected callback beside `write`/`warn`; tests never touch a TTY.
- [x] A selected tier with no declared harnesses warns to stderr and exits 1 before any `npx` spawn; the other tier is untouched because it was never selected.
- [x] Every spawned command still carries `--agent` for each name in the selected tier's list; the omit-`--agent` path is gone.
- [x] A missing or invalid lockfile still warns and continues within the selected tier; every group still runs after a failure; any failure exits non-zero.
- [x] `bun run check` is green.

## Answer

`src/environ/skills.ts` runs one tier per invocation. `skillsInstallRun(write, warn, confirm,
options, config, env)` selects the tier from `options.global` — the user tier with `-g`/`--global`,
the project tier by default — and everything downstream touches only that tier: the environment
file, its harness list, the lockfile, and the command root (`config.home` for user, `config.projectRoot`
for project). Both tiers means two invocations.

The harness gate comes before anything else in the selected tier: a refused file warns the refusal
and exits 1, and a tier whose `harnessesByTier` entry is empty — absent file or absent key — warns
`the <tier> tier declares no harnesses` with the file path and exits 1. No command is built and no
`npx` spawns; the other tier is never read because it was never selected. `skillsCommands` now takes
one tier's read, harness list, and root, and `--agent` is always present — the omit path is gone.

Execution: the commands print first (shell-quoted, control characters printable-stripped). `--dry-run`
appends `dry run: nothing was run` and stops. `-y`/`--yes` runs without asking. Otherwise `confirm` —
the injected callback beside `write`/`warn` — receives `run these <n> command(s)? [y/N] `; a false
answer or an absent callback (non-TTY) runs nothing and exits 0. `src/cli/main.ts` passes a real
prompt (`confirmTty`, one line from stdin, y/yes accepts, EOF and errors decline) only when stdin is
a TTY and neither `-y` nor `--dry-run` was given. An unknown flag still refuses with the usage line,
now naming the new flags. Every group runs even after a failure; any failure, refused file, or spawn
throw makes the exit status non-zero; the store is untouched.

Tests: `src/environ/skills.test.ts` asserts the tier selection, the gate's three shapes (absent file,
absent key, refused file) with zero spawns, the prompt's yes/no paths through the injected callback,
the non-TTY print-and-stop, and the old grouping/failure/lockfile behaviour on either tier.
`src/cli/main.test.ts` smoke-spawns the bundle for `--dry-run` and `--dry-run -g`.
`bun run check` is green: 349 tests.
