# Audit the existing codebase for reusable inventory

Labels: wayfinder:task
Type: task
Status: open
Blocked by: none

## Question

Produce a concrete inventory of what in this repo can be reused for the slice and what is
Claude-only and must be left behind — no decisions here, just facts a later decision is
blocked on.

Read `scan.cjs`, `src/server/store.cjs`, `src/types/dashboard.ts`, the dashboard components
(especially `src/components/dashboard/ProjectsCompare.tsx`), `src/server/origin-guard.ts`,
the settings server/functions, and `src/lib/install-script.ts`. For each: what it does,
whether it is harness-agnostic, and what would have to change.

Answer explicitly:

1. With Claude skipped (charting Q4), is **any** existing discovery logic reusable as an
   adapter, or is all three-adapter discovery greenfield?
2. What happens to the existing Claude-only scan snapshots and `cloud.json` ingestion in
   `store.cjs` — kept, ignored, or migrated?
3. Which pieces are genuinely harness-agnostic and carry over as-is (SQLite store, secret
   redaction, origin guard, TanStack shell)?

**Zoom:** `AGENTS.md` architecture section, `BRIEF.md` §14. Unblocks: [Storage and migration decision](./10-storage-and-migration.md).

**Output:** a markdown inventory file, linked as an asset from this ticket.
