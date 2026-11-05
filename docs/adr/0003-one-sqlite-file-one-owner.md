# Keep one SQLite file and one owner; canonical tables sit beside the legacy snapshot read model

ACM's canonical tables (`installations`, `bindings`, `operations`, `tier_health`) land in the same
`database/dashboard.db` that the retired Claude dashboard already reads, schema-owned by
`src/server/store.cjs` — still the only module that touches `node:sqlite` — which gains a
`PRAGMA user_version` migration runner. A second store module, or a second database file, would buy
file-level isolation at the cost of two owners of one schema, and the dashboard's `snapshots` /
`config` API has to keep working untouched as the slice's only web consumer.

## Considered Options

- **Extend `store.cjs`** (chosen): one sqlite owner, one migration runner, dashboard API unchanged.
- **A second `engine-store.cjs` on the same file.** Cleaner file split, but two modules owning one
  schema's `user_version` is the classic way a migration runner corrupts itself.
- **A second database file.** Clean isolation, but cross-file ids lose integrity, and BRIEF §8.3's
  "shared local data store" becomes two stores with two backup stories.
- **A normalised `components` table** (rejected for this slice): `category`, `name`, and `aliases`
  inline is enough until something queries a Component across installations, which nothing does yet.

## Consequences

- **No `plans` table.** A plan is stateless and content-addressed (ticket 09), so the store keeps
  only `plan_id` — an opaque hash — on the target installation's provenance and on the operation
  row. Re-verifying after a pending manual step means the agent still holds the plan document; the
  store cannot reconstruct it, and does not try.
- The legacy `snapshots` / `config` API, and the Claude-only rows already inside it, stay exactly as
  they are: written by `scan.cjs`, read by `dashboard.server.ts`, migrated by nobody, deleted by
  nobody. §8.3's "the engine is the only writer" is therefore scoped to the canonical tables —
  settings and snapshots were already written outside it, and retrofitting them is not this slice.
- Absence is not evidence. Discovery reports `ok | unreadable` per `(harness, tier)`, and only an
  `ok` tier may tombstone what it no longer sees, because OpenCode drops an invalid config with exit
  0 and empty stderr and has no strictness flag. That verdict is stored (`tier_health`) so
  `list_installations` can surface it, and it is the only thing standing between one malformed
  `opencode.json` and a fully tombstoned inventory.
