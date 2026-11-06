# 20: Apply and verify a safe plan

Type: task
**Status:** resolved

**What to build:** applying a plan actually writes the target config, verifying it re-reads the file
and confirms the asserted pointers, and the operation is recorded. Unknown sibling entries and
comments survive the write. Re-applying after the target changed returns stale and writes nothing
rather than overwriting someone's edit. A failure part way through stops the run and reports which
writes landed. Two applies at once do not interleave.

**Blocked by:** 19.

- [x] applying a safe plan changes only the addressed pointers, and unknown fields plus comments elsewhere in the file survive
- [x] verification re-reads the target and reports verified, with per-assert detail
- [x] a target edited after planning returns stale and writes nothing
- [x] a write that fails mid-plan returns partial with the landed writes and their resulting digests, and no rollback is attempted
- [x] a second concurrent apply returns busy instead of interleaving
- [x] the operation is recorded with its plan hash, grade, outcome, and landed writes, and the target binding's verification status is updated
- [x] a plan with pending manual steps lands unverified and reports those steps verbatim

## Answer

Landed as `src/engine/apply.ts` (`executePlan`, `verifyPlan`), `src/engine/edit.ts` (the pointer-level
native editor), `validatePlan` plus `readPointer` in `plan.ts`, `applyPlan` / `recordMirror` in
`service.ts`, `recordMirror` / `listOperations` in `repo.ts` and `store.cjs`, and
`acm apply <plan.json|->` / `acm verify <plan.json|->` — with `apply.test.ts` and `edit.test.ts`.

Choices worth knowing beyond the ticket:

- **A write is an address edit, not a re-serialisation.** `edit.ts` scans the JSON/JSONC text (it
  skips comments and records the span of every member) or walks the TOML lines by table, and splices
  only the addressed value. A missing address is created whole in one insertion, indented to match
  its siblings; an object that sits on one line stays on one line. A line a TOML write replaces keeps
  its trailing comment, and the comment block above the next table stays with it. A parent that is an
  inline table, or a leaf that is a table of its own, fails with a reason instead of writing a
  duplicate key.
- **Each write re-reads the document the previous one produced**, and the edited text is re-parsed
  before the file is touched: a bad insertion fails that write rather than corrupting the file.
- **A target that does not exist yet is seeded with an empty document of its format** (`{}` for JSON,
  `''` for TOML), so the first write creates the file the same way the last extends one.
- **The apply result is `applied`/`partial` on writes alone**; `verification` rides along and is
  forced to `failed` when the run stopped short — a `partial` apply cannot claim a verified target.
- **Every precondition is read before the first byte, under the lock.** A file whose digest moved (or
  that appeared/vanished) makes the whole plan `stale` and nothing is written.
- **The lock is a file beside the store** (`<store>.apply.lock`, exclusive create, holder pid
  inside). It is cross-process, because the CLI and the MCP server will both apply; a lock whose
  holder is gone (ESRCH, or unreadable) is broken instead of wedging apply forever. A live holder
  returns `busy` and writes nothing.
- **Containment is one rule: a write may only reach a path its target tier declares.** No other path
  is reachable, so a credential store or a symlinked directory is not even an option. A plan whose
  tier is unknown, is not `writable`, or belongs to another harness is refused as caller input.
- **The store work happens after the bytes land, in one transaction**: `discover()` re-runs so the
  target row exists, then `recordMirror` inserts the operation row, stamps `mirrored_plan_id` /
  `mirrored_at` / `mirrored_from_id` on that row, and sets the binding's `verification_status` to
  the verification outcome verbatim (`verified` / `unverified` / `failed`).
- **`validatePlan` pins only what apply reads** (the one op it performs, target, grade, writes,
  manual steps, asserts) and then re-hashes the whole document, so an edited `equivalence` or
  `conflicts` section is still a different plan. `applyPlan` normalises its argument through JSON
  first, so a plan built in process and one parsed from a file hash identically.
- **Verification never launches a harness**; it re-reads the files in `verify.asserts[]` through the
  same classifier the plan uses for a prior value, so a credential-shaped value found at an asserted
  pointer comes back withheld rather than printed.
