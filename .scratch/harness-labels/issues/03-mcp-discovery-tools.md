# 03: MCP discovery tools

**What to build:** Register `list_harnesses` and `acm_instructions` in the MCP router, both going through the service (no adapter or store imports). `list_harnesses` returns the merged declared list (or the default three). `acm_instructions` returns a static guide to the environment-facing tools, the harness-as-label rule, and the Check/Install contract. End-to-end: an agent can discover available harnesses and learn how to operate ACM over MCP without out-of-band documentation.

**Blocked by:** 02 (top-level `harnesses` list)

**Status:** ready-for-agent

- [ ] `list_harnesses` MCP tool registered and returns the merged list
- [ ] `acm_instructions` MCP tool registered and returns the static guide
- [ ] Both tools route through the service only