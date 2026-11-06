# 23: Skills and instructions

Type: task
**Status:** resolved

**What to build:** mirroring a skill once into the shared agents skill directory that all three
harnesses read, and mirroring instruction files. The skill is one installation with several bindings,
so mirroring it into a second harness returns already-shared with nothing to write instead of a second
copy. User-scope instruction files are written per harness; the project instruction file is the same
file for all three and is therefore recognised as already present.

**Blocked by:** 20.

- [x] a mirrored skill lands in the shared location and is reported once, with one binding per harness that reads it
- [x] mirroring the same skill into another harness returns already-shared and writes nothing
- [x] unknown frontmatter keys survive the copy, and verification asserts the copied content
- [x] a user-scope instruction file is written per harness, while the project instruction file returns already-present with no writes
- [x] a write that lands somewhere several harnesses read states which ones also read it
- [x] the symlink path is used only where the spec permits it, and falls back to a copy where it is unverified

## Answer

Landed as the shared skill reader in `src/engine/adapters/skills.ts`, the instruction reader in
`src/engine/adapters/instructions.ts`, per-tier location declarations (`categoryPaths`) in
`adapters/types.ts` and the three adapter descriptors, the skill and instruction planners plus the
`category` / write-union / digest-assert additions to the plan document in `src/engine/plan.ts`, the
`writeFile` / `copyFile` / `symlink` executor and digest verification in `src/engine/apply.ts`,
`digestOfPath` in `src/engine/digest.ts`, the category dispatch and target address in
`service.ts` — with `skills-instructions.test.ts`, one test per checklist line.

Choices worth knowing beyond the ticket:

- **A tier declares every location it reads, per category, and where a mirror lands among them.** MCP
  stays one parsed config file (`configPaths`); skills and instructions declare `categoryPaths`, so
  `declaredPaths()` is what containment *and* `alsoReadBy` read. A skill target is
  `<declared root>/<name>`, so containment is "the file is declared or under a declared root" for
  every category — still one rule, no second path list.
- **A skill is one reader over three location sets.** All three harnesses implement the Agent Skills
  spec, so `readSkillTier` walks whatever roots the tier declares: `~/.agents/skills` for all three,
  plus each harness's own `skills/` directory. That is what makes the shared row carry one binding
  per harness, and why the harness-private location is readable as a source but never a target.
- **A second mirror writes nothing because the target *is* the source.** The disposition is computed
  from resolved paths, so `.agents/skills/<name>` mirrored into any of the three returns
  `alreadyShared`; a target that holds the same tree returns `alreadyPresent`.
- **The copy carries no bytes in the document.** A `copyFile` write names the source and its digest;
  the planner re-reads the source to classify it and apply re-reads it to copy it, so a credential in
  a `SKILL.md` is a `credential` gap with a manual step instead of bytes that leave the engine. A
  source that changed after planning is `stale`, checked in the same pass as the target preconditions.
- **An instruction file's body is the plan's value, and a credential in it stops the write.** The
  stored row already withholds an unclean body (`classifyWholeFile` per line, persisted as a marker
  for the whole-file pointer kind ticket 13 settled), so the plan reports a `credential` gap and
  never carries the text.
- **The link is the spec's one permitted case, and a skill never gets one.** A user-scope instruction
  file is a `symlink` only when the source shares its scope bucket and nothing exists at the target; a
  project instruction file, or one coming from another bucket, is a `writeFile`. Skill directories are
  always copied, because symlinked skill directories are unverified for all three harnesses. The
  containment check lets exactly that write carry a symlink at its final component — and still
  refuses one whose resolved target leaves `$HOME` or the project root.
- **A differing whole file is a conflict *and* a write, so `onConflict: replace` answers it.** A
  differing skill directory is a conflict with no write, because replacing it would need the removal
  op this slice does not have.
- **File ops are performed, so the risk gate no longer treats them as unperformable.** Ticket 22
  gated "an op this engine does not perform", which at the time was every non-pointer op. `writeFile`,
  `copyFile` and `symlink` are now ops the engine performs: they stay risk conditions (a client that
  can ask a human still asks), but `isGated` keeps only the per-write flags — executable,
  secret-values, irreversible — so a copy is not returned as a manual step it could never then
  perform. `runCommand`, the empty-allowlist op, remains the one the plan schema does not admit.
- **The plan document gains its category, a whole-path assertion, and a copy's source digest.** The
  shape block and §5 of the spec were amended with them: `verify.asserts[]` is `{file, pointer,
  equals}` for an addressed value and `{file, digest}` for a copied tree or a written file, which is
  how a skill verifies without a copy-back.
- **Codex's project instruction cap and its own override file are manual steps**, not refusals: an
  `AGENTS.override.md` beside the target shadows it, and a project document over 32 KiB is truncated
  by Codex's `project_doc_max_bytes`.

### Review follow-up (spec axis)

Six holes closed after the first landing, and two limits accepted out loud:

- **A read root is not a write path.** Containment now holds a plan to the tier's `writePaths` for the
  plan's category — the config files for `mcp`, the declared `target` for `skills`/`instructions` —
  while `alsoReadBy` keeps answering from the reads. Without that split, `~/.pi/agent/skills`, which
  the ticket calls readable-but-never-a-target, passed containment from a hand-edited document.
  `declaredPaths` and `writePaths` are both exhaustive switches over `Category`.
- **Trust is per (tier, category), not per tier.** Codex gates its whole project layer; Pi gates a
  project's `.agents/skills` (and its own project config) behind `/trust`; Pi's instruction-file
  discovery does not consult trust at all. So a `pi:project` skill copy is `trust: required` with a
  step naming `/trust`, and a `pi:project` instruction write is not — while `codex:project` is both.
  The shared Codex trust step is one helper now instead of two copies.
- **A differing skill can no longer be "replaced" into a silent no-op.** The conflict carries a manual
  step naming the directory to remove, and `apply` refuses `onConflict: replace` when a conflicted
  file has no write to answer it: this slice has no removal op, so claiming a replacement would be a
  lie. (A differing instruction file carries its write, so `replace` works there.)
- **Same-directory shadows are named, and the ancestor ones are stated.** A plan for an instruction
  file lists whichever of `AGENTS.override.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` sits beside the
  target — they outrank it for Pi and Codex — and, at project scope, says that every ancestor
  `AGENTS.md` is loaded too. Ancestor files are combined rather than replacing, so they are one note
  rather than one step per file.
- **Codex-only note no longer fires on every harness.** The `project_doc_max_bytes` step follows
  whether Codex actually reads the target (`target.harness === 'codex'` or it is in `alsoReadBy`).
- **The tree digest has no depth cap.** The walk is bounded by the resolved directories on the way to
  a file, so a link back to an ancestor ends there while two sibling links to one directory are both
  described. A cap that silently skipped a deep subtree would have made verification pass on a copy
  that differs only below it.

Limits, stated rather than hidden:

- **A copy creates the directory it lands in.** §4 lists no create-directory *op*; a `copyFile` into
  `.agents/skills/<name>` still has to make that path, and the plan grades every new location risky.
- **The spec itself was amended** (§4's shape block for `category`, `sourceDigest` and the digest
  assertion; §5's sentence about which writes a non-eliciting face hands back), because without them
  a copy or a link could never be planned or performed.
- **Accepting the consequence of that §5 amendment:** on the CLI — a face with no elicitation — a
  risky copy or link now lands `client-policy` instead of coming back as a manual step, because it is
  a write this engine performs. The plan is still graded `risky`, so a client that can ask a human
  still asks.
