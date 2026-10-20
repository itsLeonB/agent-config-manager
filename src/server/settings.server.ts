import os from 'node:os'
import path from 'node:path'
import type { z } from 'zod'
import {
  environmentToolsSchema,
  projectsRootSchema,
  scanIntervalSchema,
  skipPathsSchema,
} from '../lib/settings'
import type { Settings } from '../lib/settings'
import { getStore } from './dashboard.server'

// shortcut: these two defaults are mirrored in scan.cjs's resolveConfig, which the
// scanner uses when no value is stored; change both together.
const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), 'Projects')
const DEFAULT_SCAN_INTERVAL_MINUTES = 15

const DEFAULT_SETTINGS: Settings = {
  projectsRoot: DEFAULT_PROJECTS_ROOT,
  scanIntervalMinutes: DEFAULT_SCAN_INTERVAL_MINUTES,
  skipPaths: [],
  environmentTools: [],
}

// A stored value that no longer validates falls back on its own, so one bad key
// never hides the others.
function readStored<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  const parsed = schema.safeParse(getStore().readConfig(key))
  return parsed.success ? parsed.data : fallback
}

export function readSettings(): Settings {
  return {
    projectsRoot: readStored('projectsRoot', projectsRootSchema, DEFAULT_SETTINGS.projectsRoot),
    scanIntervalMinutes: readStored(
      'scanIntervalMinutes',
      scanIntervalSchema,
      DEFAULT_SETTINGS.scanIntervalMinutes,
    ),
    skipPaths: readStored('skipPaths', skipPathsSchema, DEFAULT_SETTINGS.skipPaths),
    environmentTools: readStored('environmentTools', environmentToolsSchema, DEFAULT_SETTINGS.environmentTools),
  }
}

// The scanner re-reads these keys at the start of every scan, so no restart is
// needed for a save to take effect.
export function writeSettings(settings: Settings): void {
  const store = getStore()
  store.writeConfig('projectsRoot', settings.projectsRoot)
  store.writeConfig('scanIntervalMinutes', settings.scanIntervalMinutes)
  store.writeConfig('skipPaths', settings.skipPaths)
  store.writeConfig('environmentTools', settings.environmentTools)
}
