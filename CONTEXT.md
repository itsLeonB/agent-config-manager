# Agent Config Manager

A reproducible, local-first environment for AI coding agent configuration: every harness's plugins,
MCP servers, skills, hooks, and instruction files are declared once, in a plain file, as a named
**Provision** with one check and one idempotent install command per harness — and `acm install`
reproduces the whole environment on another machine. Native config stays native; ACM writes it only
through the commands the environment declares. This file holds the vocabulary the code, the specs,
and the docs must agree on.

## Entities

**Provision**: one named thing the environment should have, whatever form it takes in each harness —
the same Provision may be a plugin on one harness and an MCP server plus a skill on another. Named by
a human (`serena`, `rtk`, `i-have-adhd`), never by a native address. Keyed by
`(provision name, harness)` within one environment file.
_Avoid_: component, plugin, entry, package, item, installation

**Check**: the declared predicate that answers whether a Provision is present in one harness — a file
that exists, a file that contains a pattern, a value at a native location, a name on `PATH`. It is
data, never code: a check is evaluated by reading, so declaring one executes nothing.
_Avoid_: detection, probe, test, health check

**Presence**: the answer a check gives — `present`, `absent`, or `unknown`. `unknown` means the check
could not be evaluated (a file it reads is missing or unparseable), so an unanswered question is never
reported as an absence.
_Avoid_: status, state, installed flag, health, verdict

**Install command**: the idempotent command that puts a Provision into one harness. Run only by
`acm install`, and only when a human started it in a terminal.
_Avoid_: recipe, script, action, mutation

**Environment**: the merged set of Provisions declared by the environment files ACM is facing.
_Avoid_: config, inventory, setup, state

**Environment file**: `agents_environ.toml`, or `agents_environ.local.toml` at project-local tier.
Where Provisions are declared; its location is its tier.
_Avoid_: manifest, lockfile, dotfile, registry

**Tier**: where an environment file lives — `user` (`~/agents_environ.toml`), `project`
(`<repo>/agents_environ.toml`, committed), `project-local` (`<repo>/agents_environ.local.toml`,
gitignored). Nothing else is a tier, and no entry names one: the file it sits in says it.
_Avoid_: scope, scope bucket, layer, level

**Harness**: one agent CLI that reads its own native configuration — Pi, Codex, OpenCode. Identified
by its id, never by a config path.
_Avoid_: client, agent, tool, target

**Native location**: `{file, pointer}` — a config file plus the address inside it. Named by a native
read, and what a check may point at.

**Native read**: ACM's live answer to what one harness declares at the paths it loads, secret-free.
Never stored and never the inventory: it is what an agent reads to write Provisions for a harness that
has none yet.
_Avoid_: discovery, scan, inventory, harvest

**Verdict**: the classifier's answer for one value — `clean`, `suspect`, or `secret` — produced before
any value can reach a native read's answer, a tool result, or a log line.
_Avoid_: risk level, severity, confidence, redaction

**Credential pointer**: a pointer an adapter declares credential-bearing, carrying a kind — `leaf` for
a value that must never be stored, `file` for a whole file whose text has to be scanned. It survives
because a native read is where a credential would otherwise reach an agent.

**Run**: one invocation of one Install command for one Provision, recorded with its time, command,
exit code, and presence afterwards. The only history ACM keeps.
_Avoid_: operation, apply, job, execution

**Project root**: the one project `acm` is currently facing — the directory it was started in, or one a
caller names, taken as given and never walked up to a repository marker, because the environment files
it reads must be the ones a shell there would read.
_Avoid_: store location, install root, repository root, working directory when the resolved root is meant

## Rules that follow from the vocabulary

- The environment file is the source of truth. Native config is output, not inventory: what a
  Provision did not declare, ACM cannot report.
- A check executes nothing. Only `acm install`, started by a human, runs an Install command.
- A Provision's form is per harness, so no rule may assume the same category, path, or number of
  native entries on two harnesses.
- Retired by [ADR 0007](docs/adr/0007-declare-provisions-and-delete-the-mirror-engine.md): Component,
  Installation, Binding, Capability, Known fields, Gap, Mirror, Plan, Grade, Scope bucket. They must
  not reappear in code, tool output, or docs.
