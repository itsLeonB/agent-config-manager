import type { CloudData, Json, LocalData } from '../types/dashboard'

// Each kind stores the snapshot type the dashboard already renders, so readers get
// that type back without a cast. The store itself only round-trips JSON.
export interface Store {
  saveSnapshot(kind: 'local', data: LocalData): void
  saveSnapshot(kind: 'cloud', data: CloudData): void
  readLatestSnapshot(kind: 'local'): LocalData | null
  readLatestSnapshot(kind: 'cloud'): CloudData | null
  writeConfig(key: string, value: Json): void
  readConfig(key: string): Json | null
  writeComment(key: string, text: string): void
  readComment(key: string): string | null
  readComments(): Record<string, string>
  close(): void
}

export function openStore(filePath: string): Store
