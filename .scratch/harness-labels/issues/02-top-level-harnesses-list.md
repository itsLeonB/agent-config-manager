# 02: Top-level `harnesses` list

**What to build:** An environment file may declare `harnesses = [ ... ]` at the top level. The parser accepts and returns it; the loader merges lists across tiers as a union in precedence order and exposes them on `Environment`; the service exposes `listHarnesses()` (defaulting to `pi`, `codex`, `opencode` when none declared) and adds the list to `Status`. End-to-end: `acm` reflects the harnesses an environment declares rather than a hardcoded set.

**Blocked by:** 01 (free-form harness labels in the environment layer)

**Status:** resolved

- [x] Parser accepts top-level `harnesses` key (string array) without refusing
- [x] `ParseResult` carries the declared harness list
- [x] Loader merges lists across tiers as a union in precedence order, deduplicated
- [x] `Environment` exposes the merged list
- [x] Service exposes `listHarnesses()` with the default fallback
- [x] `Status` carries the merged list
## Answer

Implemented on main working tree. See diff.
