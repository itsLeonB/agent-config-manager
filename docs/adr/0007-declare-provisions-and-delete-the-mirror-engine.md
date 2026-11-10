# Declare Provisions as a check plus an install command, and delete the mirror engine

Discovery could only report what a harness spells out in a file ACM could parse. The things that
mattered most were exactly the ones it could not: `OPENCODE_DISABLE_CLAUDE_CODE=1` in `.zshrc`, a
third-party hook entry that says nothing about which package put it there, an `@`-import and an
output-style block inside an `AGENTS.md`. Adding a reader for each install vector is unbounded work
against formats that change without notice.

The mirror model had a second, structural problem: it keyed identity on `(category, name, native
address)`, but one installed thing is not one category. `serena` is an MCP server plus a hook on
Codex, a plugin on Pi. There is no per-category identity that can hold that, so no amount of adapter
work makes "is serena installed here?" answerable.

So the unit changes from *what a config file says* to *what a human installed*: a **Provision** — a
name, a declared check per harness, and an idempotent install command per harness — declared in an
environment file whose location is its tier (`user`, `project`, `project-local`). `acm install` walks
the Provisions and runs each harness's command. A fresh machine reproduces the environment by
checking the file out and running one command. Adding a harness means an agent reads what the
existing harnesses declare (a **native read**, secret-free) and writes the missing commands, rather
than hand-translating config.

Checks are declared predicates, not shell commands, because agents are allowed to define them through
MCP and a shell check would let an agent's `define` call turn the next `list` into arbitrary code
execution. Only `acm install`, started by a human in a terminal, executes anything.

## Considered Options

- **Two mechanisms: keep the reader-based inventory, add declared commands beside it.** Rejected: it
  keeps the identity model that cannot answer the question that started this, and it leaves two
  answers to "what is installed" that disagree.
- **Declared commands for plugins only, readers for MCP/skills/hooks.** Rejected for the same reason,
  one level down: `serena` is a plugin on one harness and MCP-plus-hook on another, so a per-category
  split cannot represent it either.
- **Shell commands as checks** (`checkCommand` exit code, as the dashboard's `environmentTools` did).
  Rejected: an agent may define a Provision through MCP, so a shell check is agent-authored code that
  the next read executes.
- **Keep the environment in the SQLite store.** Rejected: `database/` is gitignored and machine-local,
  so the artefact that is supposed to reproduce a machine could not leave it, or be diffed.
- **Chosen**: Provisions in a git-tracked TOML file, static checks, idempotent commands run only by
  `acm install`, native reads demoted to a live secret-free authoring input.

## Consequences

- **`acm install` is blanket consent, deliberately.** One human command approves N commands. ADR 0005
  forbids blanket approval in every form; this supersedes that prohibition instead of quietly
  violating it. The guards that remain are that the command is human-started, prints every Provision
  and the exact command before running it, confirms per Provision, and refuses to run without a TTY
  (`--dry-run` works anywhere).
- **This supersedes ADR 0001's tier/scope split.** The split existed to reconcile harness-native
  layers; the tier is now the environment file's location, so the split has nothing left to reconcile
  and the scope bucket is retired. Per-harness native paths survive as a plain read lookup, not as a
  tier model with writability.
- **Native config stops being a source of truth.** ACM can no longer prove what landed: there is no
  plan, no precondition, no diff, no field mapping, and no verification of a command's effect beyond
  re-running the check. A Provision whose command half-worked reports `present` if the check passes.
- **Everything the plan document carried is deleted**, not deprecated: `equivalence`, `gaps`,
  `disposition`, `writes[]`, `verify.asserts[]`, the seven MCP transforms, the per-tier allowlists, the
  graded-consent gate, and tombstoning with tier health. The store keeps Run history and the Claude
  dashboard's tables and nothing else.
- **What still earns its place**: the pointer-level native editor (retargeted at the environment
  file itself), the secret classifier and credential pointers (a native read is a new path for a
  credential to reach an agent), digesting, and the three harness readers.
- **Coverage is unenforced.** A Provision with no entry for some harness is "not applicable" and
  reports nothing, so a new harness's environment is only as complete as the entries written for it.
