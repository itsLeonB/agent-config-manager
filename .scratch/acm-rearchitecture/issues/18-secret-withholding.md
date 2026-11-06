# 18: Secrets never leave the process

Type: task
**Status:** ready-for-agent

**What to build:** inspecting one installation shows only the fields the adapter understands, and any
credential-shaped value in it is withheld with a verdict instead of being printed. The classifier is
one ordered rule table: provider patterns, private-key blocks, hash-shaped values that must stay clean
because they are digests, key-name matches, and entropy gated by alphabet. The point is that a human
or agent reading an inspection can trust that no token arrived with it, and that digests and
environment-variable references are not reported as secrets.

**Blocked by:** 16.

- [ ] `acm inspect` on an installation holding a token-shaped value withholds it and reports the verdict instead of the value
- [ ] a digest-shaped value whose pointer name says hash/digest/checksum/fingerprint stays clean
- [ ] an environment-variable reference is clean, and a command-retrieval value is clean but flagged executable
- [ ] the classifier applies to every category the adapters read, including whole-file categories whose entire content is credential-bearing
- [ ] each of the eight ordered rules has a test, including the false-positive guards (digest, UUID, public key, environment-variable name)
- [ ] no tool result, plan field, or log line carries a value classified secret

