# 01: Container runs the dashboard and scans itself

**What to build:** A single container image that serves the dashboard and keeps its own snapshot
current with no manual step. Started with the machine's home directory attached read-only and the
data directory attached read-write, it serves on a published port, scans once immediately at
start, then rescans on every interval. The interval resolves each tick from the stored config,
then the interval environment variable, then a 15-minute default, floored at one minute so a
zero or negative value cannot spin the scanner. Snapshot writes become atomic (write beside,
then rename) so a page read can never observe a half-written file. The scanner keeps running
inside the container with paths unchanged because the home directory is attached at its own
absolute path.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] The image builds from the repo and starts with nothing beyond the two directory attachments
- [x] The first page load after start shows real data, not the "no data, run the scanner" placeholder
- [x] A new snapshot appears automatically after one interval with no user action
- [x] Interval resolution is unit-tested: stored config wins over the environment variable, which wins over the default; zero, negative and non-numeric values fall back and are floored at one minute
- [x] A scan killed mid-write leaves the previous snapshot intact and readable
- [x] A `test` script exists and runs every suite with `node --test`; no new test dependency added

## Comments

Resolved on `feat/dokploy-sqlite-dashboard`. Dockerfile (Bun build → node:22-slim), `HOST_HOME`, same-path ro home mount, scan-at-start + per-tick interval loop, atomic snapshot write, `test` script. 21 scanner tests at the time.
