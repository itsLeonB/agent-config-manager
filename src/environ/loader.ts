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

// The committed file's name, and the `.local` suffix that tells the gitignored one apart in a
// directory listing and in the ignore rule.
const ENVIRONMENT_FILE = 'agents_environ.toml'
const ENVIRONMENT_LOCAL_FILE = 'agents_environ.local.toml'

// The one place that knows where a tier's environment file lives and what its root is. The order is
// the precedence order: a later location shadows an earlier one, so nothing else learns that a
// third file exists.
export function environmentFiles(config: EngineConfig): EnvironmentFileLocation[] {
  return [
    { tier: 'user', file: path.join(config.home, ENVIRONMENT_FILE), root: config.home },
    { tier: 'project', file: path.join(config.projectRoot, ENVIRONMENT_FILE), root: config.projectRoot },
    {
      tier: 'project-local',
      file: path.join(config.projectRoot, ENVIRONMENT_LOCAL_FILE),
      root: config.projectRoot,
    },
  ]
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

// A Check's file is declared against the tier's root and every other part of the predicate is a
// value, so re-pointing a Check is replacing the one path it holds; `onPath` names no file at all.
function resolveCheck(check: Check, root: string, home: string): Check {
  if (!('file' in check)) return check
  return { ...check, file: resolveDeclaredPath(check.file, root, home) }
}

export interface Environment {
  provisions: ResolvedProvision[]
  refusals: FileRefusal[]
}

// The identity of one entry in the environment: `(provision, harness)`, which is the key the merge
// shadows by and the key a Run is read by. NUL cannot appear in a Provision name or a harness id, so
// two keys cannot collide.
export function entryKey(provision: string, harness: string): string {
  return `${provision}\u0000${harness}`
}

// One entry where the file that won it declared it: the precedence of that file, and the entry's
// position in it, so a run keeps the winning file's order instead of the order the tiers were read.
interface PlacedProvision {
  provision: ResolvedProvision
  precedence: number
  position: number
}

function keyOf(provision: ResolvedProvision): string {
  return entryKey(provision.name, provision.harness)
}

// The user file is read always; a tier with no file declares nothing. A file that cannot be read or
// does not parse contributes nothing and leaves the other tiers loading, with the fault reported
// rather than swallowed.
//
// Merge is per `(provision, harness)` key with `project-local` > `project` > `user`. The nearer file
// replaces the entry whole, tags included: every field below is built from the winning declaration,
// so nothing is inherited field by field from the entry it shadowed and no entry is half one tier
// and half another.
export function loadEnvironment(config: EngineConfig): Environment {
  const won = new Map<string, PlacedProvision>()
  const refusals: FileRefusal[] = []
  for (const [precedence, location] of environmentFiles(config).entries()) {
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
    let position = 0
    for (const declaration of parsed.provisions) {
      for (const entry of declaration.entries) {
        const provision: ResolvedProvision = {
          name: declaration.name,
          tags: declaration.tags,
          harness: entry.harness,
          tier: location.tier,
          // What a relative `install` path means: the runner starts every command here, so the text
          // of one command reads the same at two tiers.
          root: location.root,
          source: location.file,
          check: resolveCheck(entry.check, location.root, config.home),
          install: entry.install,
        }
        won.set(keyOf(provision), { provision, precedence, position })
        position += 1
      }
    }
  }
  const ordered = [...won.values()].sort(
    (left, right) => left.precedence - right.precedence || left.position - right.position,
  )
  return { provisions: ordered.map((placed) => placed.provision), refusals }
}
