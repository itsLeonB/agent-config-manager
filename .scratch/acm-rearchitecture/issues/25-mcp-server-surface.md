# 25: MCP server over the same five operations

Type: task
**Status:** ready-for-agent

**What to build:** `acm mcp serve` speaking the protocol over standard input and output, exposing the
five settled tools with the same signatures on every client. An agent can list, inspect, plan, apply a
plan document it is carrying, and verify it again later. Tool annotations tell a client which calls
are read-only and which are destructive. Consent is requested through the client's own dialog only
when the client declared that capability; otherwise the graded-consent fallback decides. A smoke test
spawns the built binary the way a harness would.

**Blocked by:** 22.

- [ ] a client that initialises and lists tools sees exactly the five settled tools, with the agreed inputs and outputs
- [ ] the read-only tools declare themselves read-only and the apply tool declares itself destructive
- [ ] a whole plan document round-trips from plan to apply to verify without any stored plan record
- [ ] consent is requested only when the client declared the capability, and a client without it receives risky writes as manual steps
- [ ] the server answers over standard input and output with no working-directory assumption
- [ ] a smoke test spawns the built binary, initialises, lists tools, plans one mirror, applies it, and observes the target change

