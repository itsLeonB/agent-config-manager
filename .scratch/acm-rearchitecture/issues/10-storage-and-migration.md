# Storage and migration decision

Labels: wayfinder:grilling
Type: grilling
Status: resolved
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

## Answer

Agreed with the dev over three grilling rounds on 2026-11-05. The schema decision is recorded as
[ADR 0003](../../../docs/adr/0003-one-sqlite-file-one-owner.md); this is the detail behind it.

### 1. One store, extended — not a second module

`src/server/store.cjs` keeps its exclusive claim on `node:sqlite` and gains a migration runner:
`PRAGMA user_version` gates an ordered array of migration steps. An existing `dashboard.db` reads
`user_version = 0`, and migration 1 is pure `CREATE TABLE IF NOT EXISTS`, so both a fresh clone and
a populated database land in the same place with nothing destructive.

The `snapshots` / `config` API is untouched, byte for byte, so `dashboard.server.ts`,
`settings.server.ts`, and `scan.cjs` need no edits. The engine's callers do not touch sqlite: they
import `src/engine/service.ts` (see §6).

### 2. Canonical tables

Migration 1 adds four tables. `installations` is the inventory; `bindings` is the per-harness half
from ticket 01; `operations` is the apply audit; `tier_health` is what the health gate writes.

```sql
CREATE TABLE installations (
  id                TEXT PRIMARY KEY,   -- sha256 of the identity tuple below
  category          TEXT NOT NULL,
  name              TEXT NOT NULL,
  aliases           TEXT NOT NULL,      -- JSON array
  scope             TEXT NOT NULL,      -- user | project | project-local | system
  native_file       TEXT NOT NULL,
  native_pointer    TEXT,
  content_digest    TEXT,
  known_fields      TEXT NOT NULL,      -- JSON; adapter-understood fields only, never a file copy
  mirrored_from_id  TEXT REFERENCES installations(id),
  mirrored_plan_id  TEXT,
  mirrored_at       TEXT,
  mirrored_tool_version TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  removed_at        TEXT                -- tombstone, never a DELETE
);
CREATE UNIQUE INDEX installations_identity
  ON installations(category, name, scope, native_file, native_pointer);

CREATE TABLE bindings (
  installation_id     TEXT NOT NULL REFERENCES installations(id),
  harness             TEXT NOT NULL,
  tier_id             TEXT NOT NULL,
  method              TEXT NOT NULL,
  version             TEXT,
  verification_status TEXT NOT NULL,   -- unverified | verified | failed | notApplicable
  PRIMARY KEY (installation_id, harness, tier_id)
);

CREATE TABLE operations (
  id                     TEXT PRIMARY KEY,
  at                     TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  plan_id                TEXT NOT NULL,
  grade                  TEXT NOT NULL,   -- safe | risky
  outcome                TEXT NOT NULL,   -- applied | partial | refused | stale
  source_installation_id TEXT,
  target_installation_id TEXT,
  landed_writes          TEXT NOT NULL    -- JSON, the landed[] array from ticket 08
);

CREATE TABLE tier_health (
  harness  TEXT NOT NULL,
  tier_id  TEXT NOT NULL,
  status   TEXT NOT NULL,     -- ok | unreadable
  detail   TEXT,
  at       TEXT NOT NULL,
  PRIMARY KEY (harness, tier_id)
);
```

`id` is a hash of the identity tuple rather than an autoincrement, so re-discovery upserts the same
row and `plan_mirror` can name a source installation across processes without a lookup. Aliases,
`known_fields`, and `landed_writes` are JSON columns: none of them is queried field-wise in this
slice.

**No `plans` table, no `components` table, no `verifications` table.** A plan is stateless and
content-addressed (ticket 09), so only its hash persists; `(category, name, aliases)` inline is all
the Component key this slice queries; and a verification result is the binding's latest status,
written back on apply — history belongs to the lifecycle slice, which is out of scope.

### 3. Existing Claude data and stale rows: read nothing, delete nothing

The dashboard (out of scope to change) is fed by `kind = 'local'` snapshots written by `scan.cjs`.
Migrating or deleting them would break the only consumer of the database, so they stay, unread by
the engine and untouched by the migration. Any leftover `kind = 'cloud'` rows from before
[ADR 0002](../../../docs/adr/0002-no-cloud-config-management.md) stay too: no code reads them, no
code deletes them, and `store.d.cts` already types `kind` as `'local'` only. Deleting user data for
cosmetics is not worth a migration step; the ADR records the choice so it is not re-litigated.

### 4. Freshness: the store is the inventory

Ticket 09 settled what a *tool call* does about freshness (stored snapshot, `fresh: true` forces a
re-scan, `plan_mirror` and `apply` re-read digests themselves). This ticket settles what discovery
*deposits*: rows. Each discovery pass upserts `installations` + `bindings`, stamps `last_seen_at`,
and writes `content_digest`, so a hand-edited target is drift on the same row rather than a new one
(ticket 01). An Installation absent from an `ok` tier's result gets `removed_at` set; nothing is
deleted, so `mirrored_from_id` never dangles.

`fresh: true` on `list_installations` runs discovery first, then reads rows — the same path as the
interval loop, so there is one code path for "inventory" and no separate live-query mode.

### 5. The dashboard keeps working, unchanged

No file under `src/routes/`, `src/components/`, or `src/types/` changes. `dashboard.server.ts`
keeps calling `readLatestSnapshot('local')`; `settings.server.ts` keeps using `config`. The engine
adds tables and never touches either one's rows. A future read-only dashboard for canonical
inventory is a new route, not an edit to these.

### 6. The service boundary is a module, not a process

`src/engine/service.ts` exposes the tool-shaped functions — `list_installations`,
`inspect_installation`, `plan_mirror`, `apply_plan`, `verify_plan` — plus `discover()`. It is now an
in-process implementation over `src/engine/repo.ts` (which calls `store.cjs`) and the adapter
registry. The MCP server imports `service.ts` and nothing below it. When BRIEF §8.4's daemon is
needed, only `service.ts` changes shape; no caller does. No IPC, no socket, no locking in this
slice — and `origin-guard.ts` stays where it is, since an MCP stdio client sends no `Origin`
(ticket 06); consent for mutations is ticket 08's graded model, inside the engine.

### 7. The health gate, and what OpenCode will not tell us

Asked directly whether OpenCode can be made to fail on invalid config: **no.** Probed on 2.2.5 —
`debug config`, `mcp list`, `plugin list`, and `models` all exit 0 with empty stderr against both a
malformed JSON document and a type-invalid field; `--log-level` and all 40 `OPENCODE_*` env vars in
the binary offer no strictness switch.

The verdict is still retrievable:

```sh
OPENCODE_CONFIG=<file> opencode debug config --standalone --print-logs --log-level warn
```

stderr carries one parseable line per problem, each naming its own file:

```
level=WARN message="configuration normalization diagnostic" source=/path/opencode.json path=$ kind=invalid action="rejected malformed JSON or JSONC document"
level=WARN message="configuration normalization diagnostic" source=/path/opencode.json path=$.mcp kind=invalid action="skipped malformed recognized value"
```

`path=$` is an unreadable document, `path=$.x.y` a dropped field inside a readable one, and
`source=` maps each diagnostic back to a tier — so **one probe per cwd reports every tier at once**.
Without `--standalone --print-logs` nothing reaches stderr (the diagnostics come from the private
server's log), which is why the bare `debug config` looks clean.

Gate order, cheapest first: local JSONC parse fails ⇒ tier `unreadable`, no spawn; parse succeeds ⇒
probe; any `kind=invalid` naming that source ⇒ `unreadable`; spawn failure ⇒ `unreadable`. An
`unreadable` tier tombstones nothing. Probe cost is one short-lived process per discovery pass, and
it is read-only, so ticket 07's "verification never probes the harness" rule (about write
verification) is untouched.

**Amendment to [ticket 02](./02-adapter-contract-and-capabilities.md):** the adapter contract gains
`health() → per-tier ok | unreadable`, with the probe command as an optional descriptor field for
harnesses that need one. Same shape of amendment ticket 07 made to `translate()`. Its answer stays
closed; the amendment goes into the handoff spec beside that one.
