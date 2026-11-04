# Harness adapter contract and capability model

Labels: wayfinder:grilling
Type: grilling
Status: open
Blocked by: none

## Question

`BRIEF.md` §7–8.2 says each adapter describes identification/version detection, supported
component categories, supported scopes, native config paths, discovery/parsing, install/remove,
config merge/preservation, verification, and compatibility limitations; an adapter "must not
claim support for a feature that the harness itself does not support" and may report an
operation as **unsupported / partially supported / requiring manual intervention**.

Decide the exact contract for the three adapters (Pi, Codex, OpenCode):

1. What does an adapter *declare* — a capability matrix, per-operation support, or both?
2. How are "unsupported / partial / manual" represented to the engine so the mirror planner can
   react deterministically?
3. How do native paths and formats stay visible and traceable through the model?
4. How does version detection work, and what happens when a harness version is unrecognised?
5. Is the contract one shared TypeScript interface, or a capability descriptor plus
   per-category handlers?

**Zoom:** `BRIEF.md` §7, §8.2. Inputs: [Pi native configuration surface](./03-pi-config-surface.md), [Codex native configuration surface](./04-codex-config-surface.md), [OpenCode native configuration surface](./05-opencode-config-surface.md). Related: [Canonical domain model for mirroring](./01-canonical-domain-model.md).

**Output:** the contract shape and capability vocabulary in the handoff spec.
