# 26: acm setup self-install

Type: task
**Status:** resolved

**What to build:** one command that installs ACM into all three harnesses as an ordinary MCP server
entry, using the same plan-and-apply path as every other mutation rather than a private write. The
entry points at the absolute installed binary with the server arguments and no working directory.
Running it again is harmless. Afterwards ACM appears in the inventory like any other server, and a
harness that cannot be written is refused rather than half-installed.

**Blocked by:** 25.

- [x] the written entry is the absolute binary path plus the server arguments, and carries no working directory
- [x] installation goes through a plan that is shown and applied, not a direct file write
- [x] a second run reports the entry as already present and writes nothing
- [x] ACM appears in the inventory as an ordinary installation afterwards, with no special-casing
- [x] an unwritable target harness is refused before any write, and the other harnesses' outcomes are reported separately

## Answer

`setupSelf(config, bin, options)` in `src/engine/service.ts`, reached as `acm setup` in
`src/cli/main.ts`. One plan per harness, built by the same `buildPlan` an ordinary mirror uses and
executed by the same `applyPlan`, so there is no second write path and no setup-specific write code.

Choices worth knowing beyond the ticket:

- **The source is the tool itself, and it is a canonical MCP entry.** `selfSource()` hands the
  planner `{transport: 'stdio', command: <bin>, args: ['mcp', 'serve'], enabled: true}` with an
  empty `installationId`, empty `harness`/`tierId`, and `nativeFile` the bin path: no scan has to
  have run first, and the id cannot collide with a store row (`sha256:<digest>`). `transport` is
  stated because OpenCode's local entries require `type: "local"`; the other two infer it and write
  nothing for it. `enabled` states the intent of an install, so an entry somebody disabled is not
  reported as already present while the harness never starts it — it comes back as a conflict naming
  `enabled`, and `--on-conflict replace` repairs it. Nothing writes `cwd`, which is what "no working
  directory" means in the document rather than in a comment.
- **A bin a harness could not spawn is refused, not recorded.** `acm setup` records
  `realpathSync(process.argv[1])` — what this process was started as — and only after `X_OK`
  confirms a harness could execute it. `src/cli/main.ts` is unexecutable in a checkout, so
  `bun run acm -- setup` refuses and says to install `acm` and run that; the alternative is a
  harness entry that fails with `EACCES` while setup reports success.
- **An empty source id is recorded as `null`, not invented.** `stampMirror` sets
  `mirrored_from_id`, which is a foreign key to `installations`; a provenance edge to a row that
  does not exist fails the write. `MirrorRecord.sourceInstallationId` is now `string | null`, and
  `recordMirror` passes null when the plan's source names no row.
- **`PlanSource.origin` is the one plan-schema-adjacent addition.** The MCP planner's
  `source-known-fields` prerequisite said "decoded from the last scan", which is false for a
  self-install; the optional field carries the clause instead, and every existing call site keeps
  the old sentence by omitting it.
- **The target tier is the first user-scope writable tier with config paths** — `pi:user`,
  `codex:user`, `oc:user`. A harness with no such tier is refused with a reason and no plan.
- **`alreadyPresent` is the planner's own answer, not a setup check.** The mcp planner compares each
  write's `priorValue` with its proposed value, so the second run plans zero writes and apply lands
  nothing; the CLI prints `already present` from the disposition.
- **A read-only target is refused by apply's existing preflight**, per harness. Each harness's plan
  is applied on its own, so one refusal leaves the other two installed and reported on their own
  lines; the exit code is non-zero because a harness did not settle. A harness whose writes landed
  but whose verification failed is printed as `verification failed` and also exits non-zero; a
  recording failure is caught per harness, so its landed writes stay where they are and the other
  two still install.
- **Pointer writes now create their directory.** `editPointers` in `apply.ts` did not `mkdir` where
  `writeWhole` did, so a first install into a machine that has never run OpenCode
  (`~/.config/opencode` absent) failed after preflight had approved it. One `mkdirSync` fixes the
  asymmetry for every pointer write, not only this one.
- **`acm setup [--on-conflict abort|replace] [--json]`.** The default output is one line per harness
  with the plan id and every write it carries (`pointer = value`), which is the plan being shown;
  `--json` prints the whole `SetupReport` including each `MirrorPlan`, for an agent to carry onward.

Tests are `src/engine/setup.test.ts`: the three entries' bytes, the harmless second run, the
inventory rows afterwards, a read-only target refused beside two landed ones, a missing config
directory, a bin that cannot be spawned, and — with the checkout's bin made executable for the
duration — the entry the CLI wrote, spawned from the Pi config's own `command`/`args` and answered
over MCP with the five tools.
