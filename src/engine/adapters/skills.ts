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

// A directory without a `SKILL.md` is simply not a skill; a directory the scan cannot list is a
// different answer, because reporting it as absent would tombstone what it hides.
type SkillListing =
  | { kind: 'skill'; facts: SkillFacts }
  | { kind: 'notASkill' }
  | { kind: 'unreadable'; detail: string }

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
      const dir = path.join(root, name)
      const listing = skillListing(dir)
      if (listing.kind === 'unreadable') {
        return { health: 'unreadable', detail: listing.detail, installations: [] }
      }
      if (listing.kind === 'notASkill') continue
      installations.push(skillInstallation(tier, dir, listing.facts))
    }
  }
  return { health: 'ok', detail: null, installations }
}

// A directory is a skill when it carries a `SKILL.md`; the name is the directory's, because that is
// both the address it is loaded under and the name a mirror reproduces in the shared location.
function skillInstallation(
  tier: Tier,
  dir: string,
  facts: SkillFacts,
): DiscoveredInstallation {
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

function skillListing(dir: string): SkillListing {
  // A loose file in the root carries no `SKILL.md`, so the existence test is the whole check; it
  // follows a link, because a package manager may install a skill as one.
  if (!existsSync(path.join(dir, 'SKILL.md'))) return { kind: 'notASkill' }
  try {
    return { kind: 'skill', facts: { files: relativeFiles(dir) } }
  } catch {
    return { kind: 'unreadable', detail: `${dir} could not be listed` }
  }
}
