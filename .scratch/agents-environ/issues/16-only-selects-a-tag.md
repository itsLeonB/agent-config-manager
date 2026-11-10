# 16: `--only` selects a tag

**What to build:** after editing one instruction text, `acm install --only instructions` converges the
entries that carry that tag instead of the whole machine.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `--only <value>` selects every entry whose Provision carries that tag, as well as every entry
      whose Provision has that name, and a value that matches neither reports what was tried.
- [ ] The preview printed before the first command names the selection that produced it.
- [ ] `--only` still leaves a `present` entry alone without `--force`.
- [ ] spec.md's Install stories carry tag selection beside name selection.
- [ ] Tests cover a tag, a name, both, and a value matching nothing.
