import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { digestOfBytes } from '../engine/digest.ts'
import { deleteTomlKey, writePointer } from '../engine/edit.ts'
import { environmentFiles } from './loader.ts'
import { parseEnvironmentFile } from './parse.ts'
import type { DefineOutcome } from './define.ts'
import type { EnvironmentTier } from './types.ts'

// One tier's declared harness list, written as the top-level `harnesses` key of that tier's
// environment file. The list replaces the file's own whole — it is never merged — and an empty
// list clears the key, which is how a file declares no harnesses again. The parser validates the
// result before anything reaches disk, so a list that would invalidate an existing entry is
// refused with its reason and the file is left as it was.

export interface DeclareRequest {
  // Required, never defaulted, for the same reason a definition's is: an unreviewed write cannot
  // land in a committed file by accident — the caller has to say which file it belongs in.
  tier: EnvironmentTier
  // The whole list, replacing whatever the file declares. An empty list removes the key.
  harnesses: string[]
}

// The same three outcomes a definition answers with: a write that landed, a candidate the loader
// would refuse, and a file the editor cannot address.
export type DeclareOutcome = DefineOutcome

const VERSION_ROOT = 'version = 1\n'

export function declareHarnesses(
  request: DeclareRequest,
  config: EngineConfig = resolveDefaultConfig(),
): DeclareOutcome {
  const location = environmentFiles(config).find((candidate) => candidate.tier === request.tier)
  // A tier outside the closed list names no file, so the declaration is refused rather than thrown:
  // every other bad write answers with a reason, and this one does too.
  if (location === undefined) {
    return { kind: 'failed', reason: `no environment file for tier ${request.tier}` }
  }

  const existing = existsSync(location.file) ? readFileSync(location.file, 'utf8') : ''
  // A file that is not there declares nothing, and the loader reads a missing file that way. A file
  // with no bytes is the same nothing, so the root is written before the first declaration rather
  // than the write being refused by a version that was never anybody's fault.
  const text = existing.trim() === '' ? VERSION_ROOT : existing

  // The file as it stands is the loader's business first: a file it refuses is not one to add a
  // list to, and its refusal already names the line to fix.
  const before = parseEnvironmentFile(text)
  if (!before.ok) return { kind: 'refused', refusal: before.refusal }

  // An empty list clears the key rather than writing `harnesses = []`: both read as no declared
  // harnesses, and a file that never had the key is byte-identical to one that had it removed.
  // An empty list clears the key rather than writing `harnesses = []`: both read as no declared
  // harnesses, and a file that never had the key is byte-identical to one that had it removed.
  let written = text
  if (request.harnesses.length === 0) {
    written = deleteTomlKey(text, 'harnesses')
  } else {
    const declared = writePointer(text, 'toml', ['harnesses'], request.harnesses)
    if (declared.kind === 'failed') return declared
    written = declared.text
  }

  // The same parser the loader runs, over the bytes that would land: a list that leaves an entry
  // naming a harness it does not declare is refused here, with that reason, and the file is left
  // as it was.
  const after = parseEnvironmentFile(written)
  if (!after.ok) return { kind: 'refused', refusal: after.refusal }

  mkdirSync(path.dirname(location.file), { recursive: true })
  writeFileSync(location.file, written)
  return {
    kind: 'defined',
    tier: request.tier,
    file: location.file,
    pointer: 'harnesses',
    digest: digestOfBytes(Buffer.from(written)),
  }
}
