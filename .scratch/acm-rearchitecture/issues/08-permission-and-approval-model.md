# Permission, approval, and safety model for MCP mutations

Labels: wayfinder:grilling
Type: grilling
Status: resolved
Blocked by: 07

## Question

`BRIEF.md` §4.2 and §9.4 require: no unrestricted shell execution; separation of planning from
execution; explicit authorization for mutations unless a deliberate automation policy grants
it; filesystem and command-execution restrictions; preserving unknown fields; never copying
credentials automatically; treating hooks and plugins as executable code; permissions enforced
by the core engine rather than relying on the agent to behave.

Decide the concrete model for this slice:

1. Where approval is enforced (core engine boundary), and what exactly the agent must present
   and the human/agent must approve.
2. How an approved plan is **bound** so it cannot be swapped or altered between approval and
   apply.
3. Which filesystem paths and command allowlists apply to Pi / Codex / OpenCode config.
4. How credentials and secrets are redacted and excluded from mirrored config.
5. How hooks and plugins are gated as executable code.
6. Whether the slice supports a noninteractive automation policy at all (recommended: no).

**Zoom:** `BRIEF.md` §4.2, §9.4, §10, §18. Builds on: [The mirror operation and its plan representation](./07-mirror-operation-and-plan.md). Unblocks: [Minimal MCP tool surface and a worked mirror example](./09-mcp-tool-surface.md).

**Output:** the safety model and enforcement points in the handoff spec, plus an ADR (hard to reverse, security-critical, the result of a real trade-off).

## Answer

Settled with the dev over five grilling rounds on 2026-07-23. §1–§3 were revised in round 5:
round 1's elicitation-or-refuse is replaced by **graded consent**, so a client without elicitation
(Pi) can still `apply`. Decision record: an ADR is required (security-critical, hard to reverse).
This answer fixes the *gates*; the concrete detection rulebook is
[Secret detection rules and secret-free-by-design guidance](./13-secret-detection-rules.md).

### 1. The trust boundary — consent is graded, and the engine decides the grade

Engine and agent run as the same OS user on the same machine, so **no channel the engine controls
can distinguish a human's consent from an agent's assertion**: an approval token, a state file, a
`confirm: true` argument, or a `--yes` flag are all writable by the agent. Only **MCP
elicitation** escapes that, because the *client* renders the dialog. Verified capability
(2026-07-23): **Codex 0.166** and **OpenCode 2.2.5** implement `elicitation/create` (form + URL).
**Pi 1.5.0 does not**, and Pi's docs state it "does not ask for approval before every tool call".

The engine therefore **grades every plan** and only the risky grade needs a human answer:

| Grade | When | On apply |
|---|---|---|
| `safe` | every write is `writeAtPointer` / `writeFile` into a **pre-existing** target file, inside the declared `writePaths`, with no risk flag (§6–8), no conflict, no credential path | applies on **any** client; consent recorded as `"client-policy"` |
| `risky` | any write flagged `executable`, `secretValues`, or `irreversible`; any `copyFile`; any new directory; any conflict; any elevation | needs **elicitation**; on a client without it, the risky writes alone return as `manualSteps[]` and the safe remainder still applies |

The invariant, in one line: **the engine never mutates on an assertion, and what it will do
without a human answer is bounded by the grade.** `client-policy` means the harness's own
permission configuration is the authorization — the same authorization every other tool that
client offers runs on. It is never something ACM asserts for itself.

Two costs, stated because they are real:

- A `safe` write can still break a config file if the classifier is wrong about "safe." The
  mitigation is structural — preconditions, `preserved[]`, pointer-level merge — not consent.
- The engine **cannot verify** that a Pi user configured a permission rule. `safe` plans apply
  even when none exists. Deliberate: an unconfigured client degrades to "can write config
  files," never to "can write code, carry secrets, or overwrite conflicts."

Defense in depth: `apply` declares `readOnlyHint: false` + `destructiveHint: true`, and `plan`
declares `readOnlyHint: true`, so any client's own permission layer can gate on top of the grade.
The engine must only ever send `elicitation/create` when the client declared the capability in
its `initialize` — sending it blind is a spec violation, not a fallback.

### 2. The four gates

| # | Gate | Enforced where | Refuses when |
|---|---|---|---|
| 1 | **Plan is read-only** | `plan` handler | Nothing is refused; `plan` writes no bytes and mutates no state |
| 2 | **Graded consent** | `apply` handler, before any filesystem access | The plan is `risky` and the client has no elicitation capability (risky writes move to `manualSteps`) or the human declines |
| 3 | **Precondition + containment** | `apply` handler, before the first byte | Any write is stale, out-of-allowlist, symlinked, non-regular, elevated, or targets a credential location |
| 4 | **Acknowledgement of risk flags** | The elicitation form itself | A write flagged `executable` / `secretValues` / `irreversible` was not ticked |

Gate order matters: the human is never asked to approve a plan the engine would refuse anyway,
and no file is opened for write before gates 2–4 pass.

### 3. Gate 2 — what the human sees on a `risky` plan

A `safe` plan shows no dialog: it returns the plan, the `landed[]` set and
`consent: "client-policy"`. For a `risky` plan, one elicitation per `apply` call, covering the
whole plan, plus a **separate tick** for every write carrying a risk flag. The form shows, and
only shows:

- `planId`, `target {harness, tierId, scope, nativeLocation}`, `createdAt`.
- Every write as `op · file · pointer` — never a file's whole contents.
- `equivalence.carried[] / mapped[] / gaps[]` counts, with `gaps[]` reasons spelled out.
- `manualSteps[]` verbatim.
- Risk rows, each with its own checkbox: `executable`, `secretValues`, `irreversible`.
- A free-text `declineReason`, so a refusal can say what to change.

Approval binds to **`planId`**, and is **per-call and stateless**: nothing is stored. The
recheck at apply time is ticket 07's pair — recomputed `planId`, plus each write's
`precondition: { exists, digest }`. An approval carrying plan A cannot apply plan B, and a plan
whose files changed after the human read it refuses as `stale` and re-plans. The audit trail is
the *target* installation's `provenance.planId` (ticket 01), not an approval table; whether that
warrants a row in the store is [Storage and migration decision](./10-storage-and-migration.md)'s call.

### 4. Gate 3 — preflight, then write, and report what landed

`apply` preflights **every** write — precondition digest, path containment (§5), pointer
resolvability, write-path writability, `copyFile` source existence — before touching disk. Then
it writes sequentially. A write that fails mid-plan **stops the run** and returns
`status: "partial"` with `landed[]` (writes that succeeded, with their resulting digest) and
`failed` (the write, and why). No rollback execution: ticket 07 settled that rollback is
described, never performed.

One in-flight `apply` per store. A concurrent call returns `status: "busy"` — same guard the
existing rescan server function uses for a second scan.

### 5. Gate 3 — path containment

Every `(category, tier)` declares its **writePaths**: an exact file for `writeAtPointer` /
`writeFile`, a directory for `copyFile`. Per write the engine checks, in order:

1. Path is inside the adapter's declared `writePaths` for that `(category, tier)` — no
   wildcards, no `..`, no template output that resolves elsewhere.
2. `realpath` of the deepest existing ancestor equals the lexical path (no symlink in any
   component); the target, if it exists, must be a **regular file** — not a symlink, fifo,
   device, or socket.
3. The resolved path is under `$HOME` or the project root.
4. The path is not a **credential location**, refused even when an adapter asks for it:
   `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, and each harness's own auth store —
   `~/.pi/agent/auth.json`, `~/.pi/agent/mcp-auth.json`, `~/.codex/auth.json`,
   `~/.local/share/opencode/auth.json`.
5. `copyFile` never sets setuid/setgid; the slice creates no directory outside a declared path,
   no symlink, and never deletes.

Scope: **user and project tiers may both be written.** Elevated / root-owned tiers (OpenCode
`/etc/opencode`, MDM/`policies`) are not representable as writable — a plan targeting them is
refused, not turned into a sudo line for the human to paste.

`plan` runs the same checks and reports the result, so a doomed plan never reaches a human.

### 6. Gate 4 — secrets: classify in-engine, never emit

A **deterministic classifier** runs inside the engine over the source file's bytes, before any
value is projected into `knownFields`, the plan document, a tool result, an elicitation form, or
a log line. It combines provider patterns (`sk-`, `ghp_`, `AKIA`, `xoxb-`, PEM blocks, JWT
shape), key-name patterns (`*_KEY`, `*_TOKEN`, `*SECRET`, `PASSWORD`, `CREDENTIAL`), the
adapter's declared `credentialPointers`, and an entropy threshold. It emits a verdict per
pointer — `clean | suspect | secret` — never a severity.

The engine can prove no byte is *emitted*, not that none is *read*: classification needs the
bytes. So the invariant is **"nothing secret leaves the process"**, and it is enforced by
construction rather than by care:

- A `clean` pointer is projected normally.
- A `suspect` or `secret` pointer **stops the plan** for that line and offers three responses,
  in this order of preference:
  1. **Migrate the secret out of config** — the plan returns a `gaps[]` entry with
     `reason: "credential"` and a `manualSteps[]` entry naming the injection mechanism the target
     harness supports (`${ENV_VAR}` reference, `!command` retrieval, OAuth, keychain). Re-plan
     afterwards. This is the recommended answer and the one the docs push.
  2. **Blind copy** — the engine reads the source pointer and writes the target pointer itself;
     the value never leaves the process, and the plan carries `sha256` of the value, not the
     value. `apply` re-reads the source at write time, so the plan document stays value-free.
  3. **Risk-read** — the human ticks `secretValues` in the elicitation, acknowledging that the
     value will enter the plan and therefore the agent's context. Off by default; per write.
- The classifier's verdicts are recomputed at apply time. A source that grew a secret between
  plan and apply fails preflight as `stale`.
- `~/.codex/config.toml` is the one case where a real credential can be legitimate config —
  `mcp_servers.<id>.oauth.client_secret`. It is `secret`, so it can never be carried by default;
  see §7.

### 7. OAuth — mirror the entry, never the grant

The server definition is data and mirrors: `url` / `command` / `args` / `env` / `headers`, and
non-secret OAuth policy (`oauth.clientRegistration: auto|dcr|cimd` in Pi). The **grant** never
mirrors — Pi keeps tokens in `~/.pi/agent/mcp-auth.json`, OpenCode outside its served tables,
Codex unverified but outside `config.toml` for tokens. Each target harness therefore gets a
`manualSteps[]` entry naming its own login: `pi mcp login <name>`, `codex mcp login <name>`,
`opencode mcp auth <name>`. Codex's `oauth.client_secret` is treated as a `secret` pointer under
§6 — `manualStep`, never a write.

### 8. Executable content

A write is flagged **`executable: true`** when it lands a `scripts/` directory, a plugin
directory, a file whose mode or shebang makes it runnable, or a value containing Pi's `!command`
form (`"Authorization": "!echo Bearer $(gh auth token)"`) — that runs a command at harness
runtime and is code, not data. Every `executable` write needs its own tick in the elicitation, and
a plan containing one can never land `verified` — it lands `unverified` regardless of §4's
`landed[]`, because the engine does not launch the code it wrote.

`${ENV_VAR}` references are not executable and not secret: they are the *preferred* form, and the
migrate path in §6 recommends them.

### 9. Command execution — empty allowlist

The `runCommand` op stays in the vocabulary (ticket 07) but **no adapter declares one and the
engine refuses all of them**. Every action in the slice is a file write. A command template must
be argued for in a later ticket; until then "no unrestricted shell execution" is satisfied by
construction, not by an audit.

### 10. Prohibited in this slice

No automation policy, no blanket approval, no `--yes`, no env var that skips a gate, no "approve
for the session", no standing consent for a path or an adapter. Consent for a `risky` write is
always one human's answer to one plan, in that plan's own dialog. `safe` plans are the single
delegation, and their authorization is the harness's own permission configuration — never a flag
ACM accepts.

### 11. Amendments to settled tickets

- **Ticket 07** — `writes[]` gains `executable: boolean`, `secretValues: boolean`,
  `irreversible: boolean`; the plan gains `security: { secrets: [{pointer, verdict}],
  executables: [{file, why}] }`. Its worked example changes: `env` is no longer plain `carried`
  — a clean `env` value carries, a `suspect`/`secret` one takes §6's three-way path. `apply`'s
  result set grows `declined`, `partial`, `busy`, plus `consent: "elicitation" | "client-policy"`;
  plans gain `grade: "safe" | "risky"` and each write gains `grade` alongside its risk flags.
- **Ticket 02** — the adapter descriptor gains `credentialPointers: string[]` and per-tier
  `writePaths` as classifier/containment inputs. Both are checked for agreement at load like the
  rest of the descriptor.
- **Ticket 11** — its credential question is answered here (§6, §7); Q4 is trimmed to a pointer.
