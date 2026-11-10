# Agent Config Manager

A local-first management layer for AI coding-agent configuration: it discovers how components are
configured in each harness natively, and mirrors one installation into another harness without
replacing the native format. This file holds the vocabulary the code and the specs must agree on.

## Entities

**Component**: the thing itself, independent of where it is configured — a skill, an MCP server,
a hook. Keyed by `(category, normalised name)`; renames are recorded as explicit aliases, never
matched fuzzily.
_Avoid_: package, resource, tool, item

**Installation**: one Component as it exists in one place on disk. Keyed by
`(category, component name, scope, native location)`. Everything that can differ per harness
(method, version, verification) hangs off its bindings, not off the Installation.
_Avoid_: install, instance, entry, record

**Binding**: one harness's claim on an Installation, carrying `harness`, `tier`, `method`,
`version`, `verification status`. Most Installations have one; a file in a shared location
(`.agents/skills/`) has several.
_Avoid_: harness list, owner

**Tier**: the harness's own configuration layer, declared by the adapter with its native label,
rank, config path, scope bucket, and writability. `profile` (Codex) and `/etc/opencode` are tiers.
_Avoid_: scope, level, layer

**Scope bucket**: the four-value cross-harness classification a tier maps to — `user`, `project`,
`project-local`, `system`. Derived from the tier, never inferred from a path.
_Avoid_: scope (when a tier is meant), level

**Project root**: the one project `acm` is currently reading — the directory the harness or shell in
front of it was opened in, taken as given and never walked up to a repository marker, because a pass
must read the layers that harness itself read. Every project-scoped location is inside it; nothing
belonging to another project is in the answer, and the answer names the root it used.
_Avoid_: store location, install root, repository root, working directory when the resolved root is
meant

**Tier health**: whether a tier's config parsed cleanly on the last discovery pass — `ok` or
`unreadable`. Only an `ok` tier may tombstone an Installation it no longer sees, and only one whose
native location the tier declared it reads; `unreadable` means the tier was left alone, so the
inventory is incomplete rather than smaller. Some harnesses report
invalid config as success (OpenCode exits 0 and drops the file), so this is measured, never assumed.
_Avoid_: error state, scan status

**Capability**: what a harness can express for a Component category at a given tier:
`supported`, `partial` (with the fields it cannot express), `unsupported`, or `manual`. Owned by
the adapter, declared for `(harness, category, tier)`, never stored on an Installation.

**Known fields**: the subset of an Installation's native configuration the adapter understands and
persists in normalised form. A value that classifies `suspect` or `secret` is persisted as a marker
carrying its verdict (`[withheld: secret]`), never as the value. Unknown fields stay in the native
file and are preserved by the writer; they are never copied into ACM's store.
_Avoid_: config state, parsed config, payload, redacted config

**Verdict**: the classifier's answer for one pointer — `clean`, `suspect`, or `secret`. Produced by one
ordered rule table over the source bytes before a value can reach known fields, a plan, a tool
result, or a log line, so a reader can trust that no credential arrived with what they are reading.
Three properties are deliberately clean: an interpolation reference (`${VAR}`, `{env:VAR}`), a
digest under a digest-shaped name, and a value drawn from an alphabet that cannot hold a key.
_Avoid_: risk level, severity, confidence, redaction

**Credential pointer**: a pointer the adapter declares credential-bearing, carrying a `kind` —
`leaf` for a value that must never be stored, `file` for a whole file whose text has to be scanned.
The three markdown categories point at whole files, which is why the kind is not a flat list.
_Avoid_: secret field, sensitive key

**Native location**: `{file, pointer}` — the config file plus the address inside it
(`~/.pi/agent/mcp.json#mcpServers.serena`, `<repo>/.codex/config.toml#mcp_servers.serena`). Part of
an Installation's identity.

**Mirror**: given a source Installation, produce a plan that creates an equivalent Installation in
another harness and tier, translating per that harness's declared capability, surfacing what could
not be carried, then applying and verifying under explicit approval.
_Avoid_: sync, copy, port, convert

**Field-equivalence**: what "equivalent" means throughout this file. A mirror is equivalent when the
source Installation's `known fields` are fully partitioned into what the target carries
(`carried[]`), what it carries under another name or polarity (`mapped[]`), what it provably cannot
(`gaps[]`), and what no adapter names (`preserved[]`), and a human approved that partition. Enumerable and assertable on disk; never a
claim that two harnesses behave the same.
_Avoid_: parity, identical, same config, lossless

**Legacy shape**: a harness's older spelling of a Component that its current format still reads beside
the new one — OpenCode accepts `mcp.<name>` next to `mcp.servers`, in the same file. Read the same
way; a mirror normalises the block into the current shape in one write, because the plan has no
removal op that could leave both behind.
_Avoid_: v1, deprecated format, old schema

**Gap**: a field or behaviour present in the source Installation that the target harness cannot
express. Recorded on the plan, never on the Installation. Each reason maps to exactly one **gap
disposition** — `planApplies`, `manualStep`, or `notTranslatable` — from one table in the engine.
_Avoid_: limitation, difference, loss

**Plan**: the reviewed, approval-gated description of one mutation (here: one mirror), including its
equivalence partition, its gaps, and the preconditions each write must still satisfy. Distinct from
execution; nothing is written before approval. A plan is **stateless and content-addressed** — its id
is the hash of its own body, so it is handed around rather than stored, and a target file that
changed since planning makes the plan apply-ineligible (`stale`) instead of silently different. The
verification result belongs to the binding, never to the plan. Its **disposition** says what became of
the target: `mirror` (write these), `alreadyPresent` (it already says this), or `alreadyShared` (it is
where the source lives), the last two with no writes and a stated reason.
_Avoid_: job, task, transaction, changeset

**Grade**: the engine's answer to whether a plan needs a human's own answer before it runs — `safe`
(no risk condition) or `risky` (at least one). Computed from one table of **risk conditions**
(`executable`, `secretValues`, `irreversible`, `copyFile`, `symlink`, `runCommand`, a target path that
does not exist yet, a conflict, an elevation), never taken from the caller and never trusted from the
document, because a document can be re-signed.
_Avoid_: severity, danger, risk level

**Consent basis**: what authorised one apply — `client-policy` (the harness's own permission
configuration) or `elicitation` (a human's answer in that client's own dialog). Recorded on every
apply result, never in advance and never reusable: there is no stored approval, no `--yes`, and no
environment variable that skips a gate.
_Avoid_: approval, confirmation, authorization token

## Rules that follow from the vocabulary

- Discovery never implies write permission. Trust and elevation are properties of a tier, not of an
  Installation.
- An Installation whose `native location` is shared by two harnesses needs no mirror between them.
- Provenance points backwards: a mirrored Installation records `mirroredFrom` (source Installation,
  plan, time, tool version). A removed source becomes a tombstone so the edge still resolves.
