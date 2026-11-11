import type { NativeValue } from '../engine/native-value.ts'

// The environment file is the source of truth, so the types below follow it: what one file
// declares, what the loader resolves it to, and the rows the CLI and MCP faces print. The words are
// CONTEXT.md's — Provision, Check, Presence, Install command, Tier, Harness.

// A tier is where an environment file lives and nothing else; no entry names one. The list is the
// loader's file table: `user` is the home file, `project` the committed project file.
export const ENVIRONMENT_TIERS = ['user', 'project'] as const
export type EnvironmentTier = (typeof ENVIRONMENT_TIERS)[number]

// An unanswered question is never reported as an absence, so the third value exists from the start:
// a Check that could not read or parse what it names answers `unknown` with a detail, never `absent`.
export const PRESENCES = ['present', 'absent', 'unknown'] as const
export type Presence = (typeof PRESENCES)[number]

// A Check is the inline table the file spells. `{ file }` asks whether a file exists,
// `{ file, contains }` whether its text matches a multiline pattern, `{ file, pointer [, equals] }`
// whether a native config holds a value at an address, `{ file, pointer, includes }` whether the
// array at an address holds a value, `{ file, section }` whether a Section of the file holds the
// Payload's text, and `{ onPath }` whether a name is an executable file on PATH. The set is closed:
// a predicate outside it refuses the file instead of being ignored, and a new
// one is a schema change.
export interface FileExistsCheck {
  file: string
}

export interface FileContainsCheck {
  file: string
  contains: string
}

// `pointer` is the address inside `file`, spelled the same way for a JSON pointer and a TOML dotted
// key because one reader derives the format from the file's extension. `equals` compares the value at
// that address by deep equality, which is what keeps an entry that is there but switched off
// (`enabled = false`) from counting as installed; `includes` asks whether the array at the address
// holds a deeply equal element. Both are any TOML value, and one Check holds one of them.
export interface FilePointerCheck {
  file: string
  pointer: string
  equals?: NativeValue
  includes?: NativeValue
}

// The one predicate that names no file: a name looked up on PATH.
export interface OnPathCheck {
  onPath: string
}

// `section` names a Payload: the Section of `file` whose `## ` heading is the Payload's first
// `## ` line, compared with the Payload's text byte for byte after trailing blank lines are
// stripped from both sides.
export interface FileSectionCheck {
  file: string
  section: string
}

export type Check = FileExistsCheck | FileContainsCheck | FilePointerCheck | FileSectionCheck | OnPathCheck

// A Payload is where an Install command too long to read inline lives: the file its text is in, and
// the arguments that reach it as argv, never substituted into its text. A type alias, not an
// interface: the alias's implicit index signature is what lets the editor write one as a TOML value.
export type PayloadInstall = {
  payload: string
  args?: string[]
}

// An install that rewrites one Section of a native file: the Payload's text replaces the Section
// its heading spells, appends it when the Section is missing, and creates the file when the file
// is missing. A type alias for the same editor reason as PayloadInstall.
export type SectionInstall = {
  file: string
  section: string
}

// An Install command is either the text spelled in the file, the Payload that holds it, or the
// native file and Payload a Section write names.
export type InstallCommand = string | PayloadInstall | SectionInstall

// One `[provision.<name>.<harness>]` table. `checks` and `install` are the entry's own — possibly
// neither, when the Provision's shared declarations cover it; an entry that ends up with no
// effective Check or Install command refuses the file. `check = { … }` is read as a one-element
// list, so a file written before that spelling keeps loading.
export interface DeclaredEntry {
  harness: string
  checks: Check[]
  install: InstallCommand | null
}

// One `[provision.<name>]` table. `tags` filter and are not identity. `checks` and `install` are
// the shared declarations every harness entry inherits — the entry's effective Checks are the
// shared ones plus its own, and its effective Install commands are the shared one plus its own.
export interface ProvisionDeclaration {
  name: string
  tags: string[]
  checks: Check[]
  install: InstallCommand | null
  entries: DeclaredEntry[]
}

// One `(provision, harness)` after the loader applied its tier's root and folded the shared
// declarations in: `checks` is every Check the entry answers to, `install` its own Install command
// or null, `sharedInstall` the Provision's shared one or null — the runner needs them apart because
// the shared command runs at most once per Provision per run. Every Check's `file` and a Payload's
// path are absolute and `source` is the environment file the entry came from.
export interface ResolvedProvision {
  name: string
  tags: string[]
  harness: string
  tier: EnvironmentTier
  // The Tier's root, which is what a relative path in this entry means and where its Install
  // command starts. The loader is the only module that knows it, so it travels with the entry
  // instead of being derived a second time.
  root: string
  source: string
  checks: Check[]
  install: InstallCommand | null
  sharedInstall: InstallCommand | null
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
  | { ok: true; provisions: ProvisionDeclaration[]; harnesses: string[] }
  | { ok: false; refusal: Refusal }

// One harness's answer for one Provision: where the entry came from, what its Checks said folded,
// and why when a Check could not answer. A Provision with no entry for a harness has no such row.
export interface HarnessPresence {
  harness: string
  tier: EnvironmentTier
  source: string
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

// One Check's answer, and the same shape an entry's folded answer takes: `detail` is the reason a
// Check did not answer `present` — why it is absent, or why it could not be evaluated.
export interface CheckAnswer {
  presence: Presence
  detail: string | null
}

// One Run: a single executed Install command, recorded when it ended. There is deliberately no field
// for the command's stdout or stderr — a command that prints a token must not put it in the store —
// and `exitCode` is null when a signal, not a shell, ended the command.
export interface Run {
  at: string
  provision: string
  harness: string
  tier: EnvironmentTier
  command: string
  exitCode: number | null
  presence: Presence
}

// One harness's row in the `--json` document: the Presence the status pass just read, plus the most
// recent Run recorded for that (Provision, harness) when the caller asked for history. An entry that
// was never installed carries no `latestRun` key at all.
export interface RunPresenceRow extends HarnessPresence {
  latestRun?: Run
}

export interface ProvisionDocumentRow {
  name: string
  tags: string[]
  harnesses: RunPresenceRow[]
}
