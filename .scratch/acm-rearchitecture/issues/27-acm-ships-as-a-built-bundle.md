# 27: `acm` ships as a built bundle

**What to build:** an installed `acm` that a harness can pin as an absolute bin path and run on Node ≥ 22.5 with no Bun present, from any working directory. One build command emits a single ESM file; the package `bin` points at it with a Node shebang; the engine derives its own project root and default store path from where that file actually sits. The process smoke test spawns the built file rather than the TypeScript entry, so packaging is verified where a harness would use it — the five tool names, `tools/list`, and one mirror landing bytes on disk through the MCP surface.

The root derivation and the build land together: today's root resolution assumes the engine sits two directories under the project root, which a bundle breaks, so shipping the bundle without the new derivation would install a binary that reads the wrong store. Every other subcommand (`list`, `inspect`, `mirror`, `apply`, `verify`, `setup`) keeps working from the bundle unchanged.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] One documented command emits a single ESM entry file, and the package `bin` field points at it with a Node shebang; the repo's checks stay green.
- [x] Run from a foreign working directory with no `ACM_PROJECT_ROOT` set, the built binary resolves the same project root and default store path the TypeScript entry does — asserted for both entry forms, not just the bundle.
- [x] `ACM_HOME` / `ACM_PROJECT_ROOT` / `ACM_STORE` still override the derived values from the built binary.
- [x] The process smoke test spawns the built file over stdio and asserts: the five tool names, the declared read-only / destructive hints, and one `plan_mirror` → `apply_plan` landing bytes on disk in a fixture home.
- [x] The `shortcut:` comment that records "the bin is the TypeScript entry until a build lands" is gone, and the bin path asserted in the test is the one the package declares.

## Answer

`bun run build:acm` (`bun build src/cli/main.ts --target node --format esm --outfile dist/acm.mjs`)
emits the single ESM file the package `bin` declares, `./dist/acm.mjs`, with the `#!/usr/bin/env node`
shebang `src/cli/main.ts` now carries. `bun run test` builds it first, so the MCP smoke test in
`src/mcp/server.test.ts` spawns the declared bin — and spawns it with `node`, not `process.execPath`,
because a suite that only ever ran the bundle under Bun would not say the bundle is a Node program.

Choices worth knowing beyond the ticket:

- **The root is found, not counted.** `deriveProjectRoot(from)` in `src/engine/config.ts` walks up
  from the running module's own directory to the nearest `package.json` and returns that directory;
  a directory chain with no package above it keeps the module's own directory. The source entry
  (`src/engine/config.ts`) and the bundle (`dist/acm.mjs`) therefore resolve the same project root —
  and the same `database/dashboard.db` — because both sit under the package the build belongs to,
  not because they sit at a fixed depth. That is what `ACM_PROJECT_ROOT` / `ACM_STORE` still
  override, unchanged.
- **`bun run build` chains the engine build** (`vite build && bun run build:acm`) because Vite empties
  `dist/` and would otherwise delete a bundle an installed `acm` points at. The ticket asks for one
  documented command, which `build:acm` is; this line only keeps the artifact alive across a
  dashboard build.
- **`src/engine/config.test.ts`** asserts the derivation for both entry forms — the source form by
  calling `resolveDefaultConfig()` with the overrides cleared, the built form by copying the bundle
  into a package-shaped fixture, running it from a foreign working directory on Node, and finding
  its store under that fixture's own root. It also asserts all three overrides in both forms, and
  the loose-bundle fallback.
- **The smoke test's own evidence is unchanged in shape**: the five tool names, the four
  `readOnlyHint: true` declarations beside `apply_plan`'s `readOnlyHint: false` /
  `destructiveHint: true`, and a `plan_mirror` → `apply_plan` round-trip landing
  `mcp_servers.serena` in a fixture home's `config.toml`. `binPath()` reads `bin.acm` from
  `package.json` and asserts the Node shebang on whatever that resolves to, so a regression back to a
  TypeScript entry fails on the first assertion rather than at spawn.
