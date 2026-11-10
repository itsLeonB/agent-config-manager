# 05: Run history

**What to build:** after a run, the machine's history is answerable: which Provision was installed, for which harness, at which tier, with which command, what it exited with, and whether it was there afterwards. Command output is deliberately not kept, so a command that prints a token does not put it in a database.

**Blocked by:** 04

**Status:** resolved

- [x] Each executed command records its time, Provision, harness, tier, command text, exit code, and Presence afterwards.
- [x] No command output — stdout or stderr — is stored anywhere.
- [x] A Provision that was skipped because it was already `present` records nothing, because no run happened.
- [x] A migration adds the table and issues no change to the dashboard's tables.
- [x] An interrupted run keeps the records of the commands that had already finished.
- [x] `acm status --json` includes the most recent run for each Provision and harness.

## Comments

Implemented in `fb06d87` on the integration branch `feat/agents-environ`; the two-axis
code review of that branch is recorded in the merge commit for the review fixes.
