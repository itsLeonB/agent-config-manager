# 07: Cloud snapshot ingestion

**What to build:** The cloud-side inventory keeps arriving exactly the way it does today — the
agent-driven refresh command writes a file into the data directory. The scanner notices that the
file changed and stores a cloud snapshot, so the Cloud section reflects the refresh on the next
tick with no extra step from the operator and no change to the refresh instructions. An
unchanged file produces no new snapshot, and a file already present at container start is
ingested immediately so a restart does not blank the Cloud section.

**Blocked by:** 04

**Status:** resolved

- [x] After the refresh command writes its file, the Cloud section updates within one scan interval with no other action
- [x] An unchanged file produces no duplicate snapshot
- [x] A cloud file present at container start is ingested immediately, so the Cloud section is populated on first load
- [x] The refresh command's instructions are unchanged; no new operator step
- [x] A malformed cloud file is ignored and leaves the previous cloud snapshot in place

## Comments

Resolved on `feat/dokploy-sqlite-dashboard`. `createCloudSync` in `scan.cjs` ingests `cloud.json` on mtime change plus content difference; malformed file ignored.
