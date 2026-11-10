import test from 'node:test'
import assert from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { EngineConfig } from '../config.ts'
import { digestOfPath } from '../digest.ts'
import { readInstructionTier } from './instructions.ts'
import { nativeTier } from './native-paths.ts'
import { readSkillTier } from './skills.ts'
import type { HarnessId, Tier, TierRead } from './types.ts'

// Seam B: a skill root and an instruction file are the whole input to these readers, so each test
// writes the bytes a harness would load and asserts the declarations they answer with.

function fixture(): EngineConfig {
  const root = mkdtempSync(path.join(tmpdir(), 'acm-skills-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  return { home, projectRoot, storePath: path.join(root, 'store', 'dashboard.db') }
}

// Every tier comes from the one path table, so a location added there is a location these readers are
// asked about without a second list in the test.
function tier(config: EngineConfig, harness: HarnessId, tierId: string): Tier {
  const found = nativeTier(config, harness, tierId)
  assert.ok(found !== undefined, `${harness} declares no tier ${tierId}`)
  return found
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const SKILL_FACTS = z.object({ files: z.array(z.string()) })
const INSTRUCTION_FACTS = z.object({ body: z.string() })

function factsOf<Schema extends z.ZodType>(read: TierRead, schema: Schema, index = 0): z.infer<Schema> {
  const declaration = read.declarations[index]
  assert.ok(declaration !== undefined, `nothing was read at index ${index}`)
  return schema.parse(JSON.parse(declaration.factsJson))
}

// One skill root, three harnesses: all of them implement the Agent Skills spec, so the same directory
// answers the same declaration through each one's own tier.
test('every harness reads a skill from the shared root, named by its directory', () => {
  const config = fixture()
  const skill = path.join(config.home, '.agents', 'skills', 'review')
  write(path.join(skill, 'SKILL.md'), '---\nname: review\n---\n\nRead this.\n')
  write(path.join(skill, 'scripts', 'run.sh'), '#!/bin/sh\n')

  for (const harness of ['pi', 'codex', 'opencode'] satisfies HarnessId[]) {
    const read = readSkillTier(tier(config, harness, `${harness === 'opencode' ? 'oc' : harness}:user`))
    assert.equal(read.health, 'ok', `${harness} could not read the shared root`)
    assert.deepEqual(read.declarations, [
      {
        category: 'skills',
        name: 'review',
        tierId: `${harness === 'opencode' ? 'oc' : harness}:user`,
        nativeFile: skill,
        // The directory is the whole location, so there is no address inside a file.
        nativePointer: '',
        factsJson: JSON.stringify({ files: ['SKILL.md', 'scripts/run.sh'] }),
        contentDigest: digestOfPath(skill),
      },
    ])
    assert.deepEqual(factsOf(read, SKILL_FACTS).files, ['SKILL.md', 'scripts/run.sh'])
  }
})

// A directory without a `SKILL.md` is not a skill. A loose file beside it is not one either, and
// neither is a reason to call the root unreadable.
test('a directory that carries no SKILL.md is not a skill', () => {
  const config = fixture()
  const root = path.join(config.home, '.agents', 'skills')
  write(path.join(root, 'notes', 'README.md'), 'not a skill\n')
  write(path.join(root, 'loose.md'), 'a file where a directory was expected\n')

  const read = readSkillTier(tier(config, 'pi', 'pi:user'))
  assert.deepEqual(read, { health: 'ok', detail: null, declarations: [] })
})

// A root that exists and cannot be listed is the one case that is not "nothing here": the skills
// inside it were not looked at. A file where the root should be fails the listing on any uid, so the
// test does not depend on a permission bit root may ignore.
test('a skill root that cannot be listed makes the tier unreadable', () => {
  const config = fixture()
  const root = path.join(config.home, '.agents', 'skills')
  write(root, 'not a directory\n')

  const read = readSkillTier(tier(config, 'pi', 'pi:user'))
  assert.equal(read.health, 'unreadable')
  assert.match(read.detail ?? '', /could not be read/)
  assert.ok((read.detail ?? '').includes(root), 'the detail does not name the root')
  assert.deepEqual(read.declarations, [])
})

// One instruction file per harness, at the location that harness declares: the declaration is the
// file's address, and its body is what the file says.
test('every harness reads its own instruction file, whole', () => {
  const config = fixture()
  const files = {
    pi: path.join(config.home, '.pi', 'agent', 'AGENTS.md'),
    codex: path.join(config.home, '.codex', 'AGENTS.md'),
    opencode: path.join(config.home, '.config', 'opencode', 'AGENTS.md'),
  }
  for (const [harness, file] of Object.entries(files)) {
    write(file, `# AGENTS\n\nInstructions for ${harness}.\n`)
  }

  for (const harness of ['pi', 'codex', 'opencode'] satisfies HarnessId[]) {
    const tierId = `${harness === 'opencode' ? 'oc' : harness}:user`
    const file = files[harness]
    const read = readInstructionTier(tier(config, harness, tierId))
    assert.deepEqual(read, {
      health: 'ok',
      detail: null,
      declarations: [
        {
          category: 'instructions',
          name: 'AGENTS.md',
          tierId,
          nativeFile: file,
          nativePointer: '',
          factsJson: JSON.stringify({ body: `# AGENTS\n\nInstructions for ${harness}.\n` }),
          contentDigest: digestOfPath(file),
        },
      ],
    })
    assert.match(factsOf(read, INSTRUCTION_FACTS).body, new RegExp(`Instructions for ${harness}\\.`))
  }
})

// An instruction file is a credential-bearing whole file: a token in the middle of prose is withheld
// as its marker rather than carried into the declaration an agent reads.
test('an instruction body that carries a credential is withheld', () => {
  const config = fixture()
  write(
    path.join(config.home, '.pi', 'agent', 'AGENTS.md'),
    '# AGENTS\n\nexport GITHUB_TOKEN=ghp_012345678901234567890123456789012345\n',
  )
  const read = readInstructionTier(tier(config, 'pi', 'pi:user'))

  assert.equal(read.health, 'ok')
  const [declaration] = read.declarations
  assert.ok(declaration !== undefined)
  assert.equal(declaration.factsJson.includes('ghp_'), false, 'the token reached the declaration')
  assert.equal(factsOf(read, INSTRUCTION_FACTS).body, '[withheld: secret]')
})
