# 16: `--only` selects a tag

**What to build:** after editing one instruction text, `acm install --only instructions` converges the
entries that carry that tag instead of the whole machine.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `--only <value>` selects every entry whose Provision carries that tag, as well as every entry
      whose Provision has that name, and a value that matches neither reports what was tried.
- [x] The preview printed before the first command names the selection that produced it.
- [x] `--only` still leaves a `present` entry alone without `--force`.
- [x] spec.md's Install stories carry tag selection beside name selection.
- [x] Tests cover a tag, a name, both, and a value matching nothing.

## Answer

One `matches(value, entry)` in `runner.ts` — the Provision's name or its `tags` — is used by both the
selection and the missing-value check, so the two cannot disagree about what a value names. `--tier`
still narrows the environment before `--only` reads it, so a tag only a filtered-out tier carries is
not found.

A value that matches nothing fails the run before anything is previewed, with the message
`no Provision named or tagged <value> (each tried as a name and as a tag)`. The preview gained one line
above the entries when `--only` was given — `selection: --only <values>` — rather than folding into the
counts header, so the existing counts and per-entry lines print unchanged. `acm` usage and `--only`'s
error message now name a Provision name or a tag. spec.md: story 36 and one clause in "The install run".
