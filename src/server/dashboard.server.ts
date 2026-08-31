import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CloudData, LocalData } from '../types/dashboard'

const DATABASE_DIR = path.join(process.cwd(), 'database')

async function readJson<T>(fileName: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path.join(DATABASE_DIR, fileName), 'utf-8')
    // SAFETY: database/*.json is written only by this app's own scan.cjs / /refresh-cloud
    // automation, never by external/untrusted input; readLocalData re-validates the shape
    // it depends on below before returning it.
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const localDataValidator = z.looseObject({
  generatedAt: z.string(),
  userScope: z.looseObject({
    plugins: z.array(z.unknown()),
    skills: z.array(z.unknown()),
  }),
  npxSkillsGlobal: z.unknown(),
  environmentTools: z.array(z.unknown()),
  projects: z.array(z.unknown()),
})

export async function readLocalData() {
  const data = await readJson<LocalData>('local.json')
  return data !== null && localDataValidator.safeParse(data).success ? data : null
}

export function readCloudData() {
  return readJson<CloudData>('cloud.json')
}
