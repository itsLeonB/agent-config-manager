import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { digestOfPath, relativeFiles } from '../digest.ts'
import { declaredPaths, type DiscoveredInstallation, type Tier, type TierRead } from './types.ts'

// A skill's canonical vocabulary is its own file listing. Everything else about it — the frontmatter,
// the scripts, the assets — is content, so it travels by copy and an unknown key survives there
// instead of becoming a gap.
export const SKILL_FIELDS = ['files'] as const

interface SkillFacts {
  files: string[]
}

// All three harnesses implement the Agent Skills spec, so one reader serves all three: only the
// directories each tier declares differ (`~/.agents/skills` is shared, `~/.pi/agent/skills` is not).
export function readSkillTier(tier: Tier): TierRead {
  const installations: DiscoveredInstallation[] = []
  for (const root of declaredPaths(tier, 'skills')) {
    if (!existsSync(root)) continue
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      return { health: 'unreadable', detail: `${root} could not be read`, installations: [] }
    }
    for (const name of names.sort()) {
      // A directory is a skill only when it carries a `SKILL.md`, so a loose file in the root is not
      // one and a package manager's symlinked skill is (the existence test follows the link).
      const installation = skillInstallation(tier, path.join(root, name))
      if (installation !== null) installations.push(installation)
    }
  }
  return { health: 'ok', detail: null, installations }
}

// A directory is a skill when it carries a `SKILL.md`; the name is the directory's, because that is
// both the address it is loaded under and the name a mirror reproduces in the shared location.
function skillInstallation(tier: Tier, dir: string): DiscoveredInstallation | null {
  const facts = skillFacts(dir)
  if (facts === null) return null
  return {
    category: 'skills',
    name: path.basename(dir),
    scope: tier.scopeBucket,
    tierId: tier.id,
    nativeFile: dir,
    nativePointer: '',
    knownFieldsJson: JSON.stringify(facts),
    contentDigest: digestOfPath(dir) ?? '',
  }
}

function skillFacts(dir: string): SkillFacts | null {
  if (!existsSync(path.join(dir, 'SKILL.md'))) return null
  try {
    return { files: relativeFiles(dir) }
  } catch {
    return null
  }
}
