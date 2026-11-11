# Spec: skills from the lockfile, and two environment tiers

Status: ready-for-agent
Source: conversation of this branch. Vocabulary in [CONTEXT.md](../../CONTEXT.md).

## Problem Statement

Skills are declared as Provisions today: one `[provision.skills-<name>]` table per skill, a Check that
the skills lockfile contains the source, and an Install command that runs `npx skills add`. That makes
the environment file a second copy of a lockfile the `skills` CLI already maintains, and it hides the
one fact a human needs: which skills this machine has. The same lockfile is the input and the output,
so the two can disagree without either saying so.

The environment also has a third tier, `project-local` (`agents_environ.local.toml`). It is gitignored,
rarely used, and makes "which file declared this harness?" ambiguous. The harness list merges across
tiers, so a file cannot say which harnesses it faces, and `define_provision` accepts any harness name
even when the file declares a list.

## Solution

Skills leave the Provision model. `acm skills install` reads the user skills lockfile and the project
skills lockfile, groups each by source, and runs `npx skills add` once per source with the harness list
the matching environment file declares. `acm status` and `acm install` do not look at skills; the
engine's skill reader stays, because a native read still answers what a harness declares. A
`skills-*` Provision remains a legal generic Provision, but it is not a supported category.

There are two tiers: `user` (`~/agents_environ.toml`) and `project`
(`<repo>/agents_environ.toml`). The `harnesses` list is per file and is never merged. When a file
declares one, every entry in that file must use one of those names, and the parser refuses the file
otherwise. A new MCP tool, `declare_harnesses`, writes one tier's list; `define_provision` and
`declare_harnesses` require an explicit tier.

## User Stories

1. As a human, I want one command to install every skill my machine declares, so that a fresh machine
   gets the same skills without hand-running `npx`.
2. As a human, I want the user lockfile installed at user scope and the project lockfile at project
   scope, so that each scope's skills land where the harnesses read them.
3. As a human, I want the command to group skills by source, so that a repository with many skills is
   fetched once instead of once per skill.
4. As a human, I want the harness list from the environment file passed to `skills`, so that a skill is
   linked only to the harnesses this machine faces.
5. As a human, I want no `--agent` flag when a tier declares no harnesses, so that `skills` detects the
   installed harnesses instead of creating directories for harnesses I do not use.
6. As a human, I want `--dry-run` to print the exact commands, so that I can review what will run
   before it runs.
7. As a human, I want a missing or unreadable lockfile to warn and continue, so that one absent file
   does not block the other scope.
8. As a human, I want an entry with no source to be skipped with a warning, so that one bad lockfile
   entry does not hide the rest.
9. As a human, I want every command to run and the exit status to say whether any failed, so that one
   failure does not stop the rest and the command still reports the problem.
10. As a human, I want skills to stay out of the Provision model, so that there is one source of truth
    for skills and no duplicate Install commands.
11. As a human, I want an intentional `skills-*` Provision to keep working as a generic Provision, so
    that removing built-in support does not break a hand-written entry.
12. As a human, I want to see the harness list per tier, so that I know which file declares which
    harnesses.
13. As an AI agent, I want `declare_harnesses` to write the harness list for one tier, so that I can
    declare the machine's harnesses without hand-editing TOML.
14. As an AI agent, I want `define_provision` to refuse a harness the target file's list does not name,
    so that a definition cannot point at a harness the file does not face.
15. As an AI agent, I want `list_harnesses` to answer per tier, so that I can see which file declares
    which harnesses.
16. As a developer, I want the parser to enforce the harness list, so that a hand-edited file cannot
    hold a definition `define_provision` would refuse.
17. As a developer, I want the loader to stop reading the project-local file, so that the two-tier
    model has one code path.
18. As a developer, I want `define_provision` and `declare_harnesses` to require a tier, so that no
    write lands in a committed file by accident.
19. As a developer, I want the tier list to have two members, so that the tier filter, the parser, and
    the MCP schema agree.
20. As a developer, I want the lockfile reader to be a pure function over bytes, so that every lockfile
    shape is testable without `npx`.
21. As a developer, I want the skills installer in its own module, so that the environment service
    stays about Provisions.

## Implementation Decisions

- **Two tiers.** `user` (`~/agents_environ.toml`) and `project` (`<repo>/agents_environ.toml`). The
  loader reads the user file always and the project file when the Project root has one. Merge is per
  `(provision, harness)` with `project` over `user`; the nearer entry replaces the farther one whole,
  `tags` included. A relative path in a Check or an Install command resolves against `$HOME` for `user`
  and the Project root for `project`.
- **The harness list is per file.** A top-level `harnesses = [ ... ]` is parsed as a string array. The
  parser refuses the file when an entry names a harness the same file's list does not contain; a file
  with no list declares no harnesses and constrains nothing. Lists are never merged.
- **The loader carries a per-tier record.** `Environment` exposes one harness list per tier rather than
  a merged list. `listHarnesses(tier?)` answers one tier's list or all tiers; `Status` and the status
  footer print the tiers separately. The default three-harness answer is gone.
- **`define_provision` and `declare_harnesses` require a tier.** The MCP schema's tier enum has two
  members and no default. `declare_harnesses` takes a non-empty string array and writes the top-level
  `harnesses` key through the pointer-level editor; an empty array clears it. The parser validates the
  result after the write, so a refused list writes nothing.
- **Skills are not Provisions.** `acm skills install` is a CLI-only command; no MCP tool runs it, and no
  Check spawns. The engine's skill reader stays for native reads. A `skills-*` Provision is a generic
  Provision and is not inspected specially.
- **The skills installer.** A new module owns the lockfile reader and the installer. The reader is a
  pure function over a lockfile's bytes: it returns the skill names and sources in file order, skips an
  entry with no `source` with a warning, and treats a missing or unreadable lockfile as empty with a
  warning. The installer reads the user lockfile and the project lockfile, groups each by `source`, and
  runs one command per group: `npx -y skills@latest add <source> --skill <name>... [--agent
  <harness>...] [-g] -y`. The user groups run first, with `-g`; the project groups run from the Project
  root without it. A tier with no declared harnesses omits `--agent`.
- **Execution and reporting.** Every group runs even if an earlier one fails. The command prints each
  command and its exit status; `--dry-run` prints the commands and stops. Any failed command makes the
  exit status non-zero. Nothing is written to the store: the lockfile is the skill history.
- **Remove `project-local`.** The tier list, the loader's file table, `define`'s default tier, the
  service, the MCP enum, the tests, the gitignore entry, and the docs lose `project-local`.
  `agents_environ.local.toml` is no longer read; there is no data migration.

## Testing Decisions

**What makes a good test here.** Only externally observable behaviour: the commands printed, the order
they run in, the arguments they receive, the exit status, and the rows a face returns. Never the
internal call sequence. A test that still passes after the grouping or the tier rule were inverted is
worthless.

**Seam A — the skills service against a fixture (primary).** A temp home, a temp project root, and
hand-written lockfiles. A fake `npx` on `PATH` records its argv and exits with a chosen status, so the
test asserts the exact commands, their order, the `-g` placement, the `--agent` set, the omitted
`--agent`, `--dry-run`, the warnings, and the exit status without a network or a real install. This is
the same fixture-and-recorder pattern as the Install runner tests.

**Seam B — pure functions over bytes (unit).** The lockfile reader over version 1 and version 3 files,
a missing `skills` key, an invalid JSON body, and an entry with no `source`. The parser over every
harness-list refusal: an entry outside the list, a non-string list, an empty name, and a NUL. The
definition validation over a target file with and without a list. This is the parser-test pattern.

**Seam C — the installed bundle over stdio and process (smoke).** Spawn the built entry for `acm skills
install --dry-run` with fixture lockfiles and assert the printed commands. Extend the MCP stdio test:
`initialize` → `tools/list` → `declare_harnesses` → `list_harnesses`, and assert the per-tier shape and
that the bytes landed. This is the CLI and MCP smoke pattern.

**Prior art.** `node:assert`, `bun test`, no mocks, temp-directory fixtures; the Install runner tests
for Seam A, the parser tests for Seam B, and the CLI and MCP smoke tests for Seam C.

## Out of Scope

- Writing, updating, or removing skills in the lockfile. The `skills` CLI owns that.
- Skill Presence in `acm status`. A skill's presence is the lockfile's and the agent directory's, not a
  Provision Check.
- An MCP tool that runs `acm skills install`. The MCP face never spawns a command.
- Migrating the existing `skills-*` Provisions. They stay as generic Provisions; removing them is a
  separate edit.
- Reproducing the user lockfile on a fresh machine. It is machine-local; only the committed project
  lockfile travels with a repository. A user who needs global skills on a new machine puts the lockfile
  in their dotfiles.
- Pinning the `skills` CLI version. `npx -y skills@latest` is the command; a pin is a later choice.
- Any `project-local` data migration. The file is no longer read.

## Further Notes

- The user lockfile lives at `~/.agents/.skill-lock.json`; the project lockfile at
  `<project>/skills-lock.json`. Both are maintained by the `skills` CLI.
- `skills add` re-links an installed skill; it is not a no-op, but it has no `--force` and no store
  history. `acm skills install` is therefore a converge command, not an install-only command.
- This spec supersedes the `project-local` parts of the environment spec and ADR 0009's rule that
  harness lists merge as a union across tiers. ADR 0010 and ADR 0011 record the decisions.
- Suggested tickets: remove the `project-local` tier; per-tier harness lists, parser validation, and
  `declare_harnesses`; the skills lockfile reader and `acm skills install`.