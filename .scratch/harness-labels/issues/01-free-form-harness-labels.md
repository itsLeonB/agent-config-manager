# 01: Free-form harness labels in the environment layer

**What to build:** The environment layer (types, parser, service) treats a harness name as an unconstrained string. An environment file naming any harness — including one ACM has no native reader for — loads without refusal, and its entry appears in status like any other. The native-read layer keeps its closed `HarnessId` set and `acm read <harness>` still rejects unknown names.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `DeclaredEntry`, `ResolvedProvision`, `HarnessPresence`, and `Run` use `string` for `harness`
- [ ] `StatusFilter.harness` uses `string`
- [ ] Parser accepts any non-empty, NUL-free harness name; no refusal for unknown names
- [ ] `HarnessId` import removed from the environment layer
- [ ] Native-read tests unchanged: unknown harness still refused
- [ ] Environment-layer tests updated for free-form names