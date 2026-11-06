# 24: Hooks across three different methods

Type: task
**Status:** ready-for-agent

**What to build:** mirroring a hook into each of the three targets by the method that target actually
has: native declarative config into Codex, declarative config plus a community bridge into Pi, and
generated plugin code into OpenCode. Event names are translated, not copied, and any event or matcher
with no counterpart becomes a stated gap. The work a human must do — enabling the feature, reviewing
trust, installing the bridge, restarting — is listed per target. Generated code and every write
carrying a command are flagged executable, ticked separately, and can never be reported as verified.

**Blocked by:** 20, 22.

- [ ] a Codex hook lands as a pointer write into native hook config, with the feature enablement and the trust review as manual steps
- [ ] a Pi hook lands as a pointer write, with the bridge install and a restart as manual steps
- [ ] a Codex hook targeting OpenCode lands as a generated plugin module, flagged executable, never verified, with a restart as the manual step
- [ ] event names are mapped per target, and every unmapped event appears as a gap
- [ ] a non-wildcard matcher is reported as its own gap rather than silently broadened
- [ ] OpenCode is readable as a hook target but never as a hook source
- [ ] a plan containing any generated or command-carrying hook write lands unverified

