# 12: Declared text lives in a Payload

**What to build:** an Install command too long to read inline lives in a file, so a two-thousand
character one-liner becomes an entry you can read and lint. The entry names the Payload and, when it
wants to, the arguments; the arguments reach it as argv and are never substituted into its text.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `install` is either a string or `{ payload = "<path>" [, args = [ … ]] }`, and both forms are
      printed in the run's preview exactly as they will run.
- [ ] A Payload path resolves the way a Check's file does: `~` or an absolute path as written,
      anything else against the Tier's root.
- [ ] A Payload runs as `sh <payload> <args…>` from the Tier's root, so it needs no executable bit.
- [ ] A Payload that cannot be read fails its entry and spawns nothing, and that entry's Presence is
      re-evaluated as usual.
- [ ] The Run records the Payload path followed by its arguments, not the bytes the file held.
- [ ] `define_provision` writes either form, and refuses one the loader would refuse.
- [ ] spec.md's Environment file and Install sections carry both shapes.
- [ ] Tests cover arguments reaching the Payload, a missing Payload, and the recorded command.
