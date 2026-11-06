# 19: Mirror plan into a Codex target

Type: task
**Status:** resolved

**What to build:** `acm mirror <installation> --target codex:user --plan` prints one complete plan
document for moving an MCP server from Pi to Codex, and writes nothing. The document enumerates where
every source field went — carried, mapped with the transform named, dropped with a reason, or
preserved — lists the exact native addresses to write with the target's current digest as a
precondition, shows the target diff and not a whole-file copy, names any manual step, and carries the
plan's own hash and its safe-or-risky grade. A target tier that cannot be written is refused before a
plan is produced.

**Blocked by:** 16, 17, 18.

- [x] the plan document carries the source and target identity, the field partition, the writes with per-file preconditions, the manual steps, the verification assertions, and the grade
- [x] planning changes nothing on disk
- [x] the plan's id is recomputed from its own body, and a body edited by hand fails that check
- [x] every source field appears exactly once in the partition; an unexpressible field becomes a gap and an unknown one is marked preserved
- [x] the rename, unit, extract, and wrap transforms each appear in a test with a real field pair, including the header-to-token-variable case that would otherwise ship a literal reference
- [x] a non-writable or non-existent target tier is refused as caller input, before any plan exists
- [x] a shared native location reports which other harnesses also read it

## Answer

Landed as `src/engine/plan.ts` (the planner, the plan document, `planIdOf`/`planIntact`, `alsoReadBy`),
`src/engine/adapters/mcp-write.ts` (one write surface per harness — the `expressible` rules, the seven
transforms, and the fields each target provably lacks), `planMirror` in `service.ts`, and
`acm mirror <id|prefix> --target <tier> --plan` — plus `plan.test.ts`, one test per checklist line.

Choices worth knowing beyond the ticket:

- **The plan reads the stored, already-classified row and re-reads only the target file.** Every
  value in it therefore comes from `knownFields`, where a credential is already a `[withheld: …]`
  marker: such a field can only become a `credential` gap with a manual step, never a write. This is
  also why a literal `env` value is a gap while `env.K: "${K}"` is carried — the classifier's
  reference rule decides, not the planner. A gap is per canonical field, so one withheld entry in
  `env` makes the whole map a `credential` gap; the manual step is the whole map's.
- **All three harnesses declare a write surface**, so the ticket's four transforms are each testable
  on a real pair: `rename` (Pi `timeout` → Codex `tool_timeout_sec`), `unit` (Codex
  `startup_timeout_sec = 30` → OpenCode `timeout.startup = 30000`), `extract` (Pi
  `headers.Authorization: "Bearer ${T}"` → Codex `bearer_token_env_var: "T"`, the case that
  would otherwise ship a literal reference), and `wrap` (Codex `bearer_token_env_var: "T"` → Pi
  `headers.Authorization: "Bearer ${T}"`, and Codex `env_vars` → Pi `env.K: "${K}"`). `infer`,
  `concat`, and `invert` land with them.
- **`mapped[]` is per target field, not per source field**, because OpenCode's `command[]` consumes
  `command` + `args`; its `transform` comes from a closed seven, and `targetField` is `null` when the
  target carries the fact by which address field is present (`transport` in Codex and Pi). A field
  with no rule and no declared absence stays `preserved`, which is what an adapter fact added before
  its planner rule lands will look like.
- **A `!command` source value is an `executable` gap for any non-Pi target** (only Pi runs it), and
  the plan says so as a manual step rather than copying a literal command into Codex's `env`.
- **The grade is the engine's**: `risky` when the target file does not exist yet or any pointer
  disagrees with it, `safe` otherwise. Every write is a pointer write into a declared tier, so no
  flag or elevation can occur in this category.
- **`alsoReadBy` is computed from the declared tier paths**, not from a list of known shared places,
  so it answers `[]` for every MCP location today (all three are harness-private) and will report
  the sharers as soon as a shared category (`.agents/skills`, project `AGENTS.md`) is plannable.
- **Refusals are caller input, not plan documents**: an unknown harness or tier, a tier that is
  `notState`/`elevationRequired`, a non-`mcp` source, an ambiguous id, and a target file that exists
  but does not parse all return `{kind:'refused', reason}` and the CLI exits 1 with nothing written.
- **Planning writes nothing, including to the store.** `acm mirror` performs no scan: a scan
  persists, and would tombstone whatever the last pass no longer saw, as a side effect of asking
  for a plan. The source is the snapshot the last scan stored, read read-only; a fresh store is
  refused with the `acm list` hint, and a row a later scan tombstoned is refused too.
- **The plan refuses rather than guesses when the target is structurally incompatible**: a write
  whose parent pointer is a literal (`timeout = 30` under `timeout.startup`), a source that would
  leave the other transport field in place (a stdio write into an entry that still names `url`
  would be HTTP), a project override carrying neither `command` nor `url`, and an OpenCode server
  defined in two candidate files (which the tier honours is unverified) are all caller-visible
  refusals, not silent rewrites.
- **A value the plan reads back is classified before it is shown.** `priorValue` and
  `conflicts[].current` go through the same classifier on the pointer's canonical last two
  segments, so a literal token already sitting in the target file is withheld; a `${VAR}` or
  `!command` there stays readable.
- **Codex gets no `${VAR}`**: an all-reference `env` becomes `env_vars` (`extract`), OpenCode's
  becomes `{env:VAR}` (`wrap`), and a map mixing a reference with a literal is a `shapeOnly` gap
  rather than a literal that would never interpolate. A withheld field is never consumed by a
  multi-field rule, so a redacted `args` cannot be concatenated into an invented `command`.
- **A Pi `!command` write is `executable`** and lands in `security.executables`, which is what keeps
  a conflict-free plan from grading `safe`.
- `planId` hashes the canonical JSON (sorted keys) of the body with the id removed, so
  `planIntact(plan)` is the whole integrity check ticket 20 will call; the plan also verifies itself
  through a JSON round trip, which is how the CLI's output is asserted.
