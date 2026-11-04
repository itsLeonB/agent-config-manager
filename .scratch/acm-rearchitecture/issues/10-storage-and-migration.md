# Storage and migration decision

Labels: wayfinder:grilling
Type: grilling
Status: open
Blocked by: 06, 01

## Question

`BRIEF.md` §8.3 says SQLite is the shared store, the core engine is the **only** writer, and the
web UI consumes read-only views; §8.4 requires a service boundary so a local daemon can be
added later, with no daemon needed now.

Decide for this slice:

1. Do we extend `src/server/store.cjs` (which currently holds scan snapshots, the `config`
   table, and `comments`) or start a new schema/module?
2. How are canonical Component / Installation / Plan / Operation / verification records stored?
3. What happens to the existing Claude-only snapshot data and `cloud.json` ingestion, given
   Claude is skipped for the slice?
4. How fresh must the inventory be at mirror time — stored snapshot vs live re-scan per
   operation? (Drift detection as a lifecycle is out of scope, but reading current config before
   a write is not.)
5. How does the existing dashboard keep working unchanged as a read-only consumer?
6. Where is the service boundary that lets a daemon be introduced later without a rewrite?

**Zoom:** `BRIEF.md` §8.3, §8.4; `AGENTS.md` architecture. Builds on: [Audit the existing codebase for reusable inventory](./06-audit-existing-code.md), [Canonical domain model for mirroring](./01-canonical-domain-model.md).

**Output:** the storage/migration decision in the handoff spec, plus an ADR if the schema choice is hard to reverse.
