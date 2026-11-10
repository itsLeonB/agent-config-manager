import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { EngineConfig } from '../engine/config.ts'
import { parseEnvironmentFile } from './parse.ts'
import type { Check, EnvironmentTier, FileRefusal, ResolvedProvision } from './types.ts'

// The loader answers what the environment declares: one entry per Provision and harness, with its
// tier, its resolved Check, its Install command, and the file it came from. It reads environment
// files and nothing else — a Check's file is read where the answer is evaluated.

export interface EnvironmentFileLocation {
  tier: EnvironmentTier
  file: string
  root: string
}

// The one place that knows where a tier's environment file lives and what its root is. 06 adds the
// two project files here and nothing outside this function learns that a third one exists.
export function environmentFiles(config: EngineConfig): EnvironmentFileLocation[] {
  return [{ tier: 'user', file: path.join(config.home, 'agents_environ.toml'), root: config.home }]
}

// A leading `~` or `/` is absolute; anything else resolves against the tier's root, which is what
// lets the same Provision text mean the project's file in a project file and the home directory in
// the home file. `~someone` is not a form this reads, so it stays a relative path.
export function resolveDeclaredPath(declared: string, root: string, home: string): string {
  if (declared === '~') return home
  if (declared.startsWith('~/')) return path.join(home, declared.slice(2))
  if (path.isAbsolute(declared)) return declared
  return path.resolve(root, declared)
}

export interface Environment {
  provisions: ResolvedProvision[]
  refusals: FileRefusal[]
}

// The user file is read always; a tier with no file declares nothing. A file that cannot be read or
// does not parse contributes nothing and leaves the other tiers loading, with the fault reported
// rather than swallowed.
export function loadEnvironment(config: EngineConfig): Environment {
  const provisions: ResolvedProvision[] = []
  const refusals: FileRefusal[] = []
  for (const location of environmentFiles(config)) {
    if (!existsSync(location.file)) continue
    let text: string
    try {
      text = readFileSync(location.file, 'utf8')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      refusals.push({ source: location.file, line: 1, column: 1, reason: `cannot be read: ${reason}` })
      continue
    }
    const parsed = parseEnvironmentFile(text)
    if (!parsed.ok) {
      refusals.push({ source: location.file, ...parsed.refusal })
      continue
    }
    for (const declaration of parsed.provisions) {
      for (const entry of declaration.entries) {
        const file = resolveDeclaredPath(entry.check.file, location.root, config.home)
        const check: Check = 'contains' in entry.check ? { file, contains: entry.check.contains } : { file }
        provisions.push({
          name: declaration.name,
          tags: declaration.tags,
          harness: entry.harness,
          tier: location.tier,
          source: location.file,
          check,
          install: entry.install,
        })
      }
    }
  }
  return { provisions, refusals }
}
