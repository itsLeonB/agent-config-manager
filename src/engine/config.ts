import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Everything the engine touches on disk is injected: a fixture home plus a temporary database is
// the only environment a test needs, and no call site reads the working directory.
export interface EngineConfig {
  home: string
  projectRoot: string
  storePath: string
  // A harness may relocate its own config root (`CODEX_HOME`). It is resolved here, at the
  // boundary, so no adapter reads the environment.
  codexHome?: string
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

// The engine runs from `src/engine/config.ts` or from the built single-file bundle, at a depth the
// build chooses, so the project root is the nearest directory that owns a package.json rather than
// a counted number of parents: both entry forms land on the same root and therefore the same store.
export function deriveProjectRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    // A filesystem root has no parent, so a build outside any package keeps its own directory.
    if (path.dirname(dir) === dir) return from
  }
}

export function resolveDefaultConfig(): EngineConfig {
  const home = process.env.ACM_HOME ?? os.homedir()
  const projectRoot = process.env.ACM_PROJECT_ROOT ?? deriveProjectRoot(MODULE_DIR)
  return {
    home,
    projectRoot,
    storePath: process.env.ACM_STORE ?? path.join(projectRoot, 'database', 'dashboard.db'),
    codexHome: process.env.CODEX_HOME ?? path.join(home, '.codex'),
  }
}
