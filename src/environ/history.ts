import { existsSync } from 'node:fs'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { openStore } from '../server/store.cjs'
import { installCommand } from './loader.ts'
import type { Presence, ResolvedProvision, Run } from './types.ts'

// The environment's one caller of the store, and the only place a Run is read or written. It is not
// a face: the CLI and the MCP router reach it through `service.ts` and never learn a database
// exists, and the store module keeps its exclusive claim on `node:sqlite`.
//
// A Run is written when its command ends rather than at the end of the run, so an interrupted run
// keeps the rows of the commands that had already finished with no recovery pass to write them
// later.

export function recordRun(
  provision: ResolvedProvision,
  exitCode: number | null,
  presence: Presence,
  config: EngineConfig = resolveDefaultConfig(),
): void {
  const store = openStore(config.storePath)
  try {
    store.recordRun({
      at: new Date().toISOString(),
      provision: provision.name,
      harness: provision.harness,
      tier: provision.tier,
      // The command that ran, spelled: the Payload path followed by its arguments when there is
      // one. The bytes a Payload held are what ran, never what is recorded.
      command: installCommand(provision.install),
      exitCode,
      presence,
    })
  } finally {
    store.close()
  }
}

// A machine that has never run `acm install` has no store, and opening one would create a database
// as a side effect of a read.
export function latestRuns(config: EngineConfig = resolveDefaultConfig()): Run[] {
  if (!existsSync(config.storePath)) return []
  const store = openStore(config.storePath)
  try {
    return store.readLatestRuns()
  } finally {
    store.close()
  }
}
