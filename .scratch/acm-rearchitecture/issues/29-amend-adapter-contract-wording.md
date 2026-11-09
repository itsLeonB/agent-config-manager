# 29: Amend the adapter contract to the shape that shipped

**What to build:** the settled record stops describing an adapter contract the code does not have. Spec §3's `CapabilityRow` / `expressible` / `credentialPointers` / `translate()` sketch is replaced by the shape tickets 16–25 landed — `claimedCategories` + read handlers + per-category write surfaces, with the MCP allowlist beside its transforms, the credential pointers beside the classifier's rule table, structural read/write verdicts, and translation owned by the planner. The wayfinder map's entry for the same ticket carries a one-line amendment pointing at it, so a reader who lands there first is not sent hunting.

Doc only. No code, no test, no schema changes.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Spec §3 no longer names a type, field, or function that does not exist in the code, and keeps every decision the old shape carried (no version surface, `method: file` everywhere, the closed five gap reasons, the three dispositions, read pure over bytes).
- [x] The map's ticket-02 entry records the amendment and points at spec §3, so the two documents agree with each other and with the code.
