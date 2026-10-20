# 04: Snapshots in SQLite

**What to build:** Snapshots move into a database, without changing what the dashboard shows.
One module owns all database access and exposes a small surface: store a snapshot of a given
kind, read the newest one, read and write config, read and write comments, open by file path.
Nothing else in the app touches the database API. The scanner writes each snapshot to the
database while the existing file output continues, and the dashboard renders from the newest
stored snapshot, so the change can be verified against unchanged visible output before anything
is removed. The database engine is built into the runtime, so no dependency and no native build
step is added.

This is the expand step of an expand–contract sequence; ticket 08 removes the old form.

**Blocked by:** 01

**Status:** resolved

- [x] One module owns every database access; no other module imports the database API directly
- [x] A completed scan stores a snapshot and the previous file output still happens
- [x] The dashboard renders from the newest stored snapshot with byte-for-byte equivalent output
- [x] Newest-wins per snapshot kind is proven against a temporary database file
- [x] A read issued while a write is in flight returns either the old or the new snapshot, never a corrupt one
- [x] No new runtime dependency, no build step for the database engine

## Comments

Resolved on `feat/dokploy-sqlite-dashboard`. `src/server/store.cjs` is the only `node:sqlite` importer; snapshots blobs, `latest` = highest id. Verified under Bun and Node.
