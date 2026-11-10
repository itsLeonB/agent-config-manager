# Wayfinder map — Project scoping

Labels: wayfinder:map

## Destination

An `acm` installed and registered once reads the project the harness in front of it was opened in,
and says so — instead of reading the project `acm` was installed in. Splits out of
[acm-rearchitecture](../acm-rearchitecture/map.md): those decisions are settled, and this effort
carries only what the first slice got wrong about which project it is looking at.

## Notes

- **Vocabulary:** [CONTEXT.md](../../CONTEXT.md) — **project root** is a working directory, not a
  store location and not a tier. The store stays anchored where `acm` is installed and shared.
- **Authority:** [ADR 0006](../../docs/adr/0006-project-root-is-the-working-directory.md) records the
  decision, the three alternatives, and the two costs accepted.
- **Tracker:** local markdown — `.scratch/acm-project-scoping/`; first open, unblocked, unclaimed
  ticket by number wins.

## Decisions so far

- [Narrow tombstones to declared reads](issues/01-narrow-tombstones-to-declared-reads.md): a discovery
  pass in one project tombstoned every other project's live rows for the same tier, so flipping the
  default first would have deleted the project left behind. A tombstone now reaches only a row whose
  own native file sits under a location that tier declared it reads, matched by path segment, and
  only a tier that parsed cleanly may tombstone at all.
- [The project is the working directory, for both faces](issues/02-project-root-from-working-directory.md):
  `resolveProjectRoot()` in `src/engine/config.ts` is the one statement of the chain —
  `ACM_PROJECT_ROOT ?? CLAUDE_PROJECT_DIR ?? process.cwd()`, canonicalised — reached identically by
  the CLI and by the server a harness spawns, with `--project-root` writing the override instead of
  reaching the rule by another path. Scoping is a service filter over `nativeFile` containment, not a
  store one, and `Inventory` carries `projectRoot` so an unexpected root is visible. [ADR 0006](../../docs/adr/0006-project-root-is-the-working-directory.md).
- [Record the decision and the vocabulary](issues/03-record-the-decision-and-vocabulary.md): the
  reasoning is written where the next reader looks, because the code this replaces said the opposite
  on purpose — ADR 0006 against the working directory exactly, a walk-up to a repository marker, a
  per-call argument, and the incumbent module-location rule; **project root** in `CONTEXT.md` kept
  apart from store location and tier; and `AGENTS.md` now says which of the two paths follows the
  caller and which follows the install.
