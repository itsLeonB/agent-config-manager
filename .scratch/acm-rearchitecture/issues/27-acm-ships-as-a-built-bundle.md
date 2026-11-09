# 27: `acm` ships as a built bundle

**What to build:** an installed `acm` that a harness can pin as an absolute bin path and run on Node ≥ 22.5 with no Bun present, from any working directory. One build command emits a single ESM file; the package `bin` points at it with a Node shebang; the engine derives its own project root and default store path from where that file actually sits. The process smoke test spawns the built file rather than the TypeScript entry, so packaging is verified where a harness would use it — the five tool names, `tools/list`, and one mirror landing bytes on disk through the MCP surface.

The root derivation and the build land together: today's root resolution assumes the engine sits two directories under the project root, which a bundle breaks, so shipping the bundle without the new derivation would install a binary that reads the wrong store. Every other subcommand (`list`, `inspect`, `mirror`, `apply`, `verify`, `setup`) keeps working from the bundle unchanged.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] One documented command emits a single ESM entry file, and the package `bin` field points at it with a Node shebang; the repo's checks stay green.
- [ ] Run from a foreign working directory with no `ACM_PROJECT_ROOT` set, the built binary resolves the same project root and default store path the TypeScript entry does — asserted for both entry forms, not just the bundle.
- [ ] `ACM_HOME` / `ACM_PROJECT_ROOT` / `ACM_STORE` still override the derived values from the built binary.
- [ ] The process smoke test spawns the built file over stdio and asserts: the five tool names, the declared read-only / destructive hints, and one `plan_mirror` → `apply_plan` landing bytes on disk in a fixture home.
- [ ] The `shortcut:` comment that records "the bin is the TypeScript entry until a build lands" is gone, and the bin path asserted in the test is the one the package declares.
