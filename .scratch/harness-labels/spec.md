# Spec: harnesses as free-form labels

Status: ready-for-agent
Source: conversation of this branch. Vocabulary in [CONTEXT.md](../../CONTEXT.md).

## Problem Statement

The environment file's harness field is typed as a closed enum (`pi`, `codex`, `opencode`) inherited
from the native-read layer. That coupling is wrong in two ways. First, a user may run a harness ACM
has no reader for (a fork, a new tool, a differently named install), and the file should still be
able to name it as a Provision's target. Second, the set of harnesses a machine actually uses is
itself per-machine configuration: two machines may face different harnesses, and there is no place to
declare that set, so an agent has no authoritative list to refer to and falls back on ACM's
hardcoded three.

The native-read layer genuinely needs the closed set, because it only knows how to read Pi, Codex,
and OpenCode config. The environment layer does not: a Provision's harness entry is a label and an
identity key, and ACM neither executes nor reads anything keyed on it beyond that.

## Solution

Split the two concerns. The environment layer (types, parser, loader, service, runner, history,
define) treats a harness name as an unconstrained string: no enum, no validation beyond non-empty
and NUL-free, no rejection of unknown names. The native-read layer keeps its closed `HarnessId`
enum and continues to validate `acm read <harness>` against it.

An environment file may declare the harnesses it faces at the top level with `harnesses = [ ... ]`.
These lists merge across the environment-file tiers the same way Provisions do (union, precedence
order, deduplicated), so `acm` can answer "which harnesses does this environment declare" without
guessing. When none is declared, the answer falls back to the three reader-backed harnesses, so a
fresh file still has a useful default.

Two MCP tools are added so an agent can discover and use ACM without out-of-band knowledge:
`list_harnesses`, returning the merged declared list (or the default three), and `acm_instructions`,
returning a concise static guide to the environment-facing tools (`list_provisions`,
`read_native_config`, `define_provision`, `list_harnesses`), the harness-as-label rule, and the
Check/Install contract.

## User Stories

1. As a human, I want to name any harness in an environment file, so that a harness ACM does not read
   natively is still a legal target of a Provision.
2. As a human, I want an unknown harness name to load without a refusal, so that a typo in one entry
   does not discard the whole file.
3. As a human, I want to declare the set of harnesses my environment faces in the file itself, so
   that the file is the source of truth for which harnesses matter on this machine.
4. As a human, I want harness lists from the user, project, and project-local files to merge, so
   that a project can add a harness without rewriting the home file.
5. As an AI agent, I want `list_harnesses` to tell me which harnesses this environment declares, so
   that I author entries against real names rather than guessing.
6. As an AI agent, I want `acm_instructions` to explain how to use the MCP tools, so that I do not
   need out-of-band documentation to operate ACM.
7. As an AI agent, I want `read_native_config` to keep working for `pi`, `codex`, and `opencode`,
   so that native reads stay available for the harnesses ACM can read.
8. As a human, I want `acm read <harness>` to keep rejecting unknown harnesses, so that a misspelled
   name is caught rather than answered empty.
9. As a developer, I want the environment layer to stop importing `HarnessId`, so that the native-read
   enum is no longer a dependency of the environment's vocabulary.
10. As a developer, I want the parser to accept the new top-level `harnesses` key without refusing
    the file, so that the new declaration is a legal document.
11. As a developer, I want the loader to expose the merged harness list, so that the service and the
    MCP tool share one answer.

## Implementation Decisions

- `Harness` in the environment layer becomes a plain `string`. The native-read layer keeps
  `HarnessId` and its enum; `readNativeConfig` keeps validating against it.
- The environment types replace `HarnessId` with `string` in `DeclaredEntry`, `ResolvedProvision`,
  `HarnessPresence`, and `Run`. `StatusFilter.harness` becomes `string`.
- The parser's `harnessId()` is replaced by a non-empty, NUL-free string check; `decodeEntry`
  takes a `string`. A top-level `harnesses` key is added to the closed document-key set and parsed
  as a string array, returned in `ParseResult`.
- The loader collects the declared harness lists across tiers as a union in precedence order and
  exposes them on `Environment`.
- The service exposes the merged list via `listHarnesses()` (defaulting to `pi`, `codex`,
  `opencode` when none declared) and adds it to `Status`.
- Two MCP tools are registered in the router: `list_harnesses` and `acm_instructions`. Neither
  imports an adapter or store module; both go through the service.
- `CONTEXT.md`'s `Harness` entry is updated to state that the environment layer treats the name as a
  free-form label while only the native-read layer enumerates readable harnesses. An ADR records the
  split.

## Testing Decisions

- Parser tests: an environment file naming an unknown harness loads; a top-level `harnesses` array
  parses and is returned.
- Loader tests: harness lists merge across tiers as a union in precedence order.
- Service tests: `listHarnesses()` returns the declared list, or the default three when absent.
- Native-read tests unchanged: `readNativeConfig` still rejects unknown harnesses.
- Good tests assert observable behavior (parse result, merged list, tool output), not internal
  type changes.

## Out of Scope

- Removing or changing the native-read layer's closed harness set.
- Validating harness names against the declared list (the list is informational).
- Persisting the harness list in the store; it is read live from environment files.
- Per-harness configuration beyond the existing `acm read` support.

## Further Notes

The native-read layer's `HarnessId` enum remains the authority for what ACM can read. The environment
layer's free-form label is the authority for what a Provision targets. The two never need to agree.