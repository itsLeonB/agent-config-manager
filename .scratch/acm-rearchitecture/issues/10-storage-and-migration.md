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

## Comments

**2026-11-05 — claude.ai cloud config is already gone; two premises in the question are stale.**

`fcfbf2c` deleted the whole cloud surface — the `/refresh-cloud` scrape, the `cloud.json` drop
file, `createCloudSync` / `isCloudData`, the `CloudData` type, the cloud snapshot rows, and the
per-item comments that only existed to annotate a missing counterpart. Reason, alternatives and
consequences: [ADR 0002](../../../docs/adr/0002-no-cloud-config-management.md). The inventory
asset is updated to match: [06-codebase-inventory.md](../assets/06-codebase-inventory.md).

What that changes for this ticket:

- **q3's cloud half is closed, not a decision.** There is no ingestion left to keep or drop; the
  slice inherits no `cloud.json` path. Only the Claude-only *snapshot data* half of q3 is still
  live: does the new schema read, ignore, or delete the existing `kind = 'local'` rows?
- **q1's table list is now two tables, not three.** `comments` (`writeComment` / `readComments` /
  `src/lib/comments.ts`) was deleted with the cloud UI, since every comment input rendered into a
  "missing on the other side" cell. `store.cjs` is 60 lines holding `snapshots` + `config`.
- **New fact for q3:** `store.cjs` contains no `DELETE` of any kind. An existing `dashboard.db`
  therefore keeps any old `kind = 'cloud'` rows permanently — unread, undeleted, and invisible to
  `store.d.cts` (whose `kind` is now pinned to `'local'`). A fresh clone never creates them. If
  "what happens to stale rows" is a decision worth making, it belongs here, not in the ADR.

The grilling for this ticket can skip the ingestion question entirely.
