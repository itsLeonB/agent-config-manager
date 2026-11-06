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

// shortcut: the project root is two directories above src/engine; a bundled dist entry has to
// compute its own root when the build lands.
export function resolveDefaultConfig(): EngineConfig {
  const home = process.env.ACM_HOME ?? os.homedir()
  const projectRoot = process.env.ACM_PROJECT_ROOT ?? path.resolve(MODULE_DIR, '..', '..')
  return {
    home,
    projectRoot,
    storePath: process.env.ACM_STORE ?? path.join(projectRoot, 'database', 'dashboard.db'),
    codexHome: process.env.CODEX_HOME ?? path.join(home, '.codex'),
  }
}
