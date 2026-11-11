# 01: Remove the project-local tier

**What to build:** `acm` reads two environment files, `user` and `project`. The gitignored local file is no longer read, named, or accepted anywhere: the tier list, the loader's file table, the `--tier` filter, the MCP schema, and the docs all have two members. `define_provision` requires an explicit tier, so an unreviewed definition cannot land in a committed file by accident.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The tier list has `user` and `project` only, and the loader reads the user file plus the project file when the Project root has one.
- [ ] A fixture with `agents_environ.local.toml` shows that file has no effect on status, install, or definitions.
- [ ] `--tier project-local` is refused with the two valid names; `--tier user` and `--tier project` still work.
- [ ] `define_provision` without a tier is refused; with a tier it writes to that file and nowhere else.
- [ ] The MCP tier enum has two members and no default, and `list_harnesses`/`acm_instructions` no longer name `project-local`.
- [ ] The gitignore entry for the local file is removed.
- [ ] README, CONTEXT, and the environment spec lose `project-local`; the tests that asserted three files now assert two.
- [ ] `bun run check` is green.