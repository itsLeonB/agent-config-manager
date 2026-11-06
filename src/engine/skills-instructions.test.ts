import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineConfig } from './config.ts'
import { digestOfPath } from './digest.ts'
import { planIdOf, type MirrorPlan, type PlanValue, type PlanWrite } from './plan.ts'
import { applyPlan, discover, listInstallations, planMirror, verifyPlanDocument } from './service.ts'

// A fixture home, a fixture project, and a temporary database: the whole environment these tests
// need. The skill and instruction locations are the real ones, under the fixture home.
function fixture(): EngineConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-shared-test-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  for (const dir of [
    [home, '.pi', 'agent'],
    [projectRoot, '.pi'],
    [home, '.codex'],
    [projectRoot, '.codex'],
    [home, '.config', 'opencode'],
    [projectRoot, '.opencode'],
  ]) {
    fs.mkdirSync(path.join(...dir), { recursive: true })
  }
  return { home, projectRoot, storePath: path.join(root, 'dashboard.db') }
}

function sharedSkills(config: EngineConfig): string {
  return path.join(config.home, '.agents', 'skills')
}

function userAgentMd(config: EngineConfig): string {
  return path.join(config.home, '.pi', 'agent', 'AGENTS.md')
}

function codexAgentMd(config: EngineConfig): string {
  return path.join(config.home, '.codex', 'AGENTS.md')
}

function projectAgentMd(config: EngineConfig): string {
  return path.join(config.projectRoot, 'AGENTS.md')
}

interface SkillFixture {
  description?: string
  extra?: string
  script?: string
}

// A skill is a directory with a `SKILL.md`; `extra` is a frontmatter key no harness names, which a
// copy has to keep.
function writeSkill(dir: string, fixture: SkillFixture = {}): void {
  fs.mkdirSync(dir, { recursive: true })
  const frontmatter = [
    '---',
    'name: review',
    `description: ${fixture.description ?? 'Review a diff'}`,
    ...(fixture.extra === undefined ? [] : [fixture.extra]),
    '---',
    '',
    '# Review',
    '',
    'Read the diff, then the code it touches.',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter)
  if (fixture.script !== undefined) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), fixture.script)
  }
}

function applyAndVerify(config: EngineConfig, planned: MirrorPlan) {
  const applied = applyPlan(config, planned)
  assert.equal(applied.outcome, 'applied', applied.reason ?? '')
  const verified = verifyPlanDocument(config, planned)
  assert.equal(verified.kind, 'ok', verified.kind === 'refused' ? verified.reason : '')
  return { applied, verification: verified.kind === 'ok' ? verified.verification : null }
}

function plan(config: EngineConfig, nativeFile: string, target: string): MirrorPlan {
  const row = listInstallations(config, {}).installations.find(
    (candidate) => candidate.nativeFile === nativeFile,
  )
  assert.ok(row, `nothing discovered at ${nativeFile}`)
  const result = planMirror(config, row.id, target)
  assert.equal(result.kind, 'plan', result.kind === 'refused' ? result.reason : '')
  return result.kind === 'plan' ? result.plan : assert.fail('unreachable')
}

test('a mirrored skill lands in the shared location, and is one installation with three bindings', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill, { extra: 'custom_key: keep-me', script: '#!/bin/sh\necho hi\n' })
  discover(config)

  const planned = plan(config, piSkill, 'codex:user')

  // One copy, into the location all three harnesses read, carrying no bytes in the document.
  assert.equal(planned.category, 'skills')
  assert.equal(planned.writes.length, 1)
  const [write] = planned.writes
  assert.ok(write !== undefined && write.op === 'copyFile')
  assert.equal(write.file, path.join(sharedSkills(config), 'review'))
  assert.equal(write.source, piSkill)
  assert.equal(write.sourceDigest, digestOfPath(piSkill))
  // A copy and a new directory are both risk conditions, so no client applies this unanswered.
  assert.equal(planned.security.grade, 'risky')

  const { verification } = applyAndVerify(config, planned)
  assert.equal(verification?.outcome, 'verified')

  // The bytes are the source's, unknown frontmatter key and script included.
  const copied = fs.readFileSync(path.join(sharedSkills(config), 'review', 'SKILL.md'), 'utf8')
  assert.match(copied, /custom_key: keep-me/)
  assert.equal(fs.readFileSync(path.join(sharedSkills(config), 'review', 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n')
  // And the assertion is the copied content, by digest.
  assert.deepEqual(planned.verify.asserts, [
    { file: path.join(sharedSkills(config), 'review'), digest: digestOfPath(piSkill) },
  ])

  // The row the apply left behind is the one the shared directory now holds, and its verification
  // rides on the binding the plan wrote for.
  const applied = listInstallations(config, { category: 'skills', scope: 'user' }).installations.find(
    (row) => row.nativeFile === path.join(sharedSkills(config), 'review'),
  )
  assert.ok(applied)
  assert.equal(
    applied.bindings.find((binding) => binding.tierId === 'codex:user')?.verificationStatus,
    'verified',
  )

  // One row for the shared directory, one binding per harness that loads it.
  discover(config)
  const shared = listInstallations(config, { category: 'skills', scope: 'user' }).installations.find(
    (row) => row.nativeFile === path.join(sharedSkills(config), 'review'),
  )
  assert.ok(shared)
  assert.deepEqual(
    shared.bindings.map((binding) => binding.tierId).sort(),
    ['codex:user', 'oc:user', 'pi:user'],
  )
})

test('mirroring the same skill into another harness returns already shared and writes nothing', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  discover(config)
  applyAndVerify(config, plan(config, piSkill, 'codex:user'))
  discover(config)

  const shared = path.join(sharedSkills(config), 'review')
  const before = digestOfPath(shared)
  const planned = plan(config, shared, 'oc:user')

  assert.equal(planned.disposition.kind, 'alreadyShared')
  assert.deepEqual(planned.writes, [])
  assert.deepEqual(planned.conflicts, [])
  assert.deepEqual(planned.verify.asserts, [])
  // Nothing was written: the directory is the same one.
  assert.equal(digestOfPath(shared), before)
  assert.equal(fs.readdirSync(path.join(sharedSkills(config))).length, 1)
  // And a harness that reads the shared location says so, even with nothing to write.
  assert.deepEqual([...planned.target.alsoReadBy].sort(), ['codex', 'pi'])
})

test('a copy names the other harnesses that read the location it lands in', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  discover(config)

  const planned = plan(config, piSkill, 'codex:user')

  // `.agents/skills` is shared, so the write is not a Codex-only write.
  assert.deepEqual([...planned.target.alsoReadBy].sort(), ['opencode', 'pi'])
})

test('a skill carrying a credential is a gap with a manual step, never a copy', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  fs.appendFileSync(path.join(piSkill, 'SKILL.md'), '\ntoken = sk-proj-AbCdEfGhIjKlMnOpQrStUvWx\n')
  discover(config)

  const planned = plan(config, piSkill, 'codex:user')

  assert.deepEqual(planned.writes, [])
  assert.deepEqual(planned.equivalence.gaps, [
    { field: 'SKILL.md', reason: 'credential', replacement: 'dropped' },
  ])
  assert.deepEqual(planned.security.secrets, [{ pointer: 'SKILL.md', verdict: 'secret' }])
  assert.equal(planned.manualSteps.length, 1)
  // The value never reaches the plan document, which is what makes it safe to hand around.
  assert.equal(JSON.stringify(planned).includes('sk-proj'), false)
})

test('a differing skill at the target is a conflict, and a copy of a moved source is stale', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  writeSkill(path.join(sharedSkills(config), 'review'), { description: 'somebody else wrote this one' })
  discover(config)

  const conflicting = plan(config, piSkill, 'oc:user')
  assert.deepEqual(conflicting.writes, [])
  assert.equal(conflicting.conflicts.length, 1)
  assert.equal(conflicting.conflicts[0]?.file, path.join(sharedSkills(config), 'review'))

  // The shared location is free again once the conflicting directory is out of the way.
  fs.rmSync(path.join(sharedSkills(config), 'review'), { recursive: true, force: true })
  const planned = plan(config, piSkill, 'codex:user')
  fs.appendFileSync(path.join(piSkill, 'SKILL.md'), '\nchanged after planning\n')

  const applied = applyPlan(config, planned)
  assert.equal(applied.outcome, 'stale')
  assert.match(applied.reason ?? '', /changed since the plan was built/)
  assert.equal(fs.existsSync(path.join(sharedSkills(config), 'review')), false)
})

test('a user-scope instruction file is linked into each harness; a project one is already present', () => {
  const config = fixture()
  const body = '# House rules\n\nRun `bun run check` before you commit.\n'
  fs.writeFileSync(codexAgentMd(config), body)
  discover(config)

  // Same scope bucket, so the spec's one permitted link: the target shows the source's content.
  const linked = plan(config, codexAgentMd(config), 'pi:user')
  assert.equal(linked.category, 'instructions')
  const [linkWrite] = linked.writes
  assert.ok(linkWrite !== undefined && linkWrite.op === 'symlink')
  assert.equal(linkWrite.file, userAgentMd(config))
  assert.equal(linkWrite.source, codexAgentMd(config))
  assert.deepEqual(linked.verify.asserts, [{ file: userAgentMd(config), digest: digestOfPath(codexAgentMd(config)) }])

  const { verification } = applyAndVerify(config, linked)
  assert.equal(verification?.outcome, 'verified')
  assert.equal(fs.lstatSync(userAgentMd(config)).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(userAgentMd(config), 'utf8'), body)

  // A second harness gets its own file at its own user scope, not a second copy of the shared one.
  discover(config)
  const openCode = plan(config, userAgentMd(config), 'oc:user')
  assert.equal(openCode.writes.length, 1)
  assert.equal(openCode.writes[0]?.op, 'symlink')
  assert.equal(openCode.writes[0]?.file, path.join(config.home, '.config', 'opencode', 'AGENTS.md'))

  // The project instruction file is the same file for all three, so it is written once…
  const project = plan(config, codexAgentMd(config), 'oc:project')
  const [projectWrite] = project.writes
  assert.ok(projectWrite !== undefined && projectWrite.op === 'writeFile')
  assert.equal(projectWrite.file, projectAgentMd(config))
  assert.equal(projectWrite.content, body)
  // …and a write there lands somewhere every harness reads.
  assert.deepEqual([...project.target.alsoReadBy].sort(), ['codex', 'pi'])
  applyAndVerify(config, project)
  assert.equal(fs.readFileSync(projectAgentMd(config), 'utf8'), body)

  // …and mirroring it into a second harness writes nothing at all.
  discover(config)
  const projectRow = listInstallations(config, { category: 'instructions', scope: 'project' }).installations
  assert.equal(projectRow.length, 1)
  assert.deepEqual(
    projectRow[0]?.bindings.map((binding) => binding.tierId).sort(),
    ['codex:project', 'oc:project', 'pi:project'],
  )
  const again = plan(config, projectAgentMd(config), 'pi:project')
  assert.equal(again.disposition.kind, 'alreadyPresent')
  assert.deepEqual(again.writes, [])
  assert.deepEqual(again.conflicts, [])
})

test('an instruction file holding a credential is a gap, and its body never enters the plan', () => {
  const config = fixture()
  fs.writeFileSync(codexAgentMd(config), '# Rules\n\napi_token = hunter2hunter2\n')
  discover(config)

  const planned = plan(config, codexAgentMd(config), 'pi:user')

  assert.deepEqual(planned.writes, [])
  assert.deepEqual(planned.equivalence.gaps, [{ field: 'body', reason: 'credential', replacement: 'dropped' }])
  assert.deepEqual(planned.equivalence.carried, [])
  assert.equal(planned.manualSteps.length, 1)
  assert.equal(JSON.stringify(planned).includes('hunter2'), false)
  // The stored row withholds it too, so an inspection cannot print it either.
  const row = listInstallations(config, { category: 'instructions' }).installations[0]
  assert.equal(row?.knownFieldsJson.includes('hunter2'), false)
})

// A plan is content-addressed, so a hand-made one is stamped the way the planner stamps it: the same
// integrity check apply runs, never a bypass of it.
function resign(planned: MirrorPlan, writes: PlanWrite[]): MirrorPlan {
  const body: Record<string, PlanValue> = JSON.parse(JSON.stringify({ ...planned, writes }))
  delete body.planId
  return { ...planned, writes, planId: planIdOf(body) }
}

test('a link to somewhere outside the engine roots is refused, even inside a valid document', () => {
  const config = fixture()
  fs.writeFileSync(codexAgentMd(config), '# Rules\n')
  discover(config)
  const planned = plan(config, codexAgentMd(config), 'pi:user')
  const [link] = planned.writes
  assert.ok(link !== undefined && link.op === 'symlink')

  const outside = applyPlan(config, resign(planned, [{ ...link, source: '/etc/passwd' }]))

  assert.equal(outside.outcome, 'refused')
  assert.match(outside.reason ?? '', /outside the home directory and the project root/)
  assert.equal(fs.existsSync(userAgentMd(config)), false)
})

test('a differing instruction file needs replacement asked for explicitly', () => {
  const config = fixture()
  const body = '# House rules\n\nRun `bun run check` before you commit.\n'
  fs.writeFileSync(codexAgentMd(config), body)
  fs.writeFileSync(projectAgentMd(config), '# Somebody else wrote this\n')
  discover(config)

  const planned = plan(config, codexAgentMd(config), 'oc:project')
  assert.equal(planned.conflicts.length, 1)
  assert.equal(planned.writes.length, 1)

  // The default is a refusal that shows both digests; nothing on disk moves.
  const refused = applyPlan(config, planned)
  assert.equal(refused.outcome, 'refused')
  assert.match(refused.reason ?? '', /disagree with this plan/)
  assert.equal(fs.readFileSync(projectAgentMd(config), 'utf8'), '# Somebody else wrote this\n')

  const replaced = applyPlan(config, planned, { onConflict: 'replace' })
  assert.equal(replaced.outcome, 'applied', replaced.reason ?? '')
  assert.equal(fs.readFileSync(projectAgentMd(config), 'utf8'), body)
})

test('a harness-owned skill directory is a source, never a place a plan may write', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  discover(config)
  const planned = plan(config, piSkill, 'codex:user')
  const [copy] = planned.writes
  assert.ok(copy !== undefined && copy.op === 'copyFile')

  // The read root is declared, but it is not the target a mirror lands in.
  const outside = applyPlan(
    config,
    resign(planned, [{ ...copy, file: path.join(config.home, '.pi', 'agent', 'skills', 'other') }]),
  )

  assert.equal(outside.outcome, 'refused')
  assert.match(outside.reason ?? '', /declares for skills/)
  assert.equal(fs.existsSync(path.join(config.home, '.pi', 'agent', 'skills', 'other')), false)
})

test('a differing skill cannot be replaced, and the refusal says to remove it by hand', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  writeSkill(path.join(sharedSkills(config), 'review'), { description: 'somebody else wrote this one' })
  discover(config)

  const planned = plan(config, piSkill, 'codex:user')

  const replaced = applyPlan(config, planned, { onConflict: 'replace' })
  assert.equal(replaced.outcome, 'refused')
  assert.match(replaced.reason ?? '', /remove it by hand/)
  assert.equal(planned.manualSteps.some((step) => step.step.includes('by hand')), true)
})

test('a project skill copy names the trust gate that makes it inert', () => {
  const config = fixture()
  const projectSkill = path.join(config.projectRoot, '.pi', 'skills', 'review')
  writeSkill(projectSkill)
  discover(config)

  const planned = plan(config, projectSkill, 'pi:project')

  assert.equal(planned.permissions.trust, 'required')
  assert.match(planned.manualSteps.map((step) => step.step).join(' '), /trust this project in Pi/)
  // The copy still lands; what it cannot claim is that Pi loads it yet.
  const { verification } = applyAndVerify(config, planned)
  assert.equal(verification?.outcome, 'unverified')
})

test('a same-directory instruction file that outranks the target is named as a step', () => {
  const config = fixture()
  fs.writeFileSync(codexAgentMd(config), '# Rules\n')
  fs.writeFileSync(path.join(config.home, '.pi', 'agent', 'CLAUDE.md'), '# Pi reads this first\n')
  discover(config)

  const planned = plan(config, codexAgentMd(config), 'pi:user')

  const steps = planned.manualSteps.map((step) => step.step).join(' ')
  assert.match(steps, /CLAUDE\.md/)
})

test('a link inside a copied skill that points outside the roots refuses the copy', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  const outside = path.join(os.tmpdir(), `acm-outside-${process.pid}.md`)
  fs.writeFileSync(outside, 'not part of the skill\n')
  fs.symlinkSync(outside, path.join(piSkill, 'elsewhere.md'))
  discover(config)

  const planned = plan(config, piSkill, 'codex:user')
  const applied = applyPlan(config, planned)

  assert.equal(applied.outcome, 'refused')
  assert.match(applied.reason ?? '', /links to .* and .* outside the home directory and the project root/)
  assert.equal(fs.existsSync(path.join(sharedSkills(config), 'review')), false)
  fs.rmSync(outside, { force: true })
})

test('a credential in any text file of a skill stops the copy, not just in SKILL.md', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  fs.mkdirSync(path.join(piSkill, 'references'))
  fs.writeFileSync(
    path.join(piSkill, 'references', 'api.md'),
    'Use the key ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789\n',
  )
  discover(config)

  const planned = plan(config, piSkill, 'codex:user')

  assert.deepEqual(planned.writes, [])
  assert.deepEqual(planned.equivalence.carried, [])
  assert.deepEqual(planned.equivalence.gaps, [
    { field: 'references/api.md', reason: 'credential', replacement: 'dropped' },
  ])
  assert.deepEqual(planned.security.secrets, [{ pointer: 'references/api.md', verdict: 'secret' }])
  assert.equal(JSON.stringify(planned).includes('ghp_'), false)
})

test('a skill directory whose entry point cannot be read is refused, not copied', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  // A directory named `SKILL.md` exists but yields no text: the skill cannot be described.
  fs.mkdirSync(path.join(piSkill, 'SKILL.md'), { recursive: true })
  discover(config)

  const row = listInstallations(config, {}).installations.find(
    (candidate) => candidate.nativeFile === piSkill,
  )
  assert.ok(row)
  const result = planMirror(config, row.id, 'codex:user')

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /cannot be read, so the skill cannot be described/)
})

test('an instruction source edited since the scan is refused instead of mirrored stale', () => {
  const config = fixture()
  fs.writeFileSync(codexAgentMd(config), '# Rules\n\none\n')
  discover(config)
  fs.appendFileSync(codexAgentMd(config), '\ntwo\n')

  const result = planMirror(
    config,
    listInstallations(config, {}).installations.find((row) => row.nativeFile === codexAgentMd(config))?.id ??
      '',
    'pi:user',
  )

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /changed since the last scan/)
})

test('an oversized shared instruction file is unverified even with nothing to write', () => {
  const config = fixture()
  const body = `# House rules\n\n${'x'.repeat(40 * 1024)}\n`
  fs.writeFileSync(codexAgentMd(config), body)
  fs.writeFileSync(projectAgentMd(config), body)
  discover(config)

  const planned = plan(config, codexAgentMd(config), 'oc:project')

  assert.equal(planned.disposition.kind, 'alreadyPresent')
  assert.deepEqual(planned.writes, [])
  assert.match(planned.manualSteps.map((step) => step.step).join(' '), /project_doc_max_bytes/)
  const verified = verifyPlanDocument(config, planned)
  assert.equal(verified.kind === 'ok' ? verified.verification.outcome : 'refused', 'unverified')
})

test('an OpenCode-only target is not warned about an adjacent CLAUDE.md', () => {
  const config = fixture()
  const body = '# Rules\n'
  fs.writeFileSync(codexAgentMd(config), body)
  fs.writeFileSync(path.join(config.home, '.config', 'opencode', 'CLAUDE.md'), '# OpenCode ignores this\n')
  discover(config)

  const planned = plan(config, codexAgentMd(config), 'oc:user')

  assert.equal(planned.writes[0]?.op, 'symlink')
  assert.equal(planned.manualSteps.some((step) => step.step.includes('CLAUDE.md')), false)
})

test('one file written two ways by one plan is refused before anything lands', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  discover(config)
  const planned = plan(config, piSkill, 'codex:user')
  const [copy] = planned.writes
  assert.ok(copy !== undefined && copy.op === 'copyFile')

  const mixed = applyPlan(
    config,
    resign(planned, [
      copy,
      {
        op: 'writeAtPointer',
        file: copy.file,
        pointer: 'SKILL.md',
        value: 'half a skill',
        precondition: { exists: false, digest: null },
        reversible: true,
        priorValue: null,
        executable: false,
        secretValues: false,
        irreversible: false,
      },
    ]),
  )

  assert.equal(mixed.outcome, 'refused')
  assert.match(mixed.reason ?? '', /written two ways by one plan/)
  assert.equal(fs.existsSync(copy.file), false)
})

test('a skill directory the scan cannot list makes the tier unreadable, and tombstones nothing', (t) => {
  // A root user reads through mode 0, so there is no listing failure to observe.
  if (process.getuid?.() === 0) return t.skip('root bypasses permissions')
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill, { script: '#!/bin/sh\n' })
  discover(config)
  const before = listInstallations(config, { category: 'skills' }).installations.length
  assert.equal(before, 1)

  const unreadable = path.join(piSkill, 'scripts')
  fs.chmodSync(unreadable, 0o000)
  try {
    const scan = discover(config)
    assert.equal(
      scan.tierHealth.find((health) => health.tierId === 'pi:user')?.status,
      'unreadable',
    )
    // An unreadable tier tombstones nothing: the skill it could not list is still in the inventory.
    const after = listInstallations(config, { category: 'skills' }).installations
    assert.equal(after.length, 1)
    assert.equal(after[0]?.removedAt, null)
  } finally {
    fs.chmodSync(unreadable, 0o755)
  }
})

test('a skill installed as a symlink lands as a real directory, keeping the links inside it', () => {
  const config = fixture()
  // What `npx skills` leaves on disk: the shared location holds a link, not a directory.
  const installed = path.join(config.home, 'installed', 'review')
  writeSkill(installed)
  fs.symlinkSync(path.join(installed, 'SKILL.md'), path.join(installed, 'alias.md'))
  fs.mkdirSync(path.join(config.home, '.pi', 'agent', 'skills'), { recursive: true })
  const link = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  fs.symlinkSync(installed, link)
  discover(config)

  const planned = plan(config, link, 'codex:user')
  const applied = applyPlan(config, planned)
  assert.equal(applied.outcome, 'applied', applied.reason ?? '')

  const target = path.join(sharedSkills(config), 'review')
  // The root is a directory of real files: a linked skill directory is the form no harness verifies.
  assert.equal(fs.lstatSync(target).isDirectory(), true)
  assert.equal(fs.lstatSync(path.join(target, 'SKILL.md')).isFile(), true)
  // The link the source holds inside the tree is reproduced as a link.
  assert.equal(fs.lstatSync(path.join(target, 'alias.md')).isSymbolicLink(), true)
})

test('a skill tree that gained a file since the scan is refused, not copied half-inspected', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  discover(config)
  fs.writeFileSync(path.join(piSkill, 'added-after-the-scan.md'), 'token = sk-proj-AbCdEfGhIjKlMnOpQrStUvWx\n')

  const result = planMirror(
    config,
    listInstallations(config, {}).installations.find((row) => row.nativeFile === piSkill)?.id ?? '',
    'codex:user',
  )

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /changed since the last scan/)
})

test('a dotfile with no extension is classified, and a binary asset is copied as it stands', () => {
  const config = fixture()
  const piSkill = path.join(config.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(piSkill)
  fs.writeFileSync(path.join(piSkill, '.env.example'), 'GITHUB_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789\n')
  discover(config)

  const planned = plan(config, piSkill, 'codex:user')
  assert.equal(planned.writes.length, 0)
  assert.deepEqual(planned.equivalence.gaps, [
    { field: '.env.example', reason: 'credential', replacement: 'dropped' },
  ])

  // The same skill without that dotfile, holding an image instead, is copied whole.
  const clean = fixture()
  const other = path.join(clean.home, '.pi', 'agent', 'skills', 'review')
  writeSkill(other)
  fs.writeFileSync(path.join(other, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]))
  discover(clean)

  const copy = plan(clean, other, 'codex:user')
  assert.equal(copy.writes[0]?.op, 'copyFile')
  assert.equal(applyPlan(clean, copy).outcome, 'applied')
  assert.equal(
    fs.readFileSync(path.join(sharedSkills(clean), 'review', 'logo.png')).length,
    8,
  )
})

test('a shadow name that resolves to the target itself is not reported as a shadow', () => {
  const config = fixture()
  const target = path.join(config.home, '.codex', 'AGENTS.md')
  fs.writeFileSync(target, '# Rules\n')
  // A same-directory name that is the same entry: what a case-insensitive filesystem hands back.
  fs.symlinkSync(target, path.join(config.home, '.codex', 'AGENTS.MD'))
  discover(config)

  const planned = plan(config, target, 'pi:user')

  assert.equal(planned.manualSteps.some((step) => step.step.includes('AGENTS.MD')), false)
})
