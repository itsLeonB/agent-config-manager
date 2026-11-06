# 23: Skills and instructions

Type: task
**Status:** ready-for-agent

**What to build:** mirroring a skill once into the shared agents skill directory that all three
harnesses read, and mirroring instruction files. The skill is one installation with several bindings,
so mirroring it into a second harness returns already-shared with nothing to write instead of a second
copy. User-scope instruction files are written per harness; the project instruction file is the same
file for all three and is therefore recognised as already present.

**Blocked by:** 20.

- [ ] a mirrored skill lands in the shared location and is reported once, with one binding per harness that reads it
- [ ] mirroring the same skill into another harness returns already-shared and writes nothing
- [ ] unknown frontmatter keys survive the copy, and verification asserts the copied content
- [ ] a user-scope instruction file is written per harness, while the project instruction file returns already-present with no writes
- [ ] a write that lands somewhere several harnesses read states which ones also read it
- [ ] the symlink path is used only where the spec permits it, and falls back to a copy where it is unverified

