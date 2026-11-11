# 05: One tier per run, a confirm prompt, and the harness gate

**What to build:** `acm skills install` runs one tier per invocation — the project tier by default,
the user tier with `-g`/`--global`. On a TTY the default run prints every command and asks before
running them; `-y`/`--yes` skips the ask, `--dry-run` prints and stops, and a non-TTY run without
`-y` prints and stops. A selected tier whose environment file declares no `harnesses` list — absent
file or absent key — warns and exits non-zero before any command is built, so `--agent` is always
present and the `skills` CLI's detector is never consulted. Spec: `.scratch/skills-lockfile/spec.md`
stories 5, 22–26 and the amended installer/execution decisions.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `-g`/`--global` selects the user tier; no flag selects the project tier; both tiers means two invocations.
- [ ] An unknown flag is refused with the usage line, as today.
- [ ] TTY default: commands print, a `[y/N]`-style prompt asks, yes runs, no (or EOF) runs nothing and exits 0.
- [ ] `-y`/`--yes` prints and runs without asking; `--dry-run` prints and stops; non-TTY without `-y` prints and stops.
- [ ] The confirm prompt is an injected callback beside `write`/`warn`; tests never touch a TTY.
- [ ] A selected tier with no declared harnesses warns to stderr and exits 1 before any `npx` spawn; the other tier is untouched because it was never selected.
- [ ] Every spawned command still carries `--agent` for each name in the selected tier's list; the omit-`--agent` path is gone.
- [ ] A missing or invalid lockfile still warns and continues within the selected tier; every group still runs after a failure; any failure exits non-zero.
- [ ] `bun run check` is green.
