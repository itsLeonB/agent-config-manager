import type { Json, LocalData } from '../types/dashboard'

// Each kind stores the snapshot type the dashboard already renders, so readers get
// that type back without a cast. The store itself only round-trips JSON.
export interface Store {
  saveSnapshot(kind: 'local', data: LocalData): void
  readLatestSnapshot(kind: 'local'): LocalData | null
  writeConfig(key: string, value: Json): void
  readConfig(key: string): Json | null
  close(): void
}

export function openStore(filePath: string): Store
