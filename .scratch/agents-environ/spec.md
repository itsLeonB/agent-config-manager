# Spec: agent environments as declared Provisions

Status: ready-for-agent
Source: conversation of this branch; [ADR 0007](../../docs/adr/0007-declare-provisions-and-delete-the-mirror-engine.md);
vocabulary in [CONTEXT.md](../../CONTEXT.md). Supersedes `.scratch/acm-rearchitecture/spec.md`.

## Problem Statement

Setting up a machine for agent work is manual work repeated on every machine. Each harness keeps its
own configuration in its own format, and the things a person actually installs do not map onto those
formats one to one: `serena` is an MCP server plus a hook on Codex and a plugin on Pi; `RTK` is an
`@`-import line inside an `AGENTS.md`; `i-have-adhd` is a block of markdown in the same file;
OpenCode's Claude-compatibility switch is one line in `.zshrc`. Some of these have no configuration
file at all.

Reading configuration cannot answer the question that matters — *is this installed here?* — because
the answer is spread across a file ACM can parse, a file it cannot, a shell profile, and the package
list of a harness. Reading cannot answer it for a second reason: the same installed thing has no
single native identity, so keying on `(category, name, native address)` splits one installation into
several rows with no way back together.

The result is that a working machine cannot be reproduced. It is rebuilt by hand, from memory, harness
by harness, and nothing records which of the hand steps were done.

## Solution

One plain file, checked into a dotfiles repository, declares the environment: a **Provision** per thing
installed, carrying a name, a **Check** per harness, and an **Install command** per harness. The
Check is declared data that ACM evaluates by reading, so it never executes anything and an agent may
define one. The Install command is idempotent, non-interactive text, written for one harness at one
tier, and only `acm install` ever runs it.

On a second machine: clone the dotfiles, run `acm install`, and the environment converges. On a
harness nobody has configured yet: an agent reads what the other harnesses declare (a **Native
read**, secret-free) and writes the missing Checks and commands through MCP.

Three capabilities survive from the previous design because they still earn their place: the
pointer-level native editor (retargeted at the environment file), the secret classifier (a Native
read is a new way for a credential to reach an agent), and the three harness readers (demoted to live,
unstored input for authoring). Everything else in the mirror engine is deleted, not deprecated.

## User Stories

### Declaring

1. As a human, I want to declare a Provision in a plain TOML file, so that my environment is a
   reviewable diff rather than a sequence of remembered commands.
2. As a human, I want one entry per harness per Provision, so that a thing that is a plugin on one
   harness and an MCP server plus a skill on another is still one Provision.
3. As a human, I want a Provision's entry to carry both a Check and an Install command, so that the
   file says both what should be there and how to put it there.
4. As a human, I want a Provision with no entry for some harness to be legal, so that harness-specific
   things do not need placeholder entries.
5. As a human, I want optional tags on a Provision, so that I can filter by a shape (`mcp`, `plugin`,
   `prompt`) without making the shape part of identity.
6. As a human, I want a `version` field in the file, so that a future format change is detectable
   rather than silently misread.
7. As a human, I want a malformed environment file to fail with line and column, so that a typo does
   not run half an environment.

### Checks and Presence

8. As a human, I want a Check that asks whether a file exists, so that a plugin installed into a known
   directory is detectable without executing anything.
9. As a human, I want a Check that asks whether a file contains a pattern, so that an export in
   `.zshrc` and a markdown block in `AGENTS.md` are detectable.
10. As a human, I want a Check that asks whether a value exists at a native location, so that an MCP
    entry, a Codex hook, or an OpenCode plugin entry is detectable by address.
11. As a human, I want an optional `equals` on that address, so that an entry present but disabled
    (`disabled: true`) is not counted as installed.
12. As a human, I want a Check that asks whether a name is on `PATH`, so that a tool binary is
    detectable without running it.
13. As a human, I want a Check that could not be evaluated to report `unknown`, so that a missing or
    unparseable file is never reported as an absence.
14. As a human, I want to see why a Check answered `unknown`, so that I can fix the file or the Check
    instead of guessing.
15. As a security reviewer, I want no Check to execute anything, so that an agent defining a Check
    cannot cause code to run when I read the environment.
16. As an AI agent, I want a Check to be a declarative value I can write, so that defining a Provision
    for a new harness needs no local shell access.

### Tiers and Environment Files

17. As a human, I want a user-tier environment file in my home directory, so that machine-wide
    provisions travel with my dotfiles.
18. As a human, I want a project-tier environment file I can commit, so that a repository can require
    provisions of anyone who works in it.
19. As a human, I want a project-local environment file that git ignores, so that my private additions
    to a shared project do not leak into the repository.
20. As a human, I want the file's location to be its Tier, so that no entry has to name a tier and no
    entry can disagree with where it lives.
21. As a human, I want a relative path in a Check or an Install command to resolve against its Tier's
    root, so that the same text means the project's file in a project file and my home file in a home
    file.
22. As a human, I want `acm` to read all three files when I run it in a project, so that the
    environment I converge is the one I actually have.
23. As a human, I want a nearer file to shadow a farther one for the same Provision and harness, so
    that a project can override one command without copying the whole Provision.
24. As a human, I want `--tier` to restrict a run, so that I can converge just the project layer.

### Install

25. As a human, I want `acm install` to run every Install command whose Presence is not `present`, so
    that one command converges a machine.
26. As a human, I want every Provision and its exact command printed before the first command runs,
    so that I can read what is about to happen.
27. As a human, I want `--dry-run` to print and stop, so that a run is reviewable without side effects.
28. As a human, I want `--dry-run` to be the default when stdin is not a terminal, so that a piped or
    scheduled invocation cannot silently change the machine.
29. As a human, I want no prompt in the run, so that a fresh machine converges in one command rather
    than in twenty answers.
30. As a human, I want each command to start in its Tier's root, so that a command's own relative
    paths land where its Provision's tier says.
31. As a human, I want each command to receive no standard input, so that a command that wants an
    answer fails immediately instead of hanging the run.
32. As a human, I want ACM to pass no extra environment variables, so that the command text I read is
    the whole of what runs.
33. As a human, I want commands to run in file order, so that a Provision that must run after another
    can be ordered by editing the file.
34. As a human, I want a failing command to be reported and the run to continue, so that one broken
    Provision does not stop the other thirty.
35. As a human, I want a non-zero exit status when anything failed or stayed absent, so that a wrapper
    script and my own eye agree about success.
36. As a human, I want `--only <name>` to restrict a run to Provisions of that name or tag, so
    that I can fix one thing without re-checking the world.
37. As a human, I want `--force` to run even what is already `present`, so that a repaired command can
    be re-applied.
38. As a human, I want a summary at the end naming what was already present, what ran, what failed,
    and what is still absent, so that the machine's state is answerable in one screen.
39. As a security reviewer, I want an agent to have no way to start a run, so that no MCP call can
    cause a command to execute.
40. As a security reviewer, I want `acm install` to never write an environment file, and defining a
    Provision to never run a command, so that the two directions have one actor each.

### Status and history

41. As a human, I want `acm status` to print Provision by harness with `present`, `absent`, or
    `unknown`, so that I can see the environment without changing it.
42. As an AI agent, I want the same answer as a tool result, so that I can decide what to define next.
43. As a human, I want `--json` on status, so that a script can read it.
44. As a human, I want every run recorded with its time, Provision, harness, tier, command, exit code,
    and Presence afterwards, so that a machine's history is answerable later.
45. As a security reviewer, I want command output not stored, so that a command that prints a token
    does not put it in a database.
46. As a maintainer, I want the store to hold runs and the existing dashboard tables only, so that
    there is one small persistence story instead of a second inventory.

### Native reads and new-harness onboarding

47. As an AI agent, I want to read what one harness declares at the paths it loads, so that I can write
    Provisions for a harness that has none yet.
48. As an AI agent, I want that answer to be secret-free — credentialed pointers withheld with a
    verdict marker, never a value — so that asking what is configured cannot leak a credential into my
    context.
49. As an AI agent, I want the answer to name each declaration's native location, so that the command I
    write can address the same place.
50. As an AI agent, I want the answer to be live and unstored, so that I am never reading a stale
    inventory of someone's machine.
51. As an AI agent, I want reading a harness whose config does not parse to say so, so that I do not
    author commands against a file I misread.
52. As a human, I want `acm read <harness>` on the CLI, so that I can see the same answer without an
    agent.

### Defining through MCP

53. As an AI agent, I want to define a Provision's Check and Install command for one harness, so that
    onboarding a harness is a tool call rather than hand-edited TOML.
54. As an AI agent, I want to choose which environment file a definition lands in, so that a
    machine-wide provision does not land in a project's file by accident.
55. As an AI agent, I want a definition to overwrite only the field tree it names, so that comments and
    sibling Provisions in the file survive.
56. As a human, I want every agent definition to be a visible diff in my dotfiles repository, so that I
    review what was added exactly as I review any other edit.

### Migrating off the previous design

57. As a human, I want the previous engine's inventory tables removed in one migration, so that two
    answers to "what is installed" cannot disagree.
58. As a human, I want the Claude dashboard to keep working unchanged, so that this change costs me no
    feature I was using.
59. As a maintainer, I want the mirror, plan, apply, verify, and setup paths deleted rather than left
    dormant, so that the deleted vocabulary cannot creep back into code.

### The file's shape after one real environment

60. As a human, I want an entry to declare more than one Check, so that "the plugin is installed and
    its hooks are trusted" is one row rather than two that can disagree.
61. As a human, I want a Check to address an element of an array, so that a list of plugins or hook
    entries is answerable by address instead of by a regex over the whole file.
62. As a human, I want a Check to compare one Section of a native instruction file against the text I
    declared, so that an edited or stale block reads `absent` rather than merely present.
63. As a human, I want that Section's heading to come from the text I wrote, so that one place spells
    the title and it cannot disagree with the entry.
64. As a human, I want one Payload to serve every harness entry that names it, so that fixing an
    instruction text once fixes all three.
65. As a human, I want an Install command too long to read inline to live in a file, so that the
    environment file stays reviewable and lintable.
66. As a human, I want a Payload to take arguments, so that three entries that differ by one name
    share one command.
67. As a human, I want `acm status` to name the file each row came from, so that running it in my home
    directory does not quietly relabel my home file as a project file.

## Implementation Decisions

### Vocabulary and entities

Terms are exactly those in `CONTEXT.md`: Provision, Check, Presence, Install command, Environment,
Environment file, Tier, Harness, Native location, Native read, Verdict, Credential pointer, Run,
Project root. The retired terms (Component, Installation, Binding, Capability, Gap, Mirror, Plan,
Grade, Scope bucket) must not appear in code, tool output, or docs.

### The Environment file

One TOML document per tier. `version = 1` at the root is required; an unknown version refuses to load.
Provisions are `[provision.<name>.<harness>]` tables, each with `checks` (one or more) and an
`install`. A Provision may carry `tags`. This shape is the decision, not a sketch:

```toml
version = 1

[provision.serena]
tags = ["mcp"]

[provision.serena.codex]
checks  = [{ file = "~/.codex/config.toml", pointer = "mcp_servers.serena" }]
install = { payload = "install/codex-mcp.sh", args = ["serena"] }

[provision.i-have-adhd.pi]
checks  = [{ file = "~/.config/opencode/opencode.json", pointer = "plugins", includes = "i-have-adhd" }]
install = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }

[provision.opencode-no-claude]
checks  = [{ file = "~/.zshrc", contains = "OPENCODE_DISABLE_CLAUDE_CODE" }]
install = "grep -q OPENCODE_DISABLE_CLAUDE_CODE ~/.zshrc || echo 'export OPENCODE_DISABLE_CLAUDE_CODE=1' >> ~/.zshrc"
```

- **A Check is a closed set of six predicates**, each an inline table: `{ file }` (exists),
  `{ file, contains = "<regex>" }`, `{ file, pointer = "<address>" [, equals = <value>] }`,
  `{ file, pointer = "<address>", includes = <value> }`, `{ file, section = "<payload>" }`, and
  `{ onPath = "<name>" }`. An address's format is derived from the file's extension by the same
  pointer reader the editor uses, so a JSON pointer and a TOML dotted key are written the same way. A
  segment in double quotes names a key literally and a numeric segment indexes an array; an address
  the reader cannot spell refuses the file rather than answering for it. A seventh predicate kind is a
  schema change.
- **An entry's `checks` all have to hold**, and `check = { … }` stays legal as a one-element list, so
  a file written before this slice keeps loading at `version = 1`.
- **Install is one of three shapes**: a string, required and the only text ACM ever executes;
  `{ payload = "<path>" [, args = [ … ]] }`, whose Payload is read at run time and whose arguments
  reach it as argv; or `{ file = "<native file>", section = "<payload>" }`, which rewrites one Section
  and nothing else of that file.
- **Validation is total.** An unknown key, a missing `install`, an empty `checks` list, an unknown
  harness id, an unknown predicate kind, an empty `contains`, or an address that cannot be spelled
  refuses the whole file with line and column. A file that does not parse contributes nothing; the
  other tiers still load.
- **A relative path in `file`, a Payload path, or an `install` string resolves against the tier
  root** — `$HOME` for `user`, the Project root for `project` and `project-local`. A leading `~` or
  `/` is absolute. This is what lets one Provision's text be written twice for two tiers and stay
  readable.

### Loading and merging

One loader answers with a list of resolved Provisions, each carrying its Tier, harness, name, Check,
Install command, and source file. It reads `user` always, and the two project files when the Project
root has them. Merge is per `(provision, harness)` key with `project-local` > `project` > `user`; a
Provision's `tags` merge the same way, replaced rather than unioned, so a nearer file owns its entry
whole. Ordering for a run is file order of the winning entry, `user` file first, which keeps a
human-editable sequence without inventing a dependency syntax. A file is read once: when two tiers
resolve to one path — a Project root that is `$HOME` — the `user` tier keeps it, so the home file is
never relabelled as a project declaration.

### Presence

`Presence` is `present | absent | unknown`, with an optional `detail`: the reason a Check could not be
answered (unreadable file, unparseable file, missing binary directory, invalid regex) or, for an
entry that declared several Checks, every Check that did not answer `present` named with its own
reason. Checks read; they never spawn. `onPath` walks `PATH` and requires a regular executable file. `pointer` presence means a value
exists at that address; with `equals`, the value must also match by deep equality; with `includes`,
the array at that address must hold an element deeply equal to it. An entry's Presence folds its
Checks: any `absent` answers `absent`, otherwise any `unknown` answers `unknown`, otherwise
`present`, and `detail` names every Check that did not answer `present`. Presence is never stored
between runs — `acm status` always re-evaluates.

### The install run

A run is a pure function of the Environment plus the filesystem: it prints each Provision, harness,
Tier, and command, then starts the commands whose Presence is not `present` (or all of them under
`--force`), in loader order.

- Each command starts via the POSIX shell, with `cwd` = the Tier root, stdin from `/dev/null`,
  inherited stdout/stderr, and the parent environment unchanged. ACM adds no variables.
- A Payload starts as `sh <payload> <args…>` from that same root, so its text is read at run time and
  needs no executable bit. A Payload that cannot be read fails its entry without spawning anything.
- A Section write replaces the text between a Section's heading and the next `## ` heading, creates
  the file when it is absent, and appends at end of file when the Section is. Nothing outside the
  Section is touched, and the comparison strips trailing blank lines from both sides.
- A failing command is recorded and the run continues. The exit status is non-zero if any command
  failed or any Presence is still not `present` afterwards.
- No per-command timeout in this slice: a hung command holds the run until interrupted.
  `shortcut: no per-command timeout; add one when a real command hangs.`
- `--dry-run` is the default when stdin is not a TTY. `--only` (a Provision name or a tag) and
  `--tier` filter; `--force` re-runs.
- Presence is re-evaluated after each command, and that answer is what the run records. A command that
  half-worked reports `present` if its Checks pass. The recorded command is what ran, spelled: the
  Payload path followed by its arguments when there is one.

### The MCP surface

Three tools, identical on all three clients, registered with zod input schemas:

| Tool | Input | Output | Hint |
|---|---|---|---|
| `list_provisions` | `tier?`, `harness?`, `name?` | Provision rows with per-harness Presence and `detail` | `readOnlyHint: true` |
| `read_native_config` | `harness`, `tier?` | secret-free declarations with native locations, or a parse error | `readOnlyHint: true` |
| `define_provision` | `name`, `harness`, `tier?`, `check`, `install`, `tags?` | the written pointer and the file's digest | `readOnlyHint: false` |

- `define_provision`'s `checks` and `install` are discriminated unions of the shapes above, so a
  client sees every predicate and every install form in the tool schema instead of a free-form object.
- No tool deletes a Provision: the environment file is the interface, and removal is an edit to it.
- No tool runs a command and no tool runs a Check that spawns anything, by construction: Checks cannot
  spawn.
- `define_provision` defaults to `project-local`, so an agent's unreviewed addition never lands in a
  committed file. It writes through the pointer-level native editor, so comments and sibling
  Provisions survive; a same-key write replaces that Provision's harness subtree only.
- `read_native_config` reuses the existing harness readers. It answers for every path a harness's read
  lookup declares at that tier, and it applies the secret classifier and credential pointers before
  anything reaches the result.

### The CLI

`acm install`, `acm status`, `acm read`. The previous `list`, `inspect`, `mirror`, `apply`, `verify`,
and `setup` subcommands are removed. `acm mcp serve` survives unchanged. The MCP module and the CLI
module still import only the environment service — never the store module, the loader's internals, or
a harness reader directly.

### Storage

The store keeps `runs` (id, at, provision, harness, tier, command, exit code, presence after) and the
existing dashboard tables. Command output is deliberately not stored. One migration drops the
previous engine's inventory tables and creates `runs`; `PRAGMA user_version` gates it and every write
opens with `BEGIN IMMEDIATE`, as before. The store module keeps its exclusive claim on `node:sqlite`.

### What is deleted

The plan builder, the apply executor and its consent gates, the mirror verification, the MCP write
surfaces and their field tables, the hook write surface, the canonical-field documentation, the
discovery pass with tombstones and tier health, the installation/binding tables and their repo
functions, and `acm setup`. The tier-declaration helpers survive only as a read-only per-harness path
lookup; writability and scope buckets go with the inventory. Everything the deleted paths own in the
old spec's sections 4, 5, 7, and 9 goes with them.

### What is kept and retargeted

The pointer-level native editor (now also edits the environment file, which is TOML it already reads),
the secret classifier with its ordered rule table and credential pointers, content digesting, the
engine configuration module, and the three harness readers.

## Testing Decisions

**What makes a good test here.** Only externally observable behaviour: the rows `status` returns, the
order and commands a run prints, the exit status, the bytes on disk after a command, and the record a
run leaves. Never the internal call sequence, never "the loader was called once". A test that still
passes after the merge rule were inverted is worthless.

**Three seams, and no fourth. Existing seams are reused; none is new.**

- **Seam A — the environment service (primary, integration).** Everything runs against a fixture: a
  temp home, a temp project root, a temp store, hand-written `agents_environ.toml` files, and
  hand-written native config files. Install commands in fixtures are tiny shell scripts the test
  writes (`true`, `exit 1`, `echo >> file`, a script that reads stdin), so a run's behaviour — order,
  cwd, skipped presents, continued failures, exit status, recorded Presence — is asserted without a
  real harness. Merge and shadowing, tier resolution of relative paths, `unknown` derivation, every
  Check predicate, `--dry-run` defaulting, `--only`, `--force`, and the `define_provision` round trip
  all live here.
- **Seam B — pure functions over bytes (unit).** The environment-file parser and validator (every
  refusal case, line and column), the Check evaluator over fixture bytes and a fake `PATH`, and the
  secret classifier's rule table including its false-positive guards. This is where the predicate set
  and the TOML shape get pinned precisely.
- **Seam C — the installed bundle over stdio (process smoke).** Spawn the built entry, `initialize` →
  `tools/list` → `list_provisions` → `define_provision`, and assert the three tool names, their hints,
  and that a definition lands bytes in a fixture file. Existing test, extended rather than added.

**Prior art.** `bun test` with `node:assert`, no mocks, no test framework; temp-directory fixtures;
hand-written native files, never captured from a real machine. The previous slice's Seam A/B/C tests
are the pattern to follow; most of Seam A's harness fixtures survive because Native reads still need
them.

## Out of Scope

- **Provisioning a harness itself** and automating its authentication. A machine is assumed to have
  Pi, Codex, and OpenCode installed. No Provision represents a harness binary.
- **Secret classification of Install commands.** An Install command is assumed to carry no credential;
  the known gap is that the environment file is a place a token could sit unremarked.
- **Any agent-triggered execution.** No MCP tool runs an Install command, and no Check spawns.
- **Removing a Provision through MCP.** The environment file is the interface; removal is an edit.
- **Declaring absence, remove commands, and pruning.** A Provision says what should be present, and a
  Section is the only native text ACM may overwrite. Revisit when a machine has to be reproduced
  *without* a leftover.
- **Per-command timeouts, retries, and parallel runs.**
- **Command output capture or persistence.**
- **Categorising Provisions.** `tags` filter; they are not identity and carry no vocabulary.
- **The previous slice in full**: mirroring, plans, gaps, equivalence, graded consent, tombstones,
  tier health, capability tables, and `acm setup`.
- **Harnesses beyond Pi, Codex, OpenCode**, Windows, and a run from a machine without a POSIX shell.
- **A UI.** The Claude dashboard is inherited unchanged and reads none of this.

## Further Notes

**Build order that keeps each step reviewable.**

1. The Environment file parser and validator, with the check predicate schema — pure, Seam B.
2. The Check evaluator over bytes and `PATH` — pure, Seam B.
3. The loader and merge, with tier-root resolution — Seam A starts here against fixtures.
4. `status`, printing and `--json`, wired to the MCP `list_provisions`.
5. The install runner and its record, `runs` table and migration.
6. `read_native_config` over the surviving readers plus the classifier.
7. `define_provision` over the retargeted pointer editor.
8. Deletion sweep: plan, apply, verify, write surfaces, setup, inventory tables. Do this last, so the
   new path is proven before the old one is removed.

**What to check first if the slice looks wrong.** The environment file is the contract. If a Provision
that is real on this machine cannot be written as a name, a Check per harness, and an Install command
per harness, that is a spec failure — amend the predicate set or the shape before writing more code.

**Risk stated once.** A run reports `present` after a Check passes, and a Check is only as good as its
author. A Provision with a weak Check reports success while the machine is half-configured, and
nothing in this design detects that. The mitigation is authorship discipline: prefer a Check that
names the specific entry a command creates over one that names the file.
