# Capability-gap semantics: block, degrade, or ask

Labels: wayfinder:grilling
Type: grilling
Status: open
Blocked by: 02

## Question

All three researches are in, and the gap is concrete: the harnesses disagree on what even exists.

- **Hooks.** Codex: declarative `hooks.json` / `[hooks]`, 14 events, additive merge
  ([Codex native configuration surface](./04-codex-config-surface.md)). Pi and OpenCode: no hook
  config at all — hooks are code inside an extension / `Plugin.define`
  ([Pi](./03-pi-config-surface.md), [OpenCode](./05-opencode-config-surface.md)).
- **MCP fields.** Pi has `exposure`/`toolExposure` that no other harness has; Codex has
  `startup_timeout_sec`, `enabled`; OpenCode has `disabled` (inverted) and legacy V1 shapes.
- **Scopes.** Pi 2 tiers, Codex 3 (`profile` is launch-time only), OpenCode 4 including a
  root-owned `/etc/opencode` that outranks the project.
- **Merge semantics.** Pi's MCP project entry replaces; Codex's merges per field; OpenCode's
  replaces whole entries. A field-preserving write needs a different technique per harness.

Decide, per component category and per field class:

1. When the target harness cannot express the source configuration, does the mirror **block**
   (refuse the plan), **degrade** (write the closest equivalent and report the gap), or **ask**
   (surface the choice to the caller)? What decides which of the three? Is the choice a policy on
   the adapter, the plan, or the caller?
2. What exactly must a degraded plan report so the caller can judge it — a gap list on the
   component, a per-field diff, or a distinct plan status? (The vocabulary is settled in
   [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md).)
3. Hooks specifically: when the target harness has no hook config (**Pi, OpenCode**), is that
   `unsupported`, or is generating extension / plugin source a permitted mirror output? Code is
   executable — does that cross the "explicit authorization" line differently from a config write?
4. Credentials: Codex can carry an MCP OAuth `client_secret` inside `config.toml`. Confirm the
   rule (never copy, strip on read, or refuse the plan) and where it is enforced.
5. Does a scope mismatch (source scope not present in target, e.g. `profile`, or `/etc/opencode`)
   count as a capability gap under the same rules, or is it a separate error class?

**Zoom:** `BRIEF.md` §8.2 (adapter may report unsupported / partial / requiring manual
intervention), §10, §18. Inputs: all three config-surface findings. Related:
[Canonical domain model](./01-canonical-domain-model.md), [Mirror operation and plan](./07-mirror-operation-and-plan.md).

**Output:** the gap vocabulary and the block/degrade/ask rule in the handoff spec.
