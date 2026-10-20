# 08: Retire the JSON store

**What to build:** The database becomes the only store. The scanner writes only the database and
no longer produces a local snapshot file, the JSON config files stop influencing behaviour
because settings come from the database, and any leftover JSON files are removed from the data
directory. The empty-install experience is rewritten for the database case so a fresh machine
never sees instructions to run a command that is no longer the source of truth. Documentation
covers how to run it, how to back up (copy one file), and how to reset.

This is the contract step of the expand–contract sequence started in ticket 04.

**Blocked by:** 05, 06, 07

**Status:** resolved

- [x] A scan writes only the database; no local snapshot file is produced
- [x] The JSON config files no longer affect behaviour — settings are read from the database only
- [x] Leftover JSON files are gone from the data directory, and the empty-state message no longer points at the scanner command
- [x] A fresh empty start still yields a working dashboard with a message that describes the database case
- [x] Docs cover running it, backing up (copy the file), and resetting; the scanner's own tests still pass

## Comments

Resolved on `feat/dokploy-sqlite-dashboard`. Local JSON snapshot and both JSON config files retired; existing data seeded into `dashboard.db` then the files deleted; empty state rewritten.
