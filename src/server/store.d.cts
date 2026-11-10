import type { Json, LocalData } from '../types/dashboard'

// The store only round-trips JSON; typing the 'local' kind means readers get LocalData
// back without a cast.
export interface Store {
  saveSnapshot(kind: 'local', data: LocalData): void
  readLatestSnapshot(kind: 'local'): LocalData | null
  writeConfig(key: string, value: Json): void
  readConfig(key: string): Json | null
  close(): void
}

export function openStore(filePath: string): Store
