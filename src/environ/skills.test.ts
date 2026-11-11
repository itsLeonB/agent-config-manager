import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSkillsLock, skillsCommands } from './skills.ts'
import type { SkillsLockReads } from './skills.ts'

// Seam B: the lockfile reader is a pure function over bytes, so every shape the `skills` CLI can
// write — and the ones it cannot — is a test here, with no `npx` and no filesystem beyond a temp
// file. `skillsCommands` is the grouping half: one command per source, in file order.

function somewhere(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acm-skills-'))
}

function lockfile(text: string): string {
  const file = path.join(somewhere(), 'lock.json')
  fs.writeFileSync(file, text)
  return file
}

test('a version 3 global lockfile reads every entry with a source, in file order', () => {
  const file = lockfile(JSON.stringify({
    version: 3,
    skills: {
      'web-design': { source: 'vercel-labs/agent-skills', sourceType: 'github', skillFolderHash: 'abc' },
      tdd: { source: 'mattpocock/skills', sourceType: 'github' },
    },
    lastSelectedAgents: ['pi'],
  }))
  const read = readSkillsLock(file, 'user')
  assert.deepEqual(read.skills, [
    { name: 'web-design', source: 'vercel-labs/agent-skills' },
    { name: 'tdd', source: 'mattpocock/skills' },
  ])
  assert.deepEqual(read.warnings, [])
})

test('a version 1 project lockfile reads the same shape', () => {
  const file = lockfile(JSON.stringify({
    version: 1,
    skills: {
      pdf: { source: 'contoso/pdf-tools', sourceType: 'github', computedHash: 'f3bc' },
    },
  }))
  const read = readSkillsLock(file, 'project')
  assert.deepEqual(read.skills, [{ name: 'pdf', source: 'contoso/pdf-tools' }])
  assert.deepEqual(read.warnings, [])
})

test('a missing skills key warns and reads nothing', () => {
  const file = lockfile(JSON.stringify({ version: 3, dismissed: {} }))
  const read = readSkillsLock(file, 'user')
  assert.deepEqual(read.skills, [])
  assert.equal(read.warnings.length, 1)
  assert.match(read.warnings[0], /has no 'skills' map/)
})

test('invalid JSON warns and reads nothing', () => {
  const file = lockfile('{ "version": 3, "skills": ')
  const read = readSkillsLock(file, 'user')
  assert.deepEqual(read.skills, [])
  assert.equal(read.warnings.length, 1)
  assert.match(read.warnings[0], /is not valid JSON/)
})

test('a missing lockfile warns and reads nothing', () => {
  const missing = path.join(somewhere(), 'never.json')
  const read = readSkillsLock(missing, 'project')
  assert.deepEqual(read.skills, [])
  assert.deepEqual(read.warnings, [`${missing}: no skills lockfile for the project tier`])
})

test('an entry with no source is skipped with a warning, the rest still read', () => {
  const file = lockfile(JSON.stringify({
    version: 1,
    skills: {
      good: { source: 'owner/repo', sourceType: 'github' },
      bad: { sourceType: 'github' },
      worse: 'not-an-object',
    },
  }))
  const read = readSkillsLock(file, 'project')
  assert.deepEqual(read.skills, [{ name: 'good', source: 'owner/repo' }])
  assert.equal(read.warnings.length, 2)
  assert.match(read.warnings[0], /'bad'.*has no source/)
  assert.match(read.warnings[1], /'worse'.*has no source/)
})

test('skillsCommands groups by source in first-seen order and spells the argv', () => {
  const reads = {
    user: {
      skills: [
        { name: 'a', source: 'repo/one' },
        { name: 'b', source: 'repo/two' },
        { name: 'c', source: 'repo/one' },
      ],
      warnings: [],
    },
    project: { skills: [{ name: 'd', source: 'repo/three' }], warnings: [] },
  } satisfies SkillsLockReads
  const commands = skillsCommands(reads, { user: ['pi', 'codex'], project: [] }, { user: '/home/u', project: '/repo' })
  assert.equal(commands.length, 3)
  assert.deepEqual(commands[0].argv, [
    '-y', 'skills@latest', 'add', 'repo/one',
    '--skill', 'a', '--skill', 'c',
    '--agent', 'pi', '--agent', 'codex',
    '-g', '-y',
  ])
  assert.equal(commands[0].cwd, '/home/u')
  assert.deepEqual(commands[1].argv, [
    '-y', 'skills@latest', 'add', 'repo/two',
    '--skill', 'b',
    '--agent', 'pi', '--agent', 'codex',
    '-g', '-y',
  ])
  // A tier with no declared harnesses omits --agent entirely.
  assert.deepEqual(commands[2].argv, [
    '-y', 'skills@latest', 'add', 'repo/three',
    '--skill', 'd',
    '-y',
  ])
  assert.equal(commands[2].cwd, '/repo')
})


// Seam A: the installer against a fixture — a temp home, a temp project root, hand-written
// environment files and lockfiles, and a fake `npx` on PATH that records its argv and cwd. The
// assertions are the printed commands, the recorded argv order, and the exit status; nothing here
// inspects how the installer grouped the entries.

import { skillsInstallRun } from './skills.ts'
import type { EngineConfig } from '../engine/config.ts'

interface RecordedCall {
  argv: string[]
  cwd: string
}

interface Fixture {
  home: string
  projectRoot: string
  log: string
  config: EngineConfig
  env: NodeJS.ProcessEnv
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-skills-run-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  const log = path.join(root, 'npx.log')
  // The fake npx writes one record per call: the argv words joined by tabs, then the cwd, one
  // record per line. `fail-me` anywhere in argv makes it exit 7.
  const script = `#!/bin/sh
printf '%s\\t%s\\n' "$(printf '%s\\t' "$@")" "$(pwd -P)" >> "${log}"
case " $* " in
  *" fail-me "*) exit 7 ;;
esac
exit 0
`
  const target = path.join(bin, 'npx')
  fs.writeFileSync(target, script)
  fs.chmodSync(target, 0o755)
  return {
    home,
    projectRoot,
    log,
    config: { home, projectRoot, storePath: path.join(root, 'store', 'dashboard.db') },
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  }
}

function file(f: Fixture, rel: string, text: string): void {
  const target = path.join(f.projectRoot, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}

function homeFile(f: Fixture, rel: string, text: string): void {
  const target = path.join(f.home, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}

function userLock(f: Fixture, skills: Record<string, { source?: string; sourceType?: string } | string>): void {
  homeFile(f, path.join('.agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills }))
}

function projectLock(f: Fixture, skills: Record<string, { source?: string; sourceType?: string } | string>): void {
  file(f, 'skills-lock.json', JSON.stringify({ version: 1, skills }))
}

function environment(f: Fixture, text: string): void {
  homeFile(f, 'agents_environ.toml', text)
}

function projectEnvironment(f: Fixture, text: string): void {
  file(f, 'agents_environ.toml', text)
}

function calls(f: Fixture): RecordedCall[] {
  if (!fs.existsSync(f.log)) return []
  return fs
    .readFileSync(f.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parts = line.split('\t')
      const cwd = parts.pop() ?? ''
      return { argv: parts.filter((word) => word !== ''), cwd }
    })
}

interface Observation {
  printed: string
  warned: string
  exitCode: number
}

function run(f: Fixture, options: { dryRun?: boolean } = {}): Observation {
  const writes: string[] = []
  const warnings: string[] = []
  const exitCode = skillsInstallRun(
    (text) => writes.push(text),
    (text) => warnings.push(text),
    options,
    f.config,
    f.env,
  )
  return { printed: writes.join(''), warned: warnings.join(''), exitCode }
}

test('user lockfile skills install at user scope with -g, grouped by source, with the user file\'s harnesses', () => {
  const f = fixture()
  environment(f, `version = 1

harnesses = ["pi", "codex"]
`)
  userLock(f, {
    alpha: { source: 'repo/one', sourceType: 'github' },
    beta: { source: 'repo/two', sourceType: 'github' },
    gamma: { source: 'repo/one', sourceType: 'github' },
  })
  const { printed, warned, exitCode } = run(f)
  const ran = calls(f)
  assert.equal(ran.length, 2)
  // User groups first, one per source, in first-seen order; --skill repeats per name in file order.
  assert.deepEqual(ran[0].argv, [
    '-y', 'skills@latest', 'add', 'repo/one',
    '--skill', 'alpha', '--skill', 'gamma',
    '--agent', 'pi', '--agent', 'codex',
    '-g', '-y',
  ])
  assert.equal(ran[0].cwd, f.home)
  assert.deepEqual(ran[1].argv, [
    '-y', 'skills@latest', 'add', 'repo/two',
    '--skill', 'beta',
    '--agent', 'pi', '--agent', 'codex',
    '-g', '-y',
  ])
  assert.match(printed, /^npx -y skills@latest add repo\/one --skill alpha --skill gamma --agent pi --agent codex -g -y$/m)
  assert.match(printed, /exit 0/)
  // The project lockfile is absent here, so its tier warns and installs nothing.
  assert.match(warned, /no skills lockfile for the project tier/)
  assert.doesNotMatch(warned, /user tier/)
  assert.equal(exitCode, 0)
})

test('the project lockfile installs from the Project root without -g, with the project file\'s harnesses', () => {
  const f = fixture()
  projectEnvironment(f, `version = 1

harnesses = ["opencode"]
`)
  projectLock(f, {
    local: { source: 'repo/proj', sourceType: 'github' },
  })
  const { exitCode } = run(f)
  const ran = calls(f)
  assert.equal(ran.length, 1)
  assert.deepEqual(ran[0].argv, [
    '-y', 'skills@latest', 'add', 'repo/proj',
    '--skill', 'local',
    '--agent', 'opencode',
    '-y',
  ])
  assert.equal(ran[0].cwd, f.projectRoot)
  assert.equal(exitCode, 0)
})

test('a tier with no declared harnesses omits --agent; user groups still run before project groups', () => {
  const f = fixture()
  environment(f, 'version = 1\n')
  projectEnvironment(f, 'version = 1\n')
  userLock(f, { u: { source: 'repo/u', sourceType: 'github' } })
  projectLock(f, { p: { source: 'repo/p', sourceType: 'github' } })
  const { exitCode } = run(f)
  const ran = calls(f)
  assert.equal(ran.length, 2)
  assert.deepEqual(ran[0].argv, ['-y', 'skills@latest', 'add', 'repo/u', '--skill', 'u', '-g', '-y'])
  assert.deepEqual(ran[1].argv, ['-y', 'skills@latest', 'add', 'repo/p', '--skill', 'p', '-y'])
  assert.equal(ran[0].cwd, f.home)
  assert.equal(ran[1].cwd, f.projectRoot)
  assert.equal(exitCode, 0)
})

test('--dry-run prints every command and runs nothing', () => {
  const f = fixture()
  userLock(f, { a: { source: 'repo/one', sourceType: 'github' } })
  projectLock(f, { b: { source: 'repo/two', sourceType: 'github' } })
  const { printed, exitCode } = run(f, { dryRun: true })
  assert.equal(calls(f).length, 0)
  assert.match(printed, /^npx -y skills@latest add repo\/one --skill a -g -y$/m)
  assert.match(printed, /^npx -y skills@latest add repo\/two --skill b -y$/m)
  assert.match(printed, /dry run: nothing was run/)
  assert.equal(exitCode, 0)
})

test('a missing user lockfile still installs the project skills, and the reverse', () => {
  const f = fixture()
  projectLock(f, { p: { source: 'repo/p', sourceType: 'github' } })
  const first = run(f)
  assert.equal(calls(f).length, 1)
  assert.match(first.warned, /no skills lockfile for the user tier/)
  assert.equal(first.exitCode, 0)

  const g = fixture()
  userLock(g, { u: { source: 'repo/u', sourceType: 'github' } })
  const second = run(g)
  assert.equal(calls(g).length, 1)
  assert.match(second.warned, /no skills lockfile for the project tier/)
  assert.equal(second.exitCode, 0)
})

test('an entry with no source is skipped with a warning and the rest still install', () => {
  const f = fixture()
  userLock(f, {
    good: { source: 'repo/one', sourceType: 'github' },
    bad: { sourceType: 'github' },
  })
  const { warned, exitCode } = run(f)
  const ran = calls(f)
  assert.equal(ran.length, 1)
  assert.deepEqual(ran[0].argv.slice(0, 6), ['-y', 'skills@latest', 'add', 'repo/one', '--skill', 'good'])
  assert.match(warned, /'bad'.*has no source/)
  assert.equal(exitCode, 0)
})

test('one failed command does not stop the rest, and the exit status is non-zero', () => {
  const f = fixture()
  userLock(f, {
    broken: { source: 'repo/bad', sourceType: 'github' },
    fine: { source: 'repo/good', sourceType: 'github' },
  })
  // fail-me is one of the recorded argv words only if a source spells it; put it in the source.
  userLock(f, {
    broken: { source: 'fail-me', sourceType: 'github' },
    fine: { source: 'repo/good', sourceType: 'github' },
  })
  const { printed, exitCode } = run(f)
  const ran = calls(f)
  assert.equal(ran.length, 2)
  assert.match(printed, /exit 7/)
  assert.match(printed, /exit 0/)
  assert.equal(exitCode, 1)
})
