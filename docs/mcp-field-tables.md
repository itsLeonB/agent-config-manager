# MCP field tables

The canonical MCP fact vocabulary, its native address in each harness, and the transforms between
them. One table per concern, one home: the planner data that mirrors these tables is
[`src/engine/adapters/mcp-write.ts`](../src/engine/adapters/mcp-write.ts) (rules and per-target
absences) over the vocabulary in
[`src/engine/adapters/mcp-facts.ts`](../src/engine/adapters/mcp-facts.ts). Change a table here and the
same change belongs in the code, and the reverse.

Two rules decide what a plan does with a field:

- **Gap**: the target provably has no home for the fact, or cannot express this value of it. Reported
  with one of the five reasons in [capability-gap semantics](../.scratch/acm-rearchitecture/issues/11-capability-gap-semantics.md).
- **Preserved**: no rule names the fact and no absence covers it. The plan writes nothing and claims
  nothing, so a fact added to the vocabulary before its rule lands is visible rather than dropped.

## Canonical vocabulary

Canonical name on the left, native address per harness. `subject` is the entry — `[mcp_servers.<id>]`,
`mcp.servers.<id>`, or `mcpServers.<id>`.

| canonical | Codex `[mcp_servers.<id>]` | OpenCode `mcp.servers.<id>` | Pi `mcpServers.<id>` |
|---|---|---|---|
| `transport` | — (inferred from `command` vs `url`) | `type: local \| remote` (required) | `type?` (inferred) |
| `command` | `command` (string) | `command[]` first element | `command` |
| `args` | `args` | `command[]` remainder | `args` |
| `cwd` | `cwd` | `cwd` | `cwd` |
| `env` | `[mcp_servers.<id>.env]` | `environment` (`{env:VAR}` references) | `env` (`${VAR}` references, `!cmd`) |
| `envPassthrough` | `env_vars` | — | `env.<K>: "${K}"` (wrapped) |
| `url` | `url` | `url` | `url` |
| `headers` | `http_headers` | `headers` | `headers` |
| `enabled` | `enabled` | `disabled` (**inverted**) | `enabled` |
| `timeoutStartup` | `startup_timeout_sec` (s) | `timeout.startup` (**ms**) | — |
| `timeoutRequest` | `tool_timeout_sec` (s) | `timeout.execution` (**ms**) | `timeout` (s) |
| `bearerTokenEnvVar` | `bearer_token_env_var` | — | `headers.Authorization: "Bearer ${T}"` (wrapped) |
| `description` | — | — | `description` |
| `exposure` / `toolExposure` | — | — | Pi-only |
| `codemode` | — | `codemode` | — |
| `approvalMode` / `disabledTools` / `required` / `supportsParallelToolCalls` | Codex-only | — | — |

Fields a harness keeps that this slice does not read, and so cannot mirror:
Codex `startup_readiness`, `enabled_tools`, `scopes`, `oauth`, `http_headers_helper`; OpenCode `pool`,
`protocol`. A rule for one of these would never match, because no adapter puts it in the vocabulary.

## Transforms

The seven transforms are a closed set. `mapped[]` on a plan names the transform, the canonical fields
it consumes, the target field, and the template where one is needed.

| transform | Meaning | Instance |
|---|---|---|
| `rename` | same value, new key | `env` → `environment`; `headers` → `http_headers` |
| `invert` | boolean flip | `enabled` ⇄ `disabled` |
| `concat` | several source fields into one target value | `command` + `args` → OpenCode `command[]` |
| `unit` | numeric rescale | `timeoutStartup` s → OpenCode ms; the reverse on read |
| `infer` | value derived from which fields are present | `type: local/remote` from `command` vs `url`; nothing in Codex or Pi |
| `extract` | a component of a formatted value, pulled into a dedicated field (`template` = regex, one capture) | Pi `headers.Authorization: "Bearer ${T}"` → Codex `bearer_token_env_var: "T"`; Pi `env.K: "${K}"` → Codex `env_vars: ["K"]` |
| `wrap` | a bare identifier becomes an interpolation reference (`template` = string with `$value`) | Codex `bearer_token_env_var: "T"` → Pi `headers.Authorization: "Bearer ${T}"`; Codex `env_vars: ["K"]` → Pi `env.K: "${K}"` |

OpenCode has no passthrough list, so a Codex `env_vars` heading for `oc:*` is a `fieldAbsent` gap, and
its `env` is read as the `{env:VAR}` reference form rather than a bare name.

`extract` and `wrap` exist because Codex does no interpolation at all: a copied `"Bearer ${T}"` or
`"${T}"` arrives in the child process as those characters, so the variable *name* has to travel
instead of the formatted string. A map that mixes a reference with a literal has no single target
form on Codex or OpenCode, and is a `shapeOnly` gap.

A literal `env` or `headers` value never reaches a plan in the first place: every harness keeps tokens
there, so the classifier withholds it and the field becomes a `credential` gap with a manual step
([secret handling](../.scratch/acm-rearchitecture/spec.md) §6).

## Expressible per (harness, tier)

Every row is `method: file`. The six writable tiers are the mirror targets; `codex:profile` is
launch-time only and `oc:system` is root-managed, so a plan refuses both as caller input.

| harness | tier | expresses | notes |
|---|---|---|---|
| Pi | `pi:user` | `transport, command, args, cwd, env, envPassthrough, url, headers, bearerTokenEnvVar, enabled, timeoutRequest, description, exposure` | `type` optional and inferred; `sse` rejected |
| Pi | `pi:project` | same | a project entry **replaces** the user entry of the same name unless it carries no `command`/`url`/`type`, so a write must carry the full entry |
| Codex | `codex:user` | `transport, command, args, cwd, env, envPassthrough, url, headers, enabled, timeoutStartup, timeoutRequest, bearerTokenEnvVar, approvalMode, disabledTools, required, supportsParallelToolCalls` | `[features]`-free; `codex mcp add` re-serializes the whole table, so it is unusable |
| Codex | `codex:project` | same | inert until `[projects."<path>"].trust_level = "trusted"` exists in the **user** config → `manualSteps[]` |
| OpenCode | `oc:user` | `transport, command, args, cwd, env, url, headers, enabled, timeoutStartup, timeoutRequest, codemode` | `disabled` is the stored form; whole-entry replace means the write must be complete; a root-managed `/etc/opencode` outranks it, and `~/.opencode` may too → `manualSteps[]` naming both |
| OpenCode | `oc:project` | same | a root-managed `/etc/opencode` outranks it → `manualSteps[]` naming the shadowing layer |

OpenCode still accepts its legacy flat `mcp.<name>` shape beside `mcp.servers`, so a file may
hold both, and OpenCode reads both. A mirror writes one shape: such a file is normalised in a single
write of the `mcp` block — every legacy entry moves under `servers` (`enabled` inverted to `disabled`,
one numeric `timeout` split across the phases), siblings are carried across whole, the reserved
block-level `mcp.timeout` stays where it is, and the plan
refuses rather than carrying a sibling whose value classifies as a credential. A name defined in
both shapes, or a legacy value that is not a table, is a refusal too, because which definition the
harness honours is unverified.

Two source fields can compete for one target key: Codex `env_vars` fills Pi's `env`, and
`bearer_token_env_var` fills Pi's `headers.Authorization`. The source's literal field wins, and the
loser is reported as `preserved` rather than written over.

## Credential pointers

Values at these addresses never enter known fields, a plan, or a log line. Each adapter declares them
as `{pointer, kind: 'leaf' | 'file'}`; a field holding one becomes a `credential` gap whose
`replacement` is always `dropped`, plus the manual step that names where the human gets it instead.

| harness | category | pointers |
|---|---|---|
| Pi | `mcp` | `env.<K>`, `headers.<H>`, `url` (basic-auth userinfo, credential-shaped query parameter), `auth`, `oauth.clientSecret` |
| Pi | `hooks`, `skills`, `instructions` | whole file (`kind: 'file'`) — `hooks` is code |
| Codex | `mcp` | `env.<K>`, `http_headers.<H>`, `oauth.client_secret`, `auth.idp.client_secret`, `url`, `http_headers_helper` (`executable`) |
| Codex | `hooks` | `hooks[].command` (`executable`) |
| Codex | `skills`, `instructions` | whole file |
| OpenCode | `mcp` | `environment.<K>`, `headers.<H>`, `oauth.client_secret`, `url` |
| OpenCode | `hooks` | generated plugin file (`kind: 'file'`) |
| OpenCode | `skills`, `instructions` | whole file |

Pi's `mcp.json` really does carry `oauth.clientSecret`; the current reader does not name `oauth` at
all, so it never becomes a fact and no gap is reported for it — nothing to migrate out, nothing to
leak. A url is the one value whose verdict can be partial: basic-auth userinfo is dropped and the
address survives.

A hook command is the table's one entry that is not a secret: `hooks[].command` is executable content,
so it may be mirrored as a write flagged `executable` — its own approval tick, and a plan that carries
it can never land `verified` ([capability-gap semantics](../.scratch/acm-rearchitecture/issues/11-capability-gap-semantics.md) §7).
It becomes a `credential` gap only when the classifier finds a provider token or a private key inside
it. Today no hook is read or written at all; the category lands with its own tickets.

A reference is not a credential. Three forms are clean by construction — `${VAR}`, `{env:VAR}`,
`{file:path}` — which is what lets a mirror carry `env.K: "${K}"` while withholding a literal token at
the same address. Pi's `!command` is different: it is clean but `executable`, and it can hold a literal
credential of its own. The classifier withholds one carrying a recognised provider token or a
private-key block; any other credential in a command is not detectable that way, so it can still
appear in stored facts and in a Pi mirror plan. Treat a `!command` as executable content to be
reviewed, not as a secret-free value.

## Skills and instructions

The two markdown categories have no typed leaves: a skill is a directory tree and an instruction file
is its own body, so a plan carries no values for them. Their vocabulary is one field each, and the
writer is a file op rather than a pointer write.

| category | canonical field | native form | write |
|---|---|---|---|
| `skills` | `files` | the tree under `<root>/<name>/`, named by its `SKILL.md` | `copyFile` into the shared `.agents/skills/<name>` — the whole tree, so an unknown frontmatter key survives the copy instead of becoming a gap |
| `instructions` | `body` | the markdown file's text | `symlink` when source and target share a scope bucket, `writeFile` across buckets |

Locations per (harness, tier). `reads` is what the harness loads — and therefore what `alsoReadBy`
answers from; `target` is where a mirror into that tier lands.

| tier | `skills.reads` | `skills.target` | `instructions.reads` / `target` |
|---|---|---|---|
| `pi:user` | `~/.agents/skills`, `~/.pi/agent/skills` | `~/.agents/skills` | `~/.pi/agent/AGENTS.md` |
| `pi:project` | `<repo>/.agents/skills`, `<repo>/.pi/skills` | `<repo>/.agents/skills` | `<repo>/AGENTS.md` |
| `codex:user` | `~/.agents/skills` | `~/.agents/skills` | `$CODEX_HOME/AGENTS.md` |
| `codex:project` | `<repo>/.agents/skills` | `<repo>/.agents/skills` | `<repo>/AGENTS.md` |
| `oc:user` | `~/.agents/skills`, `~/.config/opencode/skills`, `~/.claude/skills` | `~/.agents/skills` | `~/.config/opencode/AGENTS.md` |
| `oc:project` | `<repo>/.agents/skills`, `<repo>/.opencode/skills`, `<repo>/.claude/skills` | `<repo>/.agents/skills` | `<repo>/AGENTS.md` |

`reads` is what `alsoReadBy` answers from and what the inventory shows; only `target` is writable.
Containment holds a plan to the target (or a path beneath it), so a harness-owned `skills/` directory
is a source a mirror may copy from and never a place it may write into.

`.agents/skills` is read by all three harnesses and the project `AGENTS.md` is the same file for all
three, so a write there is never a single-harness write: `target.alsoReadBy` names the other readers,
and one installation carries one binding per harness. That is also why a second mirror writes nothing.

A trust gate can make a correct write inert, so the plan carries `permissions.trust` and a manual
step: Codex gates its whole project layer, and Pi gates a project's `.agents/skills` (and its own
project config) behind `/trust`. Pi's instruction-file discovery ignores trust, so a project
`AGENTS.md` needs no step there.

| situation | `writes[]` | `disposition.kind` |
|---|---|---|
| the target is the source location | `[]` | `alreadyShared` |
| a skill tree or an instruction body that already matches | `[]` | `alreadyPresent` |
| the tier declares no location for the category | `[]`, one `categoryAbsent` gap | `mirror` |
| a skill tree differs | `[]`, with both digests in `conflicts[]` | `mirror` |
| an instruction file differs | the body write, with both digests in `conflicts[]` | `mirror` |

A copy is offered only when the whole tree is clean: every text file in it — `SKILL.md`, the scripts,
the references — goes through the classifier, and one unclean file is a `credential` gap naming that
file, with nothing written, because a copy would put the value in every harness that reads the shared
location. Every link inside the tree is resolved too, and one that lands outside `$HOME` or the
project root refuses the copy.

An instruction body travels inside the plan, so its source is checked against the last scan: a file
edited since then is a refusal (`run acm list and plan again`) rather than a stale body written over
a target whose own digest would never reveal it.

A skill installed as a symlink is mirrored as a real directory: the executor resolves the source root
before copying, because a linked skill directory is the form none of the three harnesses verifies.
Links *inside* the tree are reproduced as links.

A `symlink` is used only where the spec permits one: the source and the target sit in the same scope
bucket, the target is a declared path, nothing exists there, and the digest the plan names is the
source's resolved content — which is exactly what verification re-reads. A skill is never linked:
symlinked skill *directories* are unverified for all three harnesses, so a skill is always copied.
An instruction file mirrored across buckets is written instead, because a link would point out of the
scope it is meant to belong to. A differing target is never overwritten without an explicit
`onConflict: replace`: a whole instruction file carries the write that answers the conflict, while a
differing skill directory carries only the conflict, because replacing it would need the removal op
this slice does not have.
