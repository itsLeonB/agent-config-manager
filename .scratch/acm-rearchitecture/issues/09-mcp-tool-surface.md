# Minimal MCP tool surface and a worked mirror example

Labels: wayfinder:prototype
Type: prototype
Status: resolved
Blocked by: 07, 08

## Question

Make the destination tangible enough to judge whether the slice is coherent and minimal.
Produce a cheap, rough artifact to react to — **not production code**:

1. The smallest MCP tool surface an agent needs to perform a mirror: tool names, inputs,
   outputs.
2. One worked example trace: an agent discovers an MCP server in Codex, gets a mirror plan for
   OpenCode, presents it for approval, applies it, and verifies.
3. Which brief tool groups (`BRIEF.md` §4.2 — Discovery, Inventory, Comparison, Research,
   Planning, Execution, Verification) are truly needed for the slice and which are deferred.

Decide the minimal tool list; the value of the prototype is that the human can look at a
concrete trace and say "too much / missing X / just right".

**Zoom:** `BRIEF.md` §4.2, §12 Workflow C. Builds on: [The mirror operation and its plan representation](./07-mirror-operation-and-plan.md), [Permission, approval, and safety model for MCP mutations](./08-permission-and-approval-model.md).

**Output:** a linked prototype asset (outline/stub) plus the agreed minimal tool list in the handoff spec.

## Answer

Resolved with the dev on 2026-11-05 after reviewing the prototype asset. Fidelity was accepted as
sufficient — no runnable stub.

Prototype (rough, throwaway): [Minimal MCP tool surface + worked mirror trace](../assets/09-mcp-tool-surface.md)

### 1. The tool list — five tools, and no sixth

| Tool | Decides |
|---|---|
| `list_installations(category?, harness?, scope?, fresh?)` | what exists, which tiers are writable, whether the read is fresh |
| `inspect_installation(installationId)` | what the source actually says, secret-free |
| `plan_mirror(installationId, target{harness, tierId})` | the whole plan document, including `security.grade` |
| `apply_plan(plan, onConflict?)` | landed / manual / verification outcome |
| `verify_plan(plan)` | re-asserts a plan's `verify.asserts[]` after a manual step |

- **`list_installations` folds BRIEF's discovery and inventory groups.** Harness rows (version,
  tiers, tier writability, trust) ride along with installation rows, because a plan target must be
  a writable existing tier and that is a property of the harness row. `scan_environment`,
  `list_harnesses`, and `list_components` do not get their own tools.
- **`plan_mirror` replaces `create_installation_plan`.** The slice has exactly one plan kind.
- **`verify_plan` replaces `verify_installation`** and is the only tool that exists *because*
  plans are stateless: after `apply` returns `unverified` with pending `manualSteps[]`, nothing else
  can re-check the same asserts without writing. Cutting it costs the manual-step re-check and
  nothing else — kept.
- **No plan id anywhere.** `plan_mirror` returns a document; `apply_plan` and `verify_plan` take the
  document back. The agent carries it (07 §4).
- **The grade is on the plan document** (`security.grade: safe|risky`), so the caller learns before
  `apply` whether a dialog will appear. This is an addition to 07's plan schema: 08 defines the
  grading, not where it surfaces.
- **Tool signatures are identical on all three clients.** The elicitation difference shows up in the
  *result* (`consent: "client-policy"`, risky writes moved to `manualSteps[]` on Pi), never in the
  surface. A sixth tool must clear this bar: it cannot be expressed with the plan document the agent
  already carries.

### 2. Inventory freshness — snapshot by default, `fresh: true` to re-scan

Folded into ticket 10's q4. A default read returns the last stored scan with `fresh: false` and its
`scannedAt`; `fresh: true` forces a re-scan before answering. Staleness can never reach a write
regardless, because `plan_mirror` re-reads the source file for its `contentDigest` and `apply`
re-reads every target for its `precondition.digest` (07 §4).

### 3. BRIEF §4.2 groups for the slice

| Group | Verdict |
|---|---|
| Discovery, Inventory | **in**, folded into two tools |
| Planning, Execution, Verification | **in**, narrowed to mirror / apply / verify-of-a-plan |
| `rollback_operation` | **out** — 07: rollback described, never executed |
| Comparison (`compare_scopes`, `detect_drift`) | **deferred** — drift *detection* as a lifecycle is out of scope; reading current config before a write is `precondition` |
| Research (`research_installation`, `get_recipe`) | **deferred** — BRIEF Phase 5 |

### 4. Carried into ticket 12

Trace B surfaced a shape question that is not a field gap: OpenCode's legacy V1 flat
`mcp.<name>` + `enabled` is normalised in memory, so the engine writes V2 `mcp.servers.<name>` +
`disabled` while the file on disk may still hold the old shape. Whether that normalisation is
`equivalence.mapped[]` or invisible plumbing belongs to
[Per-category canonical field tables](./12-per-category-field-tables.md), which also owns the
`codex command + args → opencode command[]` mapping.
