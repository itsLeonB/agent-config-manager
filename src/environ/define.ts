import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { digestOfBytes } from '../engine/digest.ts'
import { tomlPath, writePointer } from '../engine/edit.ts'
import type { NativeValue } from '../engine/native-value.ts'
import { environmentFiles } from './loader.ts'
import { parseEnvironmentFile } from './parse.ts'
import type { EnvironmentTier, ProvisionDeclaration, Refusal } from './types.ts'

// One Provision's Check and Install command for one harness, written into the environment file its
// tier names. Nothing here runs the command or evaluates the Check: the only effect is bytes in a
// file, and the file's own validator decides whether those bytes are a definition ACM can load.

export interface DefineRequest {
  name: string
  harness: string
  tier?: EnvironmentTier
  // The Check as the file spells it, passed through rather than re-shaped here: the parser owns the
  // closed predicate set, so an unknown one is refused with the reason the loader would give.
  check: Record<string, NativeValue>
  install?: string
  tags?: string[]
}

export type DefineOutcome =
  | { kind: 'defined'; tier: EnvironmentTier; file: string; pointer: string; digest: string }
  // The candidate is not a file ACM would load, so nothing was written; the refusal is the parser's.
  | { kind: 'refused'; refusal: Refusal }
  // The editor cannot address this path in this file — an entry hand-written as an inline table, say.
  | { kind: 'failed'; reason: string }

const VERSION_ROOT = 'version = 1\n'

export function defineProvision(
  request: DefineRequest,
  config: EngineConfig = resolveDefaultConfig(),
): DefineOutcome {
  // An unreviewed definition lands in the gitignored file unless the caller says otherwise.
  const tier = request.tier ?? 'project-local'
  const location = environmentFiles(config).find((candidate) => candidate.tier === tier)
  // The tier list is closed and every member has a file, so a missing one is a bug, not an answer.
  if (location === undefined) throw new Error(`no environment file for tier ${tier}`)

  const existing = existsSync(location.file) ? readFileSync(location.file, 'utf8') : ''
  // A file that is not there declares nothing, and the loader reads a missing file that way. A file
  // with no bytes is the same nothing, so the root is written before the first definition rather
  // than the definition being refused by a version that was never anybody's fault.
  const text = existing.trim() === '' ? VERSION_ROOT : existing

  // The file as it stands is the loader's business first: a file it refuses is not one to add a
  // definition to, and its refusal already names the line to fix.
  const before = parseEnvironmentFile(text)
  if (!before.ok) return { kind: 'refused', refusal: before.refusal }

  const provision = ['provision', request.name]
  const entry = [...provision, request.harness]
  let written = text
  // `tags` filter and are not identity, so a write adds them where the Provision has none and never
  // takes one away: replacing a tag list is an edit for a human. They sit on the Provision's own
  // table, not on the harness entry the rest of this writes.
  if (request.tags !== undefined && request.tags.length > 0 && declaredTags(before.provisions, request.name).length === 0) {
    const tagged = writePointer(written, 'toml', [...provision, 'tags'], request.tags)
    if (tagged.kind === 'failed') return tagged
    written = tagged.text
  }

  // Two addresses, one entry: `check` is an inline table and `install` a string, so each is written
  // as the value it is, into the one table that holds them. Both writes read the document the other
  // produced, and the pair reaches disk as one file write.
  const check = writePointer(written, 'toml', [...entry, 'check'], request.check)
  if (check.kind === 'failed') return check
  written = check.text
  if (request.install !== undefined) {
    const install = writePointer(written, 'toml', [...entry, 'install'], request.install)
    if (install.kind === 'failed') return install
    written = install.text
  }
  // An entry that already carries an install keeps it when the caller names no new one: this writes
  // the fields it is given and leaves the rest of the file to its owner. A brand-new entry with no
  // install is refused by the parser below, which is exactly the file nobody could load.

  // The same parser the loader runs, over the bytes that would land: a definition the loader would
  // refuse is refused here, with that reason, and the file is left as it was.
  const after = parseEnvironmentFile(written)
  if (!after.ok) return { kind: 'refused', refusal: after.refusal }

  mkdirSync(path.dirname(location.file), { recursive: true })
  writeFileSync(location.file, written)
  return {
    kind: 'defined',
    tier,
    file: location.file,
    pointer: tomlPath(entry),
    digest: digestOfBytes(Buffer.from(written)),
  }
}

function declaredTags(provisions: ProvisionDeclaration[], name: string): string[] {
  return provisions.find((provision) => provision.name === name)?.tags ?? []
}
