# 01: Remove the project-local tier

**What to build:** `acm` reads two environment files, `user` and `project`. The gitignored local file is no longer read, named, or accepted anywhere: the tier list, the loader's file table, the `--tier` filter, the MCP schema, and the docs all have two members. `define_provision` requires an explicit tier, so an unreviewed definition cannot land in a committed file by accident.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] The tier list has `user` and `project` only, and the loader reads the user file plus the project file when the Project root has one.
- [x] A fixture with `agents_environ.local.toml` shows that file has no effect on status, install, or definitions.
- [x] `--tier project-local` is refused with the two valid names; `--tier user` and `--tier project` still work.
- [x] `define_provision` without a tier is refused; with a tier it writes to that file and nowhere else.
- [x] The MCP tier enum has two members and no default, and `list_harnesses`/`acm_instructions` no longer name `project-local`.
- [x] The gitignore entry for the local file is removed.
- [x] README, CONTEXT, and the environment spec lose `project-local`; the tests that asserted three files now assert two.
- [x] `bun run check` is green.

## Answer

`ENVIRONMENT_TIERS` is `['user', 'project']`; the loader's file table lost its third entry, so
`agents_environ.local.toml` is never read — a fixture test proves it has no effect on status or
install. `defineProvision` requires `tier` (the MCP schema dropped `.optional()`), and an
out-of-list tier answers `{ kind: 'failed' }` rather than throwing. The `.gitignore` entry, the
README define_provision line, AGENTS.md's loader description, and the environment spec's
project-local passages are gone; the old spec's story 19 is struck through as superseded. Two-axis
review (standards + spec) ran clean after fixes: local-file coverage extended to install, the
missing-tier path returns a refusal-shaped outcome, and the duplicate `localFile`/`committedFile`
helpers merged into `projectFile`.
