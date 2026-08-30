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

function isValidLocalData(data: unknown): data is LocalData {
  if (!data || typeof data !== 'object') return false
  const d = data as Partial<LocalData>
  return (
    typeof d.generatedAt === 'string' &&
    !!d.userScope &&
    Array.isArray(d.userScope.plugins) &&
    Array.isArray(d.userScope.skills) &&
    !!d.npxSkillsGlobal &&
    Array.isArray(d.environmentTools) &&
    Array.isArray(d.projects)
  )
}

export async function readLocalData() {
  const data = await readJson<LocalData>('local.json')
  return isValidLocalData(data) ? data : null
}

export function readCloudData() {
  return readJson<CloudData>('cloud.json')
}
