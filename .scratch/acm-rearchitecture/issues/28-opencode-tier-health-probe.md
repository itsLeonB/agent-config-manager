# 28: OpenCode tier health comes from the real probe

**What to build:** an OpenCode config file that parses but which OpenCode itself rejects is reported as `unreadable` for that tier, so discovery tombstones nothing and the inventory reads as incomplete rather than smaller. Health becomes measured rather than assumed: local parse first (cheapest gate — a file that does not parse is `unreadable` with no spawn at all), then one probe per discovery pass whose diagnostics map back to the tier that owns the offending source file, then a spawn failure that also reads `unreadable`.

A machine without an `opencode` binary must not fail discovery: the probe degrades to the local parse verdict, which is what the engine reports today. The probe is verifiable without the real tool — a stub executable on `PATH` emitting one invalid-source diagnostic is enough to drive the mapping.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] A config that parses locally but is rejected by the probe reports `unreadable` for that harness and tier, with a detail naming the diagnostic.
- [x] A config that does not parse locally reports `unreadable` without spawning anything.
- [x] The probe runs once per discovery pass, not once per tier or per category, and its diagnostics map to the tier whose declared source file the diagnostic names.
- [x] A probe binary that is missing, or that exits non-zero, degrades to the local parse verdict instead of failing discovery, and that degradation is observable in the stored detail.
- [x] An `unreadable` tier tombstones no installation — the existing tombstone gate is asserted against the probe-driven case, not only the parse-driven one.
- [x] The `shortcut:` comment recording "health comes from parsing the file, not the probe" is gone.

## Answer

Landed as `src/engine/adapters/opencode/probe.ts` plus a fourth parameter on `readTier`.

`readTier` now takes an optional `TierProbe` and applies spec §9's gate order in one place, so no
adapter re-implements it: a file that fails the local parse returns before the probe exists on the
stack; a tier with no config file never spawns (nothing to judge); a surviving tier asks the probe
once and is `unreadable` only when a `kind=invalid` diagnostic resolves to one of the files it just
read — matched on the resolved path, because the harness reports absolute ones. A probe-driven
`unreadable` returns `installations: []`, the same shape the parse failure returns, which is what
keeps `repo.recordDiscovery` from upserting or tombstoning anything for that tier.

`openCodeProbe(config)` builds the memoised probe the adapter factory holds for one pass, so the
spawn count is one per discovery pass regardless of how many tiers or categories consult it
(`createAdapters` runs once inside `discover`). It spawns
`opencode debug config --standalone --print-logs --log-level warn` in the injected project root with
`HOME` set to the injected home, parses the logfmt diagnostics on stderr
(`source=` + `path=` + `action=` for each `kind=invalid`), and treats a missing binary, a spawn
error, a 20s timeout, or any non-zero exit as `unavailable` — the tier keeps `ok` with a detail
naming the degradation, as the spec's §9 line now says.

Choices worth knowing beyond the ticket:

- The probe's binary is a boundary fact on `EngineConfig` (`opencodeProbe?: string | false`, default
  `opencode` from `PATH`), because it is a subprocess and a test must never run the real one. Every
  fixture builder passes `false`; the probe tests pass a shell stub, one of them through `PATH` to
  cover the shipped default. Without that, a developer machine with OpenCode installed would spawn
  it on every `discover()` in the suite and the real binary's verdicts would decide test outcomes.
- Diagnostics that name a file no tier declares are ignored rather than escalated: OpenCode merges
  ancestor configs, so a parent directory's problem is not this project's tier.
- The probe's environment is narrowed, not inherited: `HOME` is the injected home and OpenCode's
  redirecting variables (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`,
  `OPENCODE_CONFIG_PROJECT_DISABLE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`) are dropped. Inheriting them
  would let a dev shell point the probe at another file, whose diagnostics name no declared path, and
  every tier would read `ok` however broken it is. The trade-off is that a user who deliberately
  moves `XDG_CONFIG_HOME` gets a probe that disagrees with their shell — the tier table already
  assumes `$HOME/.config`, so the two now fail together instead of silently disagreeing.
- The parse gate is per tier, not per pass: if one OpenCode tier parses and another does not, the
  pass spawns once for the parseable tier before the broken one reports. No config that fails the
  parse causes a spawn, and the probe is read-only, so this is a cost limit rather than a correctness
  one.
- Declared files and diagnostic sources are compared by filesystem identity, not by their resolved
  strings: a symlinked `~/.config` or a dotfiles checkout makes OpenCode report the physical path, and
  a string comparison would read that tier as clean. Overflowing the probe's output buffer keeps the
  diagnostics that did arrive instead of degrading, and a probe degradation survives a later
  category's read failure so the tier detail carries both reasons.
- Health is still reported per tier through the `mcp` handler, which owns `configPaths`; the merge in
  `discover` already lets one category's `unreadable` speak for the tier.
