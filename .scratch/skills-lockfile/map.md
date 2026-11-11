# Skills lockfile and two-tier environment

Spec: [spec.md](../spec.md). Tickets: [issues/](issues/).

## Notes

- Two tiers only: `user` (`~/agents_environ.toml`) and `project` (`<repo>/agents_environ.toml`).
  The gitignored `agents_environ.local.toml` is gone everywhere.
- Each file's `harnesses` list is its own and never merges. A file with a list refuses entries
  outside it; a file with none accepts any non-empty, NUL-free name.
- Skills leave the Provision model: `acm skills install` reads the two skills lockfiles and runs
  `npx skills add` per source group with the tier's harness list. An intentional `skills-*`
  Provision stays a legal generic Provision.

## Decisions so far

- [01 Remove the project-local tier](issues/01-remove-the-project-local-tier.md): resolved on
  `f8f7ff8` — `ENVIRONMENT_TIERS` is `['user', 'project']`; `define_provision` requires an
  explicit tier and refuses an out-of-list one; MCP tier enum has two members, no default.
- [02 Per-tier harness lists and validation](issues/02-per-tier-harness-lists-and-validation.md):
  resolved on `4d509a2` — `Environment.harnessesByTier`/`Status.harnesses` are per-tier records;
  the parser refuses an entry outside the file's own list; `define_provision` checks the target
  file's list before writing; `acm status` footer and `list_harnesses` answer per tier.

## Fog

- [03 The declare_harnesses MCP tool](issues/03-declare-harnesses-mcp-tool.md) and
  [04 Install skills from the lockfiles](issues/04-install-skills-from-the-lockfiles.md) are
  unblocked (both list `Blocked by: 02`, now resolved). 03 can start first; 04 depends only on
  02 as well, so either order works.
