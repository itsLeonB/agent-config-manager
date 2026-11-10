# 12: Declared text lives in a Payload

**What to build:** an Install command too long to read inline lives in a file, so a two-thousand
character one-liner becomes an entry you can read and lint. The entry names the Payload and, when it
wants to, the arguments; the arguments reach it as argv and are never substituted into its text.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `install` is either a string or `{ payload = "<path>" [, args = [ … ]] }`, and both forms are
      printed in the run's preview exactly as they will run.
- [x] A Payload path resolves the way a Check's file does: `~` or an absolute path as written,
      anything else against the Tier's root.
- [x] A Payload runs as `sh <payload> <args…>` from the Tier's root, so it needs no executable bit.
- [x] A Payload that cannot be read fails its entry and spawns nothing, and that entry's Presence is
      re-evaluated as usual.
- [x] The Run records the Payload path followed by its arguments, not the bytes the file held.
- [x] `define_provision` writes either form, and refuses one the loader would refuse.
- [x] spec.md's Environment file and Install sections carry both shapes.
- [x] Tests cover arguments reaching the Payload, a missing Payload, and the recorded command.

## Answer

`InstallCommand` in `types.ts` is a union of the command string and `{ payload, args? }`. The parser
decodes both and refuses anything else at the offending key; the loader resolves the Payload path
against the Tier root with the same `resolveDeclaredPath` a Check's `file` uses, so a Payload is read
from the tier it was declared in.

One function, `installCommand` in `loader.ts`, produces the single spelling that is both printed and
recorded: `sh <resolved payload> <args…>`. The runner spawns that string through the same shell, same
`cwd`, same `/dev/null` stdin and unchanged environment as every other command, so a Payload needs no
executable bit. A Payload that cannot be read is gated by `accessSync(R_OK)` before the spawn, fails
its entry with the reason and no exit code, and the run continues with the next entry.

Follow-up fixed in the merge: joining arguments with a space sent an argument holding a space or a
quote to the shell as several words, so the argv the Payload saw was not the argv the file declared.
`installCommand` now quotes each word for the shell (`'a b'`, `it'\''s`) and leaves a plain word bare,
so the preview still shows exactly what runs. Tested in `runner.test.ts`.
