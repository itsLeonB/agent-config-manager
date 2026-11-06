# 22: Risky plans, graded consent, and conflicts

Type: task
**Status:** resolved

**What to build:** a plan that carries executable content, secret values, an irreversible write, a copy
of a directory, a new directory, or a conflict is graded risky; everything else is safe. On a client
that cannot ask a human, the risky writes come back as manual steps while the safe remainder still
lands. A target that already matches, or is the source location itself, comes back with no writes at
all. A target that differs refuses until replacement is asked for explicitly.

**Blocked by:** 20.

- [x] each risk condition flips the plan's grade to risky, and a plan with none of them stays safe
- [x] a safe plan applies without any human answer, recorded as authorised by the client's own policy
- [x] a risky plan on a client without elicitation applies the safe writes and returns the risky ones as manual steps
- [x] an already-matching target and a target equal to the source each return a plan with no writes and the reason stated
- [x] a differing target refuses by default, shows both the current and proposed value, and proceeds only when replacement is explicitly requested
- [x] every gap reason maps to exactly one disposition, and a test fails if a reason has no rule
- [x] no flag, environment variable, or stored approval lets a risky write skip the gate

## Answer

Landed as the risk table plus `planGrade` and the `disposition` field in `src/engine/plan.ts`, the
gap-disposition table beside it, the graded split and the conflict gate in `src/engine/apply.ts`
(`ApplyOptions.onConflict`, `ApplyResult.grade` / `.consent`), `applyPlan(…, options)` in
`service.ts`, and `acm apply <plan.json|-> [--on-conflict abort|replace]` — with one test per
checklist line in `plan.test.ts` and `apply.test.ts`.

Choices worth knowing beyond the ticket:

- **Apply re-grades the document it is handed.** `planIdOf` is public, so any caller can re-sign a
  document that claims `security.grade: safe`; the gate is therefore computed at apply from the
  writes about to be performed, and the stricter of that and the claim wins. The operation row
  records the grade apply computed, not the claim. A test forges a `safe` grade around an
  `executable` write, and neither the write nor the record follows the document.
- **`RISK_CONDITIONS` is one table**, so a condition cannot be graded into existence by an adapter or
  forgotten by apply: `executable`, `secretValues`, `irreversible`, `copyFile`, `symlink`,
  `runCommand`, `newTargetFile`, `conflict`, `elevation`. The test holds one facts object per
  condition in a `Record<RiskCondition, RiskFacts>`, so a condition added without a case fails
  typecheck as well as the loop. `copyFile`/`symlink`/`runCommand` are unreachable through a plan
  document — `writes[].op` is pinned to `writeAtPointer`, so such a document is still refused as
  caller input — but they are graded, because the vocabulary names them.
- **The flag gate is per write, not per plan.** A client that cannot ask a human (the CLI included:
  it has no elicitation) gets the writes flagged `executable` / `secretValues` / `irreversible`, or
  carried by an op this engine does not perform, back as `manualSteps[]`; the rest still lands and
  the result is `applied` with `verification: unverified`. Such a write is handed over as `file` +
  `pointer`, never as its value, since a withheld value is a marker. A plan whose every write is
  gated is `refused` with those steps and writes nothing, rather than `applied` with an empty
  `landed[]`.
- **The narrowed plan is what gets asserted.** A gated write's assertion would report a correctly
  applied plan as `failed`, so the assertions are filtered down to the writes that can land before
  verification runs.
- **A write that creates its target file still lands.** Ticket 19 grades a plan `risky` when the
  target file does not exist yet, and this ticket keeps that grade, but `isGated` does not include it:
  the risk list in the ticket names *directories* (a copied directory, a new directory), and ticket
  20 deliberately seeds a missing target so the first mirror creates the file. Gating it would make
  `acm mirror` into a fresh config impossible without an MCP elicitation, which the CLI never has.
  The grade still reaches the client's own permission layer, which is what gates on it.
- **Conflicts are their own gate, ahead of containment.** A non-empty `conflicts[]` refuses with
  `onConflict: abort` (the default) and the refusal shows every pointer with both values, withheld
  ones included, so a human reads the diff without reading the file. `onConflict: replace` is the
  named ask; nothing about a refusal is remembered, so a second call refuses on the same grounds.
  Because the conflict itself is that gate, a conflicting write is not also moved into `manualSteps`
  when replacement was asked for — otherwise `replace` could never do anything on a client without
  elicitation.
- **`disposition` is new on the plan** (`mirror | alreadyPresent | alreadyShared`, plus the reason),
  because 07 §9 says the reason rides in `gaps[]` or `conflicts[]` and neither has a slot: the gap
  vocabulary is closed at five field-level reasons. A target that already holds every value the plan
  would write, and a target whose file *is* the source file, both return `writes: []`, no asserts,
  and the reason; `apply` then lands nothing and leaves the bytes alone.
- **The gap-disposition table is now the one rule.** `GAP_DISPOSITIONS` maps each of the five reasons
  to `planApplies | manualStep | notTranslatable`, `gapDisposition()` throws for a reason it has no
  rule for, and the two planner branches that owe a manual step consult it instead of encoding the
  rule themselves. Its key `shapeOnly` is quoted because the spelling is the gap vocabulary's, not a
  name this file chooses (the repo's lint bans the word "shape" in symbol names).
- **`consent` is on the result, always `client-policy` today.** A refusal carries `consent: null`,
  because a refusal authorises nothing. The `elicitation` member of `ConsentBasis` is declared but
  produced nowhere yet: only a client can render that dialog, and the engine must not send
  `elicitation/create` unless the client declared the capability, so that path belongs to the MCP
  surface (ticket 25). No flag, environment variable, or stored approval reaches it.
