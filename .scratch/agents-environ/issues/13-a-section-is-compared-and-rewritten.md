# 13: A Section is compared, and rewritten

**What to build:** one instruction text serves three harnesses. `acm status` reads the Section of a
native instruction file whose heading that text spells and compares it byte for byte, so editing the
text flips three rows to `absent`; `acm install` rewrites each Section and touches nothing else in
those files.

**Blocked by:** 12

**Status:** resolved

- [x] `{ file, section = "<payload>" }` answers `present` when the Section's text matches the Payload
      after trailing blank lines are stripped from both sides, and `absent` when the section is
      missing or the text differs.
- [x] The section's heading is the Payload's first `## ` line; `### ` headings do not end a Section and
      `## ` lines inside a fenced code block neither start nor end one.
- [x] A Payload with no `## ` line, an unreadable Payload, and two Sections sharing one heading each
      answer `unknown` with a reason.
- [x] `install = { file = "<native file>", section = "<payload>" }` replaces the Section in place,
      appends it at end of file when it is missing, and creates the file when that file is missing.
- [x] Every byte outside the Section is identical after the write, verified by running the write twice
      and once after a hand edit.
- [x] spec.md's Environment file and Install sections carry the sixth predicate and the write.
- [x] Tests cover a matching Section, a drifted Section, an unbalanced marker-free file, a missing
      file, and a fenced `## ` line.

## Answer

`src/environ/section.ts` owns the span: `headingOf` (the Payload's first `## ` line), `readSection`,
`stripTrailingBlankLines`, and `rewriteSection`. One implementation, so the Check and the write cannot
disagree about where a Section ends. The scanner tracks three-backtick fences, so a `## ` inside one
neither starts nor ends a Section, and `### ` never ends one.

The Check is `{ file, section }` and stands alone beside its `file` — `section` beside any other
predicate refuses the file. A Check now also receives the bytes of its Payload (`CheckInputs.payload`),
read once in `checkInputsOf`. `absent` covers a drifted Section, a missing Section and a missing
native file; `unknown` covers a Payload that cannot be read or has no `## ` line, a native file that
cannot be read, and two Sections sharing the heading.

The install shape writes through the same span: replace in place, append at end of file when the
Section is missing, create the file when it is missing. It spawns nothing. Success records exit `0`,
and a failure records `null` — nothing ran — with the reason in the entry's `failure` and the printed
summary, matching the unreadable-Payload precedent from ticket 12. The preview and the Run's command
field share one spelling: `write <native file> from <payload path>`, paths only, never the bytes.
The MCP tool's `install` union gained the third member in the same commit.
