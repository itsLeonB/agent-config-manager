# 13: A Section is compared, and rewritten

**What to build:** one instruction text serves three harnesses. `acm status` reads the Section of a
native instruction file whose heading that text spells and compares it byte for byte, so editing the
text flips three rows to `absent`; `acm install` rewrites each Section and touches nothing else in
those files.

**Blocked by:** 12

**Status:** ready-for-agent

- [ ] `{ file, section = "<payload>" }` answers `present` when the Section's text matches the Payload
      after trailing blank lines are stripped from both sides, and `absent` when the section is
      missing or the text differs.
- [ ] The section's heading is the Payload's first `## ` line; `### ` headings do not end a Section and
      `## ` lines inside a fenced code block neither start nor end one.
- [ ] A Payload with no `## ` line, an unreadable Payload, and two Sections sharing one heading each
      answer `unknown` with a reason.
- [ ] `install = { file = "<native file>", section = "<payload>" }` replaces the Section in place,
      appends it at end of file when it is missing, and creates the file when that file is missing.
- [ ] Every byte outside the Section is identical after the write, verified by running the write twice
      and once after a hand edit.
- [ ] spec.md's Environment file and Install sections carry the sixth predicate and the write.
- [ ] Tests cover a matching Section, a drifted Section, an unbalanced marker-free file, a missing
      file, and a fenced `## ` line.
