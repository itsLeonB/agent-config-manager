import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { openStore } from './store.cjs'
import type { Store } from './store.cjs'
import type { RescanResult } from '../types/dashboard'

const DATABASE_DIR = path.join(process.cwd(), 'database')
const STORE_FILE = path.join(DATABASE_DIR, 'dashboard.db')
const SCANNER = path.join(process.cwd(), 'scan.cjs')
const SCAN_TIMEOUT_MS = 120_000
const execFileAsync = promisify(execFile)

let store: Store | null = null

function getStore(): Store {
  store ??= openStore(STORE_FILE)
  return store
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

export function readLocalData() {
  const data = getStore().readLatestSnapshot('local')
  return data !== null && localDataValidator.safeParse(data).success ? data : null
}

// The scanner stores a cloud snapshot whenever /refresh-cloud rewrites
// cloud.json; null means the operator has never run that command.
export function readCloudData() {
  return getStore().readLatestSnapshot('cloud')
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
    return { ok: false, error: 'Scan finished but the stored snapshot is unreadable.' }
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
