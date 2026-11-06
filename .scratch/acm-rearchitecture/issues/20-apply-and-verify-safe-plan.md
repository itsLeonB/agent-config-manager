# 20: Apply and verify a safe plan

Type: task
**Status:** ready-for-agent

**What to build:** applying a plan actually writes the target config, verifying it re-reads the file
and confirms the asserted pointers, and the operation is recorded. Unknown sibling entries and
comments survive the write. Re-applying after the target changed returns stale and writes nothing
rather than overwriting someone's edit. A failure part way through stops the run and reports which
writes landed. Two applies at once do not interleave.

**Blocked by:** 19.

- [ ] applying a safe plan changes only the addressed pointers, and unknown fields plus comments elsewhere in the file survive
- [ ] verification re-reads the target and reports verified, with per-assert detail
- [ ] a target edited after planning returns stale and writes nothing
- [ ] a write that fails mid-plan returns partial with the landed writes and their resulting digests, and no rollback is attempted
- [ ] a second concurrent apply returns busy instead of interleaving
- [ ] the operation is recorded with its plan hash, grade, outcome, and landed writes, and the target binding's verification status is updated
- [ ] a plan with pending manual steps lands unverified and reports those steps verbatim

