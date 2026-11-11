import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { digestOfBytes } from '../engine/digest.ts'
import { ensureTomlTable, readPointer, tomlPath, writePointer } from '../engine/edit.ts'
import type { EditResult } from '../engine/edit.ts'
import type { NativeValue } from '../engine/native-value.ts'
import { environmentFiles } from './loader.ts'
import { harnessesKeyPlace, parseEnvironmentFile } from './parse.ts'
import type { EnvironmentTier, InstallCommand, ParseResult, ProvisionDeclaration, Refusal } from './types.ts'

// One Provision's Check and Install command for one harness, written into the environment file its
// tier names. Nothing here runs the command or evaluates the Check: the only effect is bytes in a
// file, and the file's own validator decides whether those bytes are a definition ACM can load.

export interface DefineRequest {
  name: string
  harness: string
  // Required, never defaulted: an unreviewed definition cannot land in a committed file by
  // accident — the caller has to say which file it belongs in.
  tier: EnvironmentTier
  // One Check as the file spells it, written `check = { … }`: the singular spelling stays legal, so
  // a file with one Check keeps the shape it had, and a same-key write against an entry that spells
  // `checks` replaces that list with the one element. Passed through rather than re-shaped here: the
  // parser owns the closed predicate set, so an unknown one is refused with the reason the loader
  // would give.
  check?: Record<string, NativeValue>
  // Several Checks, written `checks = [ … ]`; a one-element list against an entry that spells
  // `check` replaces that singular Check. A request names one of the two; the validator after
  // the write refuses one that names both or neither, with that reason.
  checks?: Record<string, NativeValue>[]
  // Optional because the Provision's shared Install command or the entry's existing one can cover
  // it; the parser after the write refuses a definition that leaves the entry with no effective
  // Install command. A Payload form `{ payload [, args] }` or a Section form `{ file, section }` is
  // written as the table the file spells, and the validator after the write owns both shapes.
  install?: InstallCommand
  // The Provision's shared declarations, written on `[provision.<name>]` rather than the entry:
  // every harness entry inherits them, and a same-key write replaces those keys only.
  sharedChecks?: Record<string, NativeValue>[]
  sharedInstall?: InstallCommand
  tags?: string[]
}

export type DefineOutcome =
  | { kind: 'defined'; tier: EnvironmentTier; file: string; pointer: string; digest: string }
  // The candidate is not a file ACM would load, so nothing was written; the refusal is the parser's.
  | { kind: 'refused'; refusal: Refusal }
  // The editor cannot address this path in this file — an entry hand-written as an inline table, say.
  | { kind: 'failed'; reason: string }

const VERSION_ROOT = 'version = 1\n'

function resolvedWritePath(file: string, seen = new Set<string>()): string {
  const absolute = path.resolve(file)
  if (existsSync(absolute)) return realpathSync(absolute)
  if (seen.has(absolute)) throw new Error(`environment file has a symlink cycle: ${absolute}`)
  seen.add(absolute)
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return resolvedWritePath(path.resolve(path.dirname(absolute), readlinkSync(absolute)), seen)
  }
  return path.join(resolvedWritePath(path.dirname(absolute), seen), path.basename(absolute))
}

// Both writers hold the same file lock from the first read through the validated atomic rename.
export interface EnvironmentWriteTarget {
  file: string
  text: string
  // The file as the loader reads it now, so a request is checked against what is declared before
  // anything is written.
  environment: Extract<ParseResult, { ok: true }>
}

export function withEnvironmentWrite(
  tier: EnvironmentTier,
  config: EngineConfig,
  edit: (target: EnvironmentWriteTarget) => DefineOutcome,
): DefineOutcome {
  const location = environmentFiles(config).find((candidate) => candidate.tier === tier)
  // A tier outside the closed list names no file, so the write is refused rather than thrown:
  // every other bad write answers with a reason, and this one does too.
  if (location === undefined) {
    return { kind: 'failed', reason: `no environment file for tier ${tier}` }
  }

  try {
    const destination = resolvedWritePath(location.file)
    const user = environmentFiles(config).find((candidate) => candidate.tier === 'user')
    if (tier === 'project' && user !== undefined && destination === resolvedWritePath(user.file)) {
      return { kind: 'failed', reason: 'the project environment file is also the user environment file; use the user tier' }
    }
    mkdirSync(path.dirname(destination), { recursive: true })
    // shortcut: a killed writer leaves its lock; add stale-lock recovery if automatic retry is needed.
    const lock = `${destination}.lock`
    let descriptor: number
    try {
      descriptor = openSync(lock, 'wx', 0o600)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return { kind: 'failed', reason: `environment file is locked: ${location.file}; retry after the other writer finishes` }
      }
      throw error
    }
    try {
      const target = openEnvironmentForWrite(location.file)
      return 'kind' in target ? target : edit(target)
    } finally {
      closeSync(descriptor)
      unlinkSync(lock)
    }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

function openEnvironmentForWrite(file: string): EnvironmentWriteTarget | Exclude<DefineOutcome, { kind: 'defined' }> {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  // A file that is not there declares nothing, and the loader reads a missing file that way. A file
  // with no bytes is the same nothing, so the root is written before the first definition rather
  // than the definition being refused by a version that was never anybody's fault.
  const text = existing.trim() === '' ? VERSION_ROOT : existing

  // The file as it stands is the loader's business first: a file it refuses is not one to add a
  // definition to, and its refusal already names the line to fix.
  const parsed = parseEnvironmentFile(text)
  if (!parsed.ok) return { kind: 'refused', refusal: parsed.refusal }
  return { file, text, environment: parsed }
}

// The second half of the sequence: the candidate bytes get the same parse the loader runs, and
// only what it would accept reaches disk — as one file write, never a partial one.
export function commitEnvironmentWrite(
  target: EnvironmentWriteTarget,
  written: string,
  tier: EnvironmentTier,
  pointer: string,
): DefineOutcome {
  const after = parseEnvironmentFile(written)
  if (!after.ok) return { kind: 'refused', refusal: after.refusal }

  const destination = resolvedWritePath(target.file)
  mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = path.join(path.dirname(destination), `.agents-environ-${randomUUID()}.tmp`)
  const mode = existsSync(destination) ? statSync(destination).mode & 0o777 : undefined
  const descriptor = openSync(temporary, 'wx', mode ?? 0o666)
  try {
    try {
      writeFileSync(descriptor, written)
      if (mode !== undefined) chmodSync(temporary, mode)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, destination)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return {
    kind: 'defined',
    tier,
    file: target.file,
    pointer,
    digest: digestOfBytes(Buffer.from(written)),
  }
}

export function defineProvision(
  request: DefineRequest,
  config: EngineConfig = resolveDefaultConfig(),
): DefineOutcome {
  return withEnvironmentWrite(request.tier, config, (target) => defineAtTarget(request, target))
}

function defineAtTarget(request: DefineRequest, target: EnvironmentWriteTarget): DefineOutcome {
  const before = target.environment
  const text = target.text

  // The file's own harness list is the constraint the parser enforces on a hand edit, so a
  // definition is held to it before anything is written: a name the list does not carry is a
  // refusal with the parser's reason, reported at the list's own key.
  if (before.harnesses.length > 0 && !before.harnesses.includes(request.harness)) {
    const at = harnessesKeyPlace(text)
    return {
      kind: 'refused',
      refusal: {
        line: at?.line ?? 1,
        column: at?.column ?? 1,
        reason: `harness '${request.harness}' is not one of this file's harnesses: ${before.harnesses.join(', ')}`,
      },
    }
  }

  const provision = ['provision', request.name]
  const entry = [...provision, request.harness]
  const hasEntryFields = request.check !== undefined || request.checks !== undefined || request.install !== undefined
  let written = text
  // The editor's own reader answers which spelling the entry's Checks have now. A brand-new entry
  // takes the request's spelling; an existing one keeps the file's: `check` found means the singular
  // spelling (or a `check` table of its own, which the writer refuses as it always did), `missing`
  // the list spelling.
  const declared = before.provisions
    .flatMap((provision) => (provision.name === request.name ? provision.entries : []))
    .find((candidate) => candidate.harness === request.harness)
  const spelledSingular =
    declared !== undefined && readPointer(written, 'toml', tomlPath([...entry, 'check'])).kind === 'found'
  // `tags` filter and are not identity, so a write adds them where the Provision has none and never
  // takes one away: replacing a tag list is an edit for a human. They sit on the Provision's own
  // table, not on the harness entry the rest of this writes.
  if (request.tags !== undefined && request.tags.length > 0 && declaredTags(before.provisions, request.name).length === 0) {
    const tagged = writePointer(written, 'toml', [...provision, 'tags'], request.tags)
    if (tagged.kind === 'failed') return tagged
    written = tagged.text
  }

  // The shared declarations sit on the Provision's own table and every entry inherits them. They
  // keep the file's Check spelling the way an entry does: a singular `check` takes one element, and
  // several against it is a hand edit because the pointer editor cannot delete the old key.
  if (request.sharedChecks !== undefined) {
    const declaredProvision = before.provisions.find((candidate) => candidate.name === request.name)
    const spelledSingular =
      declaredProvision !== undefined &&
      readPointer(written, 'toml', tomlPath([...provision, 'check'])).kind === 'found'
    const checks = writeChecks(written, provision, request.sharedChecks, spelledSingular)
    if (checks.kind === 'failed') return checks
    written = checks.text
  }
  if (request.sharedInstall !== undefined) {
    const install = writePointer(written, 'toml', [...provision, 'install'], request.sharedInstall)
    if (install.kind === 'failed') return install
    written = install.text
  }

  // Two addresses, one entry: the Checks are tables and `install` a string, so each is written as
  // the value it is, into the one table that holds them. A same-key write keeps the entry's
  // spelling: a singular `check` replaces a `checks` list with that list's one element, and a
  // one-element `checks` replaces a singular `check` with that element, so the file never ends up
  // holding both keys, which the parser refuses. A request that names both writes both, and the
  // parser below refuses the file with its own reason rather than this module picking one. All the
  // writes read the document the previous one produced, and the set reaches disk as one file write.
  if (request.check !== undefined && request.checks !== undefined) {
    const check = writePointer(written, 'toml', [...entry, 'check'], request.check)
    if (check.kind === 'failed') return check
    written = check.text
    const checks = writePointer(written, 'toml', [...entry, 'checks'], request.checks)
    if (checks.kind === 'failed') return checks
    written = checks.text
  } else if (request.check !== undefined) {
    // An existing entry that spells a list keeps it, with the one Check as its single element; a new
    // entry and a singular one take the spelling the request used.
    const asList = declared !== undefined && !spelledSingular
    const pointer = asList ? [...entry, 'checks'] : [...entry, 'check']
    const value: NativeValue = asList ? [request.check] : request.check
    const check = writePointer(written, 'toml', pointer, value)
    if (check.kind === 'failed') return check
    written = check.text
  } else if (request.checks !== undefined) {
    const checks = writeChecks(written, entry, request.checks, spelledSingular)
    if (checks.kind === 'failed') return checks
    written = checks.text
  }
  if (request.install !== undefined) {
    const install = writePointer(written, 'toml', [...entry, 'install'], request.install)
    if (install.kind === 'failed') return install
    written = install.text
  } else if (!hasEntryFields) {
    // An entry with no fields of its own is still declared: the empty table is what makes the
    // harness's Presence row exist when the shared declarations cover it.
    const table = ensureTomlTable(written, entry)
    if (table.kind === 'failed') return table
    written = table.text
  }

  return commitEnvironmentWrite(target, written, request.tier, tomlPath(entry))
}

// A checks list keeps the spelling the table already has: `checks = [ … ]` stays a list, and a
// singular `check = { … }` takes the list's one element. Several Checks against the singular
// spelling cannot be written, because replacing it would need a delete the pointer editor does not
// do — that is a hand edit, not a definition.
function writeChecks(
  written: string,
  base: string[],
  checks: Record<string, NativeValue>[],
  spelledSingular: boolean,
): EditResult {
  if (!spelledSingular) return writePointer(written, 'toml', [...base, 'checks'], checks)
  const one = checks[0]
  if (checks.length !== 1 || one === undefined) {
    return {
      kind: 'failed',
      reason: `${tomlPath(base)} spells its Check as one check = { … }; replacing it with several Checks is a hand edit`,
    }
  }
  return writePointer(written, 'toml', [...base, 'check'], one)
}

function declaredTags(provisions: ProvisionDeclaration[], name: string): string[] {
  return provisions.find((provision) => provision.name === name)?.tags ?? []
}
