# 18: Secrets never leave the process

Type: task
**Status:** resolved

**What to build:** inspecting one installation shows only the fields the adapter understands, and any
credential-shaped value in it is withheld with a verdict instead of being printed. The classifier is
one ordered rule table: provider patterns, private-key blocks, hash-shaped values that must stay clean
because they are digests, key-name matches, and entropy gated by alphabet. The point is that a human
or agent reading an inspection can trust that no token arrived with it, and that digests and
environment-variable references are not reported as secrets.

**Blocked by:** 16.

- [x] `acm inspect` on an installation holding a token-shaped value withholds it and reports the verdict instead of the value
- [x] a digest-shaped value whose pointer name says hash/digest/checksum/fingerprint stays clean
- [x] an environment-variable reference is clean, and a command-retrieval value is clean but flagged executable
- [x] the classifier applies to every category the adapters read, including whole-file categories whose entire content is credential-bearing
- [x] each of the eight ordered rules has a test, including the false-positive guards (digest, UUID, public key, environment-variable name)
- [x] no tool result, plan field, or log line carries a value classified secret


## Answer

Landed as `src/engine/secret.ts` (the ordered table, pure over one value), the projection in
`adapters/mcp-facts.ts`, `inspectInstallation` in `service.ts`, and `acm inspect <id|prefix>` —
plus `secret.test.ts` (one test per rule, the false-positive guards among them) and an
engine-level test that drives the CLI against a fixture home.

Choices worth knowing beyond the ticket:

- **Rule 1 runs before rule 0.** The settled table lists the pointer check first, but the checked
  criterion — "an environment-variable reference is clean" — only holds the other way round: a
  reference is secret-free by construction, and withholding `${VAR}` at `env.*` would erase the
  one form a human is meant to read. A `!command` is clean but flagged `executable`, and a command
  that itself carries a provider token is `secret` rather than laundered by rule 1.
- **The verdict travels with the pointer it belongs to.** A withheld value is stored as
  `[withheld: secret]` / `[withheld: suspect]` in known fields, so `inspect` needs no side table and
  nothing can drift from the row it describes. A url with basic-auth userinfo becomes
  `[withheld: secret] https://host/path`: the userinfo is dropped, the address survives.
- **Rule 5 leaves long hex to rule 7**, so a digest under a credential name is judged on entropy
  rather than on its name. Verdicts are unchanged for realistic values; it is what makes rule 7
  reachable instead of dead behind rule 5.
- **No adapter declares `credentialPointers` yet.** The classifier takes the declaration as data and
  `MCP_CREDENTIAL_POINTERS` is the one canonical list (`env.*`, `headers.*`): classification runs on
  canonical facts, so per-harness native spellings (`environment.<K>`) never reach it. The `file`
  kind and `classifyWholeFile` are written and tested, but no adapter claims a whole-file category
  until tickets 23/24.
- Every leaf of the canonical vocabulary is projected explicitly in `knownFieldsForStorage`; a fact
  added to `McpFacts` without a line there is dropped rather than stored verbatim.
- **A name is not a secret.** `bearerTokenEnvVar` and the `envPassthrough` entries are
  environment-variable *names* — Codex's own secret-free form — so they stay readable; withholding
  them would erase the field a mirror has to carry. The env reference guard covers the same case for
  Pi. `classifyWholeFile` takes the file's pointer and keeps a `key = value` line's own key as the
  pointer, so the name-based rules apply inside a markdown file too.
- A url is the one value whose verdict can be partial: userinfo is dropped and the address survives
  (`[withheld: secret] https://host/path`), but a token anywhere else in it withholds the whole value.
- `spec.md` §6 carries the rule-order amendment, so the table and the code agree.
