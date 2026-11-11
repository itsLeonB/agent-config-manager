# Agent Config Manager

A reproducible, local-first environment for AI coding agent configuration: every harness's plugins,
MCP servers, skills, hooks, and instruction files are declared once, in a plain file, as a named
**Provision** — Checks and an install command shared by every harness entry, plus a per-harness
entry where a harness needs its own — and `acm install`
reproduces the whole environment on another machine. Native config stays native; ACM writes it only
through the commands the environment declares. This file holds the vocabulary the code, the specs,
and the docs must agree on.

## Entities

**Provision**: one named thing the environment should have, whatever form it takes in each harness —
the same Provision may be a plugin on one harness and an MCP server plus a skill on another. Named by
a human (`serena`, `rtk`, `i-have-adhd`), never by a native address. Keyed by
`(provision name, harness)` within one environment file. A Provision may declare Checks and an
Install command shared by all its harness entries; each harness's table is an entry, and an empty
entry means the harness takes the shared declaration whole — it is declared so the Provision's rows
show that harness.
_Avoid_: component, plugin, entry, package, item, installation

**Check**: the declared predicate that answers whether part of a Provision is present in one harness —
a file that exists, a file that contains a pattern, a value at a native location, a value among the
elements of an array at one, a Section that matches its Payload, a name on `PATH`. A Provision or an
entry declares one or more of them and all of them must hold — an entry's effective Checks are the
shared ones plus its own. A Check is data, never code: it is evaluated by reading, so
declaring one executes nothing.
_Avoid_: detection, probe, test, health check

**Presence**: the answer an entry gives — `present`, `absent`, or `unknown`, folded from its Checks: any
`absent` answers `absent`, otherwise any `unknown` answers `unknown`. `unknown` means a Check could not
be evaluated (a file or Payload it reads is missing or unparseable, an address it cannot spell), so an
unanswered question is never reported as an absence.
_Avoid_: status, state, installed flag, health, verdict

**Install command**: the idempotent, non-interactive command that puts a Provision — wholly, when
shared, or into one harness, when declared on an entry — into place. Declared on the Provision it runs
at most once per run, before the first entry that needs it; declared on an entry it runs for that
entry alone. Its text is either spelled in the file or kept in a Payload, and a Payload may be given
arguments. It
is written for one Tier: it runs from that Tier's root, a relative path in it means that root, and ACM
passes it no environment variables and no standard input. It carries no credential. Run only by
`acm install`, which a human starts.
_Avoid_: recipe, action, mutation

**Payload**: the file a declared text lives in — an Install command too long to read inline, or the text
of one Section. Its path resolves the way a Check's file does: `~` or an absolute path as written,
anything else against the Tier's root. One Payload serves every entry that names it, which is how three
harnesses share one instruction text instead of holding three copies of it. Arguments passed to a
Payload reach it as argv and are never substituted into its text.
_Avoid_: script, snippet, template, partial, block

**Section**: the part of a native instruction file that one Payload owns — the `## ` heading the
Payload's first line spells, through the line before the next `## ` heading, with `## ` lines inside a
fenced code block ignored and `### ` headings not ending it. ACM reads it and may rewrite it, and
nothing outside it is touched.
_Avoid_: block, marker, region, chunk

**Environment**: the merged set of Provisions declared by the environment files ACM is facing.
_Avoid_: config, inventory, setup, state

**Environment file**: `agents_environ.toml`, or `agents_environ.local.toml` at project-local tier.
Where Provisions are declared; its location is its tier.
_Avoid_: manifest, lockfile, dotfile, registry

**Tier**: where an environment file lives — `user` (`~/agents_environ.toml`), `project`
(`<repo>/agents_environ.toml`, committed), `project-local` (`<repo>/agents_environ.local.toml`,
gitignored). Nothing else is a tier, and no entry names one: the file it sits in says it. A tier's
root is `$HOME` for `user` and the **Project root** for the other two.
_Avoid_: scope, scope bucket, layer, level

**Harness**: an agent CLI that reads its own native configuration — Pi, Codex, OpenCode among them.
In an environment file its name is a free-form label: ACM does not enumerate or validate the harnesses
a Provision names, and a human may declare any. Only the Native read layer knows the three harnesses
whose config it can read; the environment layer treats the name as display and identity only.
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
- An Install command is static text: no placeholders, no environment variables, no credential. The
  same Provision at two tiers therefore has two commands, and that duplication is intended. Arguments
  are passed to a Payload as argv, never substituted into it.
- A shared Install command runs at most once per run, before the first entry that needs it; an empty
  harness entry means the harness uses the Provision's shared declaration, and exists for visibility.
- Nothing is declared absent and nothing is removed: a Provision says what should be present, an
  entry's Section is the only text ACM may overwrite, and retiring a Provision is an edit to the file.
- Two Tiers that resolve to one file are one environment file: the nearer Tier wins and the farther
  contributes nothing.
- A Provision's form is per harness, so no rule may assume the same category, path, or number of
  native entries on two harnesses.
- Retired by [ADR 0007](docs/adr/0007-declare-provisions-and-delete-the-mirror-engine.md): Component,
  Installation, Binding, Capability, Known fields, Gap, Mirror, Plan, Grade, Scope bucket. They must
  not reappear in code, tool output, or docs.
