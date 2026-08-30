import fs from 'node:fs/promises'
import path from 'node:path'
import type { CloudData, LocalData } from '../types/dashboard'

const DATABASE_DIR = path.join(process.cwd(), 'database')

async function readJson<T>(fileName: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path.join(DATABASE_DIR, fileName), 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function readLocalData() {
  return readJson<LocalData>('local.json')
}

export function readCloudData() {
  return readJson<CloudData>('cloud.json')
}
