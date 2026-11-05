# Prototype — minimal MCP tool surface + worked mirror trace

Throwaway artifact for [ticket 09](../issues/09-mcp-tool-surface.md). Not production code: the
point is that you can look at the calls below and say *too much / missing X / just right*.

Settled inputs: [07 mirror operation and plan](../issues/07-mirror-operation-and-plan.md),
[08 permission and approval model](../issues/08-permission-and-approval-model.md).

Tags: `[settled]` = forced by an earlier ticket, `[open]` = this ticket's decision.

---

## 1. The surface — five tools

`[open]` The minimal set. Everything else BRIEF §4.2 lists is a deferral (§3).

| # | Tool | Input | Output |
|---|---|---|---|
| 1 | `list_installations` | `{ category?, harness?, scope?, fresh? }` | `{ scannedAt, fresh, harnesses[], installations[] }` |
| 2 | `inspect_installation` | `{ installationId }` | `{ installation, knownFields, nativeLocations[], bindings[], provenance }` |
| 3 | `plan_mirror` | `{ installationId, target: { harness, tierId } }` | `{ plan }` — the whole plan document |
| 4 | `apply_plan` | `{ plan, onConflict? }` | `{ status, landed[], manualSteps[], consent, verification }` |
| 5 | `verify_plan` | `{ plan }` | `{ outcome, asserts[] }` |

### Why each earns its place

1. **`list_installations`** — the agent cannot name a source it cannot see. Folds BRIEF's
   `scan_environment` + `list_harnesses` + `list_components` into one read: the harness rows
   (version, tiers, tier writability, trust) come back alongside the installation rows because a
   plan target must be a *writable existing tier*, and that is a property of the harness row.
   `fresh: false` means "this is the last stored scan"; `fresh: true` forces a re-scan. [open]
2. **`inspect_installation`** — `plan_mirror` needs a source id, but a human-readable decision
   ("is this the right server? what does it actually point at?") needs the fields. Separate tool
   so the listing stays cheap.
3. **`plan_mirror`** — `[settled]` writes nothing, reads the source, returns the plan doc.
4. **`apply_plan`** — `[settled]` takes the plan document back (no plan store), never re-derives.
5. **`verify_plan`** — the only tool that exists *because* plans are stateless. After `apply`
   returns `unverified` with pending `manualSteps[]` (a human ran `opencode mcp auth serena`),
   the plan's `verify.asserts[]` are still the thing to check, and nothing else can re-check them
   without writing. **This is the one to cut if five is one too many** — cutting it costs the
   manual-step re-check, nothing else.

### Two shapes the earlier tickets force into the tool layer

- **No plan id anywhere.** `plan_mirror` returns a document; `apply_plan` and `verify_plan` take
  that document back. The agent carries it. `[settled by 07 §4]`
- **The grade is inside the plan.** `security.grade: "safe" | "risky"` on the plan document, so
  the caller learns *before* `apply` whether a human dialog will appear. `[open: this is an
  addition to 07's plan schema — 08 defines the grading, not where it surfaces]`

### Verified-reality note

`apply_plan` on a client **without** elicitation (Pi 1.5.0) does not fail: `risky` writes alone
return in `manualSteps[]`, safe writes land, `consent: "client-policy"`. `[settled by 08 §1]`
The tool signature is identical on all three clients — the difference is in the result.

---

## 2. Worked trace

Two traces, because the machine in front of us has both cases. Real files, real values, read
2026-11-05.

### Trace A — happy path: `node_repl` Codex → OpenCode user tier

Source: `~/.codex/config.toml` `[mcp_servers.node_repl]`. Target:
`~/.config/opencode/opencode.json`, user tier. No existing OpenCode entry.

**1.**
```jsonc
// list_installations
{ "category": "mcp", "harness": "codex" }
```
```jsonc
// → 200 OK
{ "scannedAt": "2026-11-05T09:14:02Z", "fresh": true,
  "harnesses": [
    { "harness": "codex", "version": "0.166.0",
      "tiers": [{ "id": "user", "scope": "user", "writable": true, "trust": "n/a" },
                { "id": "project", "scope": "project", "writable": true, "trust": "untrusted" }] } ],
  "installations": [
    { "installationId": "mcp:node_repl|codex|user", "category": "mcp", "name": "node_repl",
      "scope": "user", "nativeLocation": "~/.codex/config.toml",
      "bindings": [{ "harness": "codex", "tierId": "user" }] },
    { "installationId": "mcp:serena|codex|user", ... } ] }
```

**2.**
```jsonc
// inspect_installation
{ "installationId": "mcp:node_repl|codex|user" }
```
```jsonc
// →
{ "knownFields": {
    "command": "…/cua_node/bin/node_repl",
    "env": { "BROWSER_USE_AVAILABLE_BACKENDS": "chrome,iab,mcpapps", "CODEX_CLI_PATH": "…" },
    "env_vars": ["BROWSER_USE_ACCESS_EXECUTOR_ID", "BROWSER_USE_ACCESS_PIPE_PATH", "…"],
    "startup_timeout_sec": 120.0 },
  "security": { "secrets": [{ "pointer": "env_vars.0", "verdict": "clean" }] },
  "provenance": null }
```

**3.**
```jsonc
// plan_mirror
{ "installationId": "mcp:node_repl|codex|user", "target": { "harness": "opencode", "tierId": "user" } }
```
```jsonc
// → the plan document, abridged
{ "planId": "sha256:6f1c…", "kind": "mirror",
  "source": { "harness": "codex", "tierId": "user", "nativeLocation": "~/.codex/config.toml",
              "contentDigest": "sha256:a91…" },
  "target": { "harness": "opencode", "tierId": "user", "scope": "user",
              "nativeLocation": "~/.config/opencode/opencode.json" },

  "equivalence": {
    "carried":  ["command"],
    "mapped":   [{ "field": "args", "targetField": "command[]",
                   "transform": "prepend command to args; OpenCode takes one command array" },
                 { "field": "env", "targetField": "environment" }],
    "gaps":     [{ "field": "env_vars", "reason": "unexpressible",
                   "replacement": "expand to explicit environment entries by hand" },
                 { "field": "startup_timeout_sec", "reason": "unexpressible" }],
    "preserved": [] },

  "security": { "grade": "safe", "secrets": [], "executables": [] },
  "conflicts": [],
  "writes": [
    { "op": "writeAtPointer", "file": "~/.config/opencode/opencode.json",
      "pointer": "mcp.servers.node_repl",
      "value": { "type": "local", "command": ["…/node_repl"], "environment": { … } },
      "precondition": { "exists": true, "digest": "sha256:c07…" },
      "reversible": true, "priorValue": null,
      "executable": false, "secretValues": false, "irreversible": false } ],

  "manualSteps": [
    { "step": "OpenCode has no startup-timeout equivalent for node_repl; expect a slow first start.",
      "why": "gap: startup_timeout_sec" } ],
  "verify": { "asserts": [{ "file": "~/.config/opencode/opencode.json",
                            "pointer": "mcp.servers.node_repl.command",
                            "equals": ["…/node_repl"] }] } }
```

**4.**
```jsonc
// apply_plan — grade is "safe", so no dialog is shown on any client
{ "plan": { …the document above… } }
```
```jsonc
// →
{ "status": "applied",
  "consent": "client-policy",
  "landed": [{ "file": "~/.config/opencode/opencode.json",
               "pointer": "mcp.servers.node_repl", "resultDigest": "sha256:3be…" }],
  "manualSteps": [{ "step": "OpenCode has no startup-timeout equivalent…", "why": "gap: …" }],
  "verification": "unverified" }
```

**5.** Human shrugs at the missing timeout. Done. `verify_plan` would re-assert the same and still
return `unverified` — the manual note never clears.

### Trace B — the real machine: `serena` already exists, V1 shape

Source: `~/.codex/config.toml` `[mcp_servers.serena]` — `command = "serena"`,
`args = ["start-mcp-server", "--context=codex", "--project-from-cwd"]`.

Target: `~/.config/opencode/opencode.json` **already has** `mcp.serena` — legacy V1 flat shape,
`{ type: "local", command: [...--context, ide, ...], enabled: true, timeout: 30000 }`.

`plan_mirror` returns `grade: "risky"`, `conflicts: [{pointer: "mcp.serena",
current: {...V1 shape, --context ide...}, proposed: {...V2 shape, mcp.servers.serena, --context codex...},
why: "differs"}]`, `writes[]` populated. First `apply_plan` with no `onConflict`:

```jsonc
{ "status": "refused", "reason": "conflict", "conflicts": [ …same… ] }
```

Called again with `{ "onConflict": "replace" }` on **Codex** (has elicitation): one dialog,
`planId` + the conflict row + both values, tick → applied.

Called the same way on **Pi** (no elicitation): the write returns as a `manualStep` naming the
target file and pointer, `writes: []` landed, `consent: "client-policy"`. The agent cannot overwrite
a conflicting entry from Pi. `[settled by 08 §1]`

**Why this trace is worth reading twice:** the target's own shape (V1 flat vs V2 `mcp.servers`) is
not a *field* gap — it is a shape the adapter has to normalise on both read and write. Ticket 05
flags that legacy shape is normalised in memory, so what the engine writes and what the harness
reports back can differ. Whether that belongs in `equivalence.mapped[]` or is invisible plumbing is
`[open]`.

---

## 3. BRIEF §4.2 groups — in, out, deferred

| Group | Tools | This slice | Why |
|---|---|---|---|
| Discovery | `scan_environment`, `list_harnesses` | **folded** into `list_installations` | two tools that both return "what exists" |
| Inventory | `list_components`, `inspect_installation` | **in** (renamed `list_installations`) | the source id comes from here |
| Planning | `create_installation_plan` | **in**, narrowed to `plan_mirror` | the slice has exactly one plan kind; creating from nothing needs recipes |
| Execution | `apply_plan` | **in** | |
| Execution | `rollback_operation` | **out** | 07 §2: rollback described, never executed; map rules the lifecycle out |
| Verification | `verify_installation` | **in**, narrowed to `verify_plan` | no store, so verification is always *of a plan document* |
| Comparison | `compare_scopes`, `detect_drift` | **deferred** | drift *detection* as a lifecycle (map, out of scope). Reading current config before a write is `precondition` |
| Research | `research_installation`, `get_recipe` | **deferred** | BRIEF Phase 5; the slice has no recipe engine |

Five tools total. The bar a sixth must clear: **it must be impossible to express with the plan
document the agent already carries.**

---

## 4. What to react to

1. Five is right, or is it four (cut `verify_plan`) / six?
2. Is `fresh?` the right answer to "how current is this inventory" (ticket 10 q4), or should the
   mirror always read live config at plan time?
3. Is the trace concrete enough to judge the slice, or does the surface need a runnable stub
   before you trust it?
