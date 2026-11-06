# 16: Engine skeleton and Pi MCP inventory

Type: task
**Status:** resolved

Read `spec.md` beside this ticket first: it holds every settled decision, and this ticket is the first
slice of it.

**What to build:** an installed `acm` executable whose `acm list` reports the MCP servers Pi actually
has configured. The command reads Pi's native config, records each server in the canonical tables,
and prints rows from the store — so running it twice shows the same installations, editing a field
shows a changed digest rather than a new row, and deleting a server entry leaves a tombstone instead
of losing history. This is the whole spine in one slice: schema, adapter read, store, service, CLI,
and a test that drives it against a fixture home.

**Blocked by:** None (can start immediately).

- [x] `acm list` prints installations with category, name, tier, scope, native location, and content digest, read from the store rather than re-parsed at print time
- [x] the schema migration is idempotent: a fresh database and an existing one reach the same schema, and the dashboard's snapshot rows and the settings rows are untouched
- [x] re-running discovery upserts the same rows instead of duplicating them, and a hand edit updates the digest on the same row
- [x] a server removed from the config disappears from default listings while its row survives with a removal stamp
- [x] engine paths (home, project root, store file) are injected rather than read from the process working directory, so a fixture home is the only environment a test needs
- [x] a test drives discovery and listing end to end against a fixture home and a temporary database

## Answer

Landed as `src/engine/` (config, adapters + registry, repo, service), `src/cli/main.ts` as the
`acm` bin, and migration 1 in `src/server/store.cjs`. `src/engine/engine.test.ts` drives discovery
and listing against a fixture home, a fixture project, and a temporary database, and spawns the CLI
against the same fixture.

Choices worth knowing beyond the ticket:

- The digest covers the adapter-known fields of one entry, so an edit to a field the adapter does
  not name is not drift (`shortcut:` in `pi/read.ts`).
- `known_fields` holds `[withheld]` for `env` / `headers` values and strips `url` userinfo, because
  those are Pi's MCP credential pointers; `auth` never becomes a fact. Ticket 18 replaces the
  placeholder with a verdict.
- `acm list` runs discovery before reading, which is what this ticket asked for; the service's
  `listInstallations` still reads the stored snapshot, and scan time comes from `tier_health` so a
  filter that matches nothing still reports when the last pass ran.

