import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { CloudData, LocalData, RescanResult } from '../types/dashboard'

const DATABASE_DIR = path.join(process.cwd(), 'database')
const SCANNER = path.join(process.cwd(), 'scan.cjs')
const SCAN_TIMEOUT_MS = 120_000
const execFileAsync = promisify(execFile)

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

// The scanner runs under the same interpreter as this server (Bun in dev, Node in the
// container), so one spawn path covers both.
async function spawnScanner() {
  await execFileAsync(process.execPath, [SCANNER], {
    cwd: process.cwd(),
    timeout: SCAN_TIMEOUT_MS,
  })
}

async function scanOnce(): Promise<RescanResult> {
  try {
    await spawnScanner()
  } catch (error) {
    // execFile's message is the whole of stderr, so surface the first line that actually
    // names the failure instead of a stack frame or the command it ran.
    const lines = error instanceof Error
      ? error.message
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : []
    const detail =
      lines.find((line) => line.toLowerCase().startsWith('error')) ??
      lines.find((line) => !line.startsWith('Command failed:'))
    return { ok: false, error: detail ?? 'Scanner failed.' }
  }

  const local = await readLocalData()
  if (local === null) {
    return { ok: false, error: 'Scan finished but database/local.json is unreadable.' }
  }

  return {
    ok: true,
    counts: {
      generatedAt: local.generatedAt,
      plugins: local.userScope.plugins.length,
      mcpServers: Object.keys(local.userScope.mcpServers).length,
      skills: local.userScope.skills.length,
      projects: local.projects.length,
    },
  }
}

let inFlightScan: Promise<RescanResult> | null = null

// Concurrent callers join the running scan instead of starting a second scanner.
export function runScan(): Promise<RescanResult> {
  inFlightScan ??= scanOnce().finally(() => {
    inFlightScan = null
  })
  return inFlightScan
}
