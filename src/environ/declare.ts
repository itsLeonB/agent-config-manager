import { commitEnvironmentWrite, openEnvironmentForWrite } from './define.ts'
import type { DefineOutcome } from './define.ts'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { deleteTomlKey, writePointer } from '../engine/edit.ts'
import type { EnvironmentTier } from './types.ts'

// One tier's declared harness list, written as the top-level `harnesses` key of that tier's
// environment file. The list replaces the file's own whole — it is never merged — and an empty
// list clears the key, which is how a file declares no harnesses again. The parser validates the
// result before anything reaches disk, so a list that would invalidate an existing entry is
// refused with its reason and the file is left as it was. The read-validate-write sequence is the
// one `define_provision` shares, so the two cannot drift apart.

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

export function declareHarnesses(
  request: DeclareRequest,
  config: EngineConfig = resolveDefaultConfig(),
): DeclareOutcome {
  const target = openEnvironmentForWrite(request.tier, config)
  if ('kind' in target) return target

  // An empty list clears the key rather than writing `harnesses = []`: both read as no declared
  // harnesses, and a file that never had the key is byte-identical to one that had it removed.
  let written = target.text
  if (request.harnesses.length === 0) {
    written = deleteTomlKey(target.text, 'harnesses')
  } else {
    const declared = writePointer(target.text, 'toml', ['harnesses'], request.harnesses)
    if (declared.kind === 'failed') return declared
    written = declared.text
  }

  return commitEnvironmentWrite(target, written, request.tier, 'harnesses')
}
