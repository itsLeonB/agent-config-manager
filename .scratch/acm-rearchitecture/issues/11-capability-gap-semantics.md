# Capability-gap semantics: block, degrade, or ask

Labels: wayfinder:grilling
Type: grilling
Status: resolved
Blocked by: 02

## Question

All three researches are in, and the gap is concrete: the harnesses disagree on what even exists.

- **Hooks.** Codex: declarative `hooks.json` / `[hooks]`, 14 events, additive merge
  ([Codex native configuration surface](./04-codex-config-surface.md)). Pi and OpenCode: no hook
  config at all — hooks are code inside an extension / `Plugin.define`
  ([Pi](./03-pi-config-surface.md), [OpenCode](./05-opencode-config-surface.md)).
- **MCP fields.** Pi has `exposure`/`toolExposure` that no other harness has; Codex has
  `startup_timeout_sec`, `enabled`; OpenCode has `disabled` (inverted) and legacy V1 shapes.
- **Scopes.** Pi 2 tiers, Codex 3 (`profile` is launch-time only), OpenCode 4 including a
  root-owned `/etc/opencode` that outranks the project.
- **Merge semantics.** Pi's MCP project entry replaces; Codex's merges per field; OpenCode's
  replaces whole entries. A field-preserving write needs a different technique per harness.

Decide, per component category and per field class:

1. When the target harness cannot express the source configuration, does the mirror **block**
   (refuse the plan), **degrade** (write the closest equivalent and report the gap), or **ask**
   (surface the choice to the caller)? What decides which of the three? Is the choice a policy on
   the adapter, the plan, or the caller?
2. What exactly must a degraded plan report so the caller can judge it — a gap list on the
   component, a per-field diff, or a distinct plan status? (The vocabulary is settled in
   [Harness adapter contract and capability model](./02-adapter-contract-and-capabilities.md).)
3. Hooks specifically: when the target harness has no hook config (**Pi, OpenCode**), is that
   `unsupported`, or is generating extension / plugin source a permitted mirror output? Code is
   executable — does that cross the "explicit authorization" line differently from a config write?
4. ~~Credentials: Codex can carry an MCP OAuth `client_secret` inside `config.toml`. Confirm the
   rule (never copy, strip on read, or refuse the plan) and where it is enforced.~~ Answered by
   [Permission, approval, and safety model](./08-permission-and-approval-model.md) §6–7 (classifier
   gate + three-way consent; OAuth grant never mirrored) and
   [Secret detection rules](./13-secret-detection-rules.md) (the rule table). Not this ticket's.
5. Does a scope mismatch (source scope not present in target, e.g. `profile`, or `/etc/opencode`)
   count as a capability gap under the same rules, or is it a separate error class? (08 §5 already
   rules out elevated tiers as *unwritable*; this question is about the gap vocabulary for them.)

**Zoom:** `BRIEF.md` §8.2 (adapter may report unsupported / partial / requiring manual
intervention), §10, §18. Inputs: all three config-surface findings. Related:
[Canonical domain model](./01-canonical-domain-model.md), [Mirror operation and plan](./07-mirror-operation-and-plan.md).

**Output:** the gap vocabulary and the block/degrade/ask rule in the handoff spec.

## Answer

Settled with the dev over three grilling rounds on 2026-11-05. Round 3 answered only after
checking whether a real off-the-shelf hooks bridge exists (it does, for Pi, and not for OpenCode);
that fact, not a preference, decided the hooks rule.

### 1. One rule: degrade, never block. The three words are three different mechanisms

- **degrade** is the planner's default and the only per-*field* outcome. A gap never refuses a
  plan. `writes[]` carries everything the target can take, `equivalence.gaps[]` carries the rest.
- **block** exists at *category* granularity only: `translate()` returns `kind:'notTranslatable'`,
  the plan comes back with `writes: []` and one gap with `reason: categoryAbsent`. It is still a
  plan, not an error channel (07 §9).
- **ask** is not a planner mode at all. It is 08's graded consent: every plan with a gap, a
  conflict, or an `executable` write already passes an elicitation, and a client without
  elicitation gets those writes back as `manualSteps[]`. A planner branch that asks the same
  question a second time would be dead code.

Rejected: **block on any gap** (Codex `startup_timeout_sec` would refuse an otherwise correct MCP
mirror) and **an `onGap: 'degrade'|'abort'` caller knob** (the agent passes the default every time;
BRIEF §18's "safe by default" is served by enumeration plus consent, not by a flag).

Degrading is safe here because nothing disappears silently: every gap is enumerated with a reason
and a replacement, the human approves the plan *with the gap list* in the dialog (08 §3), and
verification asserts only `carried ∪ mapped`, so no gap is ever claimed to have survived (07 §7).

### 2. `gaps[].reason` — closed enum of five

| `reason` | Means | Disposition |
|---|---|---|
| `fieldAbsent` | target has no equivalent field (Codex `startup_timeout_sec` → OpenCode) | gap; plan still applies |
| `shapeOnly` | field exists only in a legacy / alternate shape (OpenCode V1 flat `mcp.<name>`, Codex `.env` sub-table) | gap; plan still applies |
| `credential` | value is a secret, never emitted (08 §6) | gap **and** a `manualSteps[]` entry, always |
| `executable` | value runs at harness runtime and the target cannot express it | gap **and** an `executable` tick (08 §8) |
| `categoryAbsent` | the whole category has no declarative surface in the target | `notTranslatable`; `writes: []` |

A sixth reason is a schema change, not a new string. Tests assert every reason maps to one of the
three dispositions, so an adapter cannot invent a gap the planner has no rule for — the same
fail-closed logic as `expressible` (02 §2). No `tierUnavailable` reason: scope mismatch is not a
gap (§6).

### 3. The rule lives in the engine, once

Not on the adapter (02 already forbids it: adapters report facts, never severity), not on the plan
(the plan carries dispositions, it does not decide them), not on the caller (§1). One policy
table, one module, testable against the five reasons.

### 4. A degraded plan reports no new status

The ticket asked "gap list, per-field diff, or distinct plan status". Answer: the first two, never
the third. `equivalence` *is* both — `carried[] | mapped[] | gaps[] | preserved[]` is the field
partition, each gap carries `{field, reason, replacement}`, and each write carries its target
pointer, so the diff is derivable from the document. Status stays where 07 §7 put it:
`verified | unverified | failed`, on the *result*, and any plan with a pending `manualSteps[]`
lands `unverified`. Nothing here adds a field to the plan.

### 5. Hooks — three-way, decided per target, by whether a real bridge exists

Facts checked 2026-11-05:

- **Pi** has a documented package that turns hooks back into declarative config: `@vahor/pi-hooks`
  (`pi install npm:@vahor/pi-hooks`), read from `~/.pi/agent/hooks.json` and `.pi/hooks.json`,
  merged recursively, shape `{"hooks": {"<event>": [cmd | {command, print}]}}`. Listed on
  `pi.dev/packages`.
- **OpenCode** has only hobby bridges — `opencode-claude-hooks` (37 weekly downloads),
  `opencode-hooks-plugin` (7), `@gabrielassisxyz/opencode-hooks` — none canonical, none with
  adoption evidence.
- **Codex** has native `hooks.json` / `[hooks]` (04 headline 2): always data, always in scope.

So "a popular method exists" is the test, and it is a fact about the ecosystem, not a licence:

| Target | `translate()` | `writes[]` | `manualSteps[]` |
|---|---|---|---|
| **Codex** | `translatable` | `hooks.json` / `[hooks]` pointer writes | enable `[features] hooks` if off; `/hooks` trust review (trust is keyed on content hash + positional index, 04 §5) |
| **Pi** | `translatable` | `writeAtPointer` into `hooks.json`, user or project tier | install/ensure `npm:@vahor/pi-hooks`, then restart Pi |
| **OpenCode** | `notTranslatable`, `categoryAbsent` | — | author a `Plugin.define` hook; a community bridge is named as the human's own choice, never as a supported path |

Installing the bridge is a **step of the hook mirror**, not a separate effort — the same
write-then-human shape 07 §5 established for Codex project MCP, and it is what makes the Pi write
honest: the file lands now, is inert until the package exists, and the plan says so. The engine
does not check for the package, does not depend on its file layout surviving an upgrade, and does
not add it to `writePaths` semantics beyond the declared pointer.

Boundary: **plugins stay out** (07 §1, executable install). This rule is narrow on purpose — a
community package being installable is not enough; it must be the category's documented path for
that harness, which today is exactly one case.

### 6. Scope mismatch — neither a gap nor a plan

Two things that look alike and are not:

- **The target cannot exist.** Codex `profile` is launch-time only and `/etc/opencode` is elevated
  (08 §5), so neither can be named as a `tierId`. That is caller-input validation *before*
  `plan_mirror` runs — the caller must name an existing writable tier (09 already assumes it). No
  plan, no gap.
- **The scope behaviour cannot be reproduced.** A root policy outranking a correct project write,
  or a value that only a launch profile gives you. The write itself is fine; the *effect* is
  blocked by a layer this slice cannot touch (04 §1, 05 §5). That is a `manualSteps[]` entry naming
  the shadowing layer — not a gap, because nothing is unexpressible, and not a conflict, because
  nothing on disk disagrees.

Hence five gap reasons, not six.

### 7. A hook command string is executable content (amends 08 §8)

Any write landing a hook handler that carries a shell command is flagged `executable: true`, needs
its own tick, and can never land `verified`. 08 §8 already treats Pi's `!command` header as code
because it runs at harness runtime; a command in `hooks.json` is the same thing wearing a config
field. Non-command handlers (Codex `mcp_tool`) stay unflagged data.

Consequence on a Pi MCP client (no elicitation, 08 §3): the hooks write returns as a `manualStep`,
and since such a plan could never verify anyway, the only difference is who types the file.

### Amendments to settled tickets

- **02** — `Gap.reason` is this five-value enum. `translate()`'s arms are unchanged.
- **07** — `equivalence.gaps[]` carries those five reasons; no plan field is added, no status
  changes.
- **08 §8** — the `executable` flag covers hook command strings, not only `!command` headers and
  script files.
- **09** — `plan_mirror` gains no `onGap` parameter.
- **12** — gains a hooks table (event-name mapping per target); its blanket "hooks and plugins are
  `manual`" exclusion was written against 07's premise and is now half wrong.

