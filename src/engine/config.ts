import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Everything the engine touches on disk is injected: a fixture home plus a temporary database is
// the only environment a test needs. The working directory is read once, here, when the default
// config is resolved.
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

// A symlinked path and its target are one directory, so both are recorded under the same root and
// one project keeps one set of rows. A path that does not resolve is kept as given: the override
// points at a directory acm will fail to read anyway, which is the caller's error to see.
function canonical(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

// The project is the one the harness was opened in, taken exactly as given and never walked up to a
// repository marker: the pass reads the layers the harness in front of it read. `CLAUDE_PROJECT_DIR`
// is in the chain because Claude Code starts a user-scope MCP server in its own config directory.
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  return canonical(process.env.ACM_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? cwd)
}

export function resolveDefaultConfig(): EngineConfig {
  const home = process.env.ACM_HOME ?? os.homedir()
  // The store is anchored on where acm is installed, not on the project being read, so every project
  // shares one store instead of forking a database into each one.
  const installRoot = deriveProjectRoot(MODULE_DIR)
  const projectRoot = resolveProjectRoot()
  return {
    home,
    projectRoot,
    storePath: process.env.ACM_STORE ?? path.join(installRoot, 'database', 'dashboard.db'),
    codexHome: process.env.CODEX_HOME ?? path.join(home, '.codex'),
  }
}
