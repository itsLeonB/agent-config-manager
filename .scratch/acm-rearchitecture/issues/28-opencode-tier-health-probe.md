# 28: OpenCode tier health comes from the real probe

**What to build:** an OpenCode config file that parses but which OpenCode itself rejects is reported as `unreadable` for that tier, so discovery tombstones nothing and the inventory reads as incomplete rather than smaller. Health becomes measured rather than assumed: local parse first (cheapest gate — a file that does not parse is `unreadable` with no spawn at all), then one probe per discovery pass whose diagnostics map back to the tier that owns the offending source file, then a spawn failure that also reads `unreadable`.

A machine without an `opencode` binary must not fail discovery: the probe degrades to the local parse verdict, which is what the engine reports today. The probe is verifiable without the real tool — a stub executable on `PATH` emitting one invalid-source diagnostic is enough to drive the mapping.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A config that parses locally but is rejected by the probe reports `unreadable` for that harness and tier, with a detail naming the diagnostic.
- [ ] A config that does not parse locally reports `unreadable` without spawning anything.
- [ ] The probe runs once per discovery pass, not once per tier or per category, and its diagnostics map to the tier whose declared source file the diagnostic names.
- [ ] A probe binary that is missing, or that exits non-zero, degrades to the local parse verdict instead of failing discovery, and that degradation is observable in the stored detail.
- [ ] An `unreadable` tier tombstones no installation — the existing tombstone gate is asserted against the probe-driven case, not only the parse-driven one.
- [ ] The `shortcut:` comment recording "health comes from parsing the file, not the probe" is gone.
