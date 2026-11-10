import type { Run } from '../environ/types.ts'
import type { Json, LocalData } from '../types/dashboard'

// The store only round-trips JSON; typing the 'local' kind means readers get LocalData
// back without a cast.
export interface Store {
  saveSnapshot(kind: 'local', data: LocalData): void
  readLatestSnapshot(kind: 'local'): LocalData | null
  writeConfig(key: string, value: Json): void
  readConfig(key: string): Json | null
  // One Run per executed Install command, written when that command ends. The record carries no
  // command output and the table has no column for it.
  recordRun(run: Run): void
  // The most recent Run for every (Provision, harness) the history holds.
  readLatestRuns(): Run[]
  close(): void
}

export function openStore(filePath: string): Store
