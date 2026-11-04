# The mirror operation and its plan representation

Labels: wayfinder:grilling
Type: grilling
Status: open
Blocked by: 01, 02

## Question

Define *mirror* as a first-class engine operation (charting Q3) and the shape of its plan.
Decide:

1. The operation vocabulary for a mirror plan — reuse `BRIEF.md` §10 (create dir, copy file or
   directory, symlink, write file, merge config, install package, run approved command, remove
   managed file, manual action, restart/reload). Which does this slice actually need?
2. What every plan must describe (target installation, intended changes, prerequisites,
   expected resulting state, required permissions, potential conflicts, verification steps,
   rollback feasibility — `BRIEF.md` §10).
3. How "equivalent" is expressed when config must be **translated** rather than copied, and how
   an adapter's unsupported/partial/manual verdict appears in the plan.
4. How a plan is validated before execution, and its serialization (JSON).
5. Whether plan → apply → verify are three distinct MCP-visible steps.

Stress-test: mirroring an MCP server from Codex to OpenCode where a field is unknown to the
target. Sharpen "equivalent" into a precise canonical term.

**Zoom:** `BRIEF.md` §9.4, §10. Builds on: [Canonical domain model for mirroring](./01-canonical-domain-model.md), [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md). Unblocks: [Permission, approval, and safety model for MCP mutations](./08-permission-and-approval-model.md), [Minimal MCP tool surface and a worked mirror example](./09-mcp-tool-surface.md).

**Output:** the mirror operation + plan schema in the handoff spec.
