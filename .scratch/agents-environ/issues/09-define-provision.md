# 09: `define_provision`

**What to build:** onboarding a harness becomes a tool call. An agent reads what the existing harnesses declare, then writes the missing Check and Install command for the new harness into a chosen environment file — comments and sibling Provisions intact, and visible as a diff in the human's dotfiles repository.

**Blocked by:** 03, 08

**Status:** ready-for-agent

- [ ] The MCP tool `define_provision` writes one Provision's Check and Install command for one harness and one tier, and declares `readOnlyHint: false`.
- [ ] The default tier is `project-local`, so an unreviewed definition never lands in a committed file.
- [ ] The write goes through the pointer-level native editor: comments and sibling Provisions survive, and a same-key write replaces that Provision's harness subtree only.
- [ ] It returns the pointer written and the file's digest.
- [ ] A definition the loader would refuse is refused by the tool, with the same reason.
- [ ] It never runs an Install command and never evaluates a Check.
- [ ] Scenario: given fixtures for two harnesses, an agent can read them and define the third harness's entries, and `acm status` then reports them; the resulting file diff contains only the added subtree.
