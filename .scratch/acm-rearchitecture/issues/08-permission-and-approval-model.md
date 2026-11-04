# Permission, approval, and safety model for MCP mutations

Labels: wayfinder:grilling
Type: grilling
Status: open
Blocked by: 07

## Question

`BRIEF.md` §4.2 and §9.4 require: no unrestricted shell execution; separation of planning from
execution; explicit authorization for mutations unless a deliberate automation policy grants
it; filesystem and command-execution restrictions; preserving unknown fields; never copying
credentials automatically; treating hooks and plugins as executable code; permissions enforced
by the core engine rather than relying on the agent to behave.

Decide the concrete model for this slice:

1. Where approval is enforced (core engine boundary), and what exactly the agent must present
   and the human/agent must approve.
2. How an approved plan is **bound** so it cannot be swapped or altered between approval and
   apply.
3. Which filesystem paths and command allowlists apply to Pi / Codex / OpenCode config.
4. How credentials and secrets are redacted and excluded from mirrored config.
5. How hooks and plugins are gated as executable code.
6. Whether the slice supports a noninteractive automation policy at all (recommended: no).

**Zoom:** `BRIEF.md` §4.2, §9.4, §10, §18. Builds on: [The mirror operation and its plan representation](./07-mirror-operation-and-plan.md). Unblocks: [Minimal MCP tool surface and a worked mirror example](./09-mcp-tool-surface.md).

**Output:** the safety model and enforcement points in the handoff spec, plus an ADR (hard to reverse, security-critical, the result of a real trade-off).
