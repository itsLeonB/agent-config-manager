import type { HarnessId } from '../engine/adapters/types.ts'

// The environment file is the source of truth, so the types below follow it: what one file
// declares, what the loader resolves it to, and the rows the CLI and MCP faces print. The words are
// CONTEXT.md's — Provision, Check, Presence, Install command, Tier, Harness.

// A tier is where an environment file lives and nothing else; no entry names one. 03 reads `user`
// only, 06 adds the two project files.
export const ENVIRONMENT_TIERS = ['user', 'project', 'project-local'] as const
export type EnvironmentTier = (typeof ENVIRONMENT_TIERS)[number]

// An unanswered question is never reported as an absence, so the third value exists from the start.
// The two predicates 03 ships answer `present` or `absent`; 07 derives `unknown` for the rest.
export const PRESENCES = ['present', 'absent', 'unknown'] as const
export type Presence = (typeof PRESENCES)[number]

// A Check is the inline table the file spells. `{ file }` asks whether a file exists,
// `{ file, contains }` whether its text matches a multiline pattern. 07 adds
// `{ file, pointer [, equals] }` and `{ onPath }` here and in the parser together: the set is closed,
// so a predicate outside it refuses the file instead of being ignored.
export interface FileExistsCheck {
  file: string
}

export interface FileContainsCheck {
  file: string
  contains: string
}

export type Check = FileExistsCheck | FileContainsCheck

// One `(provision, harness)` as the file spells it, before any path is resolved against a tier root.
export interface DeclaredEntry {
  harness: HarnessId
  check: Check
  install: string
}

// One `[provision.<name>]` table. `tags` filter and are not identity.
export interface ProvisionDeclaration {
  name: string
  tags: string[]
  entries: DeclaredEntry[]
}

// One `(provision, harness)` after the loader applied its tier's root: `check.file` is absolute and
// `source` is the environment file the entry came from.
export interface ResolvedProvision {
  name: string
  tags: string[]
  harness: HarnessId
  tier: EnvironmentTier
  // The Tier's root, which is what a relative path in this entry means and where its Install
  // command starts. The loader is the only module that knows it, so it travels with the entry
  // instead of being derived a second time.
  root: string
  source: string
  check: Check
  install: string
}

// A refusal locates the declaration at fault, so a typo is a line to edit rather than a file to
// reread. Line and column are 1-based and point at the key or the table header that is wrong.
export interface Refusal {
  line: number
  column: number
  reason: string
}

export interface FileRefusal extends Refusal {
  source: string
}

export type ParseResult =
  | { ok: true; provisions: ProvisionDeclaration[] }
  | { ok: false; refusal: Refusal }

// One harness's answer for one Provision: where the entry came from, what a Check said, and why when
// it could not say. A Provision with no entry for a harness has no such row at all.
export interface HarnessPresence {
  harness: HarnessId
  tier: EnvironmentTier
  presence: Presence
  detail: string | null
}

// The row both faces print. 04 runs from it, 05 records it, 08 and 09 read it, so it carries the
// resolved answers rather than a re-readable pointer.
export interface ProvisionRow {
  name: string
  tags: string[]
  harnesses: HarnessPresence[]
}

// One Check's answer, before the row learns which harness and tier it belongs to.
export interface CheckAnswer {
  presence: Presence
  detail: string | null
}
