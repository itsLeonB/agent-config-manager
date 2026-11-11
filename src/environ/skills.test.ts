import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSkillsLock, readSkillsLock, skillsCommands } from './skills.ts'
import type { SkillsLockRead } from './skills.ts'

// Seam B: the lockfile reader is a pure function over bytes, so every shape the `skills` CLI can
// write — and the ones it cannot — is a test here, with no `npx` and no filesystem at all.
// `skillsCommands` is the grouping half: one command per source, in file order.

const LOCK = 'skills-lock.json'

function somewhere(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acm-skills-'))
}

function lockBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

test('a version 3 global lockfile reads every entry with a source, in file order', () => {
  const read = parseSkillsLock(lockBytes(JSON.stringify({
    version: 3,
    skills: {
      'web-design': { source: 'vercel-labs/agent-skills', sourceType: 'github', skillFolderHash: 'abc' },
      tdd: { source: 'mattpocock/skills', sourceType: 'github' },
    },
    lastSelectedAgents: ['pi'],
  })), LOCK)
  assert.deepEqual(read.skills, [
    { name: 'web-design', source: 'vercel-labs/agent-skills' },
    { name: 'tdd', source: 'mattpocock/skills' },
  ])
  assert.deepEqual(read.warnings, [])
})

test('a version 1 project lockfile reads the same shape', () => {
  const read = parseSkillsLock(lockBytes(JSON.stringify({
    version: 1,
    skills: {
      pdf: { source: 'contoso/pdf-tools', sourceType: 'github', computedHash: 'f3bc' },
    },
  })), LOCK)
  assert.deepEqual(read.skills, [{ name: 'pdf', source: 'contoso/pdf-tools' }])
  assert.deepEqual(read.warnings, [])
})

test('a missing skills key warns and reads nothing', () => {
  const read = parseSkillsLock(lockBytes(JSON.stringify({ version: 3, dismissed: {} })), LOCK)
  assert.deepEqual(read.skills, [])
  assert.equal(read.warnings.length, 1)
  assert.match(read.warnings[0], /has no 'skills' map/)
})

test('invalid JSON warns and reads nothing', () => {
  const read = parseSkillsLock(lockBytes('{ "version": 3, "skills": '), LOCK)
  assert.deepEqual(read.skills, [])
  assert.equal(read.warnings.length, 1)
  assert.match(read.warnings[0], /is not valid JSON/)
})

test('bytes that are not UTF-8 warn and read nothing', () => {
  const read = parseSkillsLock(new Uint8Array([0xff, 0xfe, 0x00, 0x41]), LOCK)
  assert.deepEqual(read.skills, [])
  assert.equal(read.warnings.length, 1)
})

test('an entry with no source is skipped with a warning, the rest still read', () => {
  const read = parseSkillsLock(lockBytes(JSON.stringify({
    version: 1,
    skills: {
      good: { source: 'owner/repo', sourceType: 'github' },
      bad: { sourceType: 'github' },
      worse: 'not-an-object',
    },
  })), LOCK)
  assert.deepEqual(read.skills, [{ name: 'good', source: 'owner/repo' }])
  assert.equal(read.warnings.length, 2)
  assert.match(read.warnings[0], /'bad'.*has no source/)
  assert.match(read.warnings[1], /'worse'.*has no source/)
})

// JSON.parse orders integer-like keys numerically, but the lockfile's file order is the truth:
// "10" before "2" is what the file says, and the install must keep it.
test('integer-like skill names keep the file order the bytes spell', () => {
  // The bytes are spelled out, not stringified: a JS object already orders "2" before "10", so
  // only literal text can put "10" first the way a hand-edited or older lockfile might.
  const read = parseSkillsLock(lockBytes(`{"version":3,"skills":{"10":{"source":"repo/ten"},"2":{"source":"repo/two"},"abc":{"source":"repo/abc"}}}`), LOCK)
  assert.deepEqual(read.skills.map((skill) => skill.name), ['10', '2', 'abc'])
})

test('a repeated skills key uses the last map and keeps its file order', () => {
  const read = parseSkillsLock(lockBytes('{"skills":{},"skills":{"10":{"source":"a"},"2":{"source":"b"}}}'), LOCK)
  assert.deepEqual(read.skills, [{ name: '10', source: 'a' }, { name: '2', source: 'b' }])
})

test('option-like sources and skill names are skipped with reasons', () => {
  const read = parseSkillsLock(lockBytes(JSON.stringify({ skills: {
    badSource: { source: '--global' },
    '-g': { source: 'repo/one' },
    good: { source: 'repo/good' },
    empty: { source: '' },
  } })), LOCK)
  assert.deepEqual(read.skills, [{ name: 'good', source: 'repo/good' }])
  assert.match(read.warnings.join('\n'), /badSource.*source.*option/)
  assert.match(read.warnings.join('\n'), /'-g'.*name.*option/)
  assert.match(read.warnings.join('\n'), /empty.*has no source/)
})

test('readSkillsLock is the filesystem wrapper: a missing file warns with its tier', () => {
  const missing = path.join(somewhere(), 'never.json')
  const read = readSkillsLock(missing, 'project')
  assert.deepEqual(read.skills, [])
  assert.deepEqual(read.warnings, [`${missing}: no skills lockfile for the project tier`])
})

test('skillsCommands groups by source in first-seen order and spells the argv', () => {
  const read = {
    skills: [
      { name: 'a', source: 'repo/one' },
      { name: 'b', source: 'repo/two' },
      { name: 'c', source: 'repo/one' },
    ],
    warnings: [],
  } satisfies SkillsLockRead
  const commands = skillsCommands('user', read, ['pi', 'codex'], '/home/u')
  assert.equal(commands.length, 2)
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
  // The project tier runs from the project root without -g; --agent spells the same names.
  const project = skillsCommands('project', read, ['opencode'], '/repo')
  assert.deepEqual(project[0].argv, [
    '-y', 'skills@latest', 'add', 'repo/one',
    '--skill', 'a', '--skill', 'c',
    '--agent', 'opencode',
    '-y',
  ])
  assert.equal(project[0].cwd, '/repo')
})


// Seam A: the installer against a fixture — a temp home, a temp project root, hand-written
// environment files and lockfiles, and a fake `npx` on PATH that records its argv and cwd. One
// run covers one tier: the project tier by default, the user tier with `-g`. The confirm prompt
// is an injected callback, so the prompt's yes/no paths are tested without a TTY.

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

function run(
  f: Fixture,
  options: { dryRun?: boolean; yes?: boolean; global?: boolean } = {},
  env: NodeJS.ProcessEnv = f.env,
  confirm?: (message: string) => boolean,
): Observation {
  const writes: string[] = []
  const warnings: string[] = []
  const exitCode = skillsInstallRun(
    (text) => writes.push(text),
    (text) => warnings.push(text),
    confirm,
    options,
    f.config,
    env,
  )
  return { printed: writes.join(''), warned: warnings.join(''), exitCode }
}

const HARNESS_ENV = 'version = 1\n\nharnesses = ["opencode", "pi"]\n'

test('the default run installs the project tier: grouped by source, the project file harnesses, no -g', () => {
  const f = fixture()
  projectEnvironment(f, HARNESS_ENV)
  projectLock(f, {
    one: { source: 'repo/one', sourceType: 'github' },
    two: { source: 'repo/two', sourceType: 'github' },
    three: { source: 'repo/one', sourceType: 'github' },
  })
  const { printed, exitCode } = run(f, { yes: true })
  const ran = calls(f)
  assert.equal(ran.length, 2)
  assert.deepEqual(ran[0].argv, [
    '-y', 'skills@latest', 'add', 'repo/one',
    '--skill', 'one', '--skill', 'three',
    '--agent', 'opencode', '--agent', 'pi',
    '-y',
  ])
  assert.equal(ran[0].cwd, f.projectRoot)
  assert.deepEqual(ran[1].argv, [
    '-y', 'skills@latest', 'add', 'repo/two',
    '--skill', 'two',
    '--agent', 'opencode', '--agent', 'pi',
    '-y',
  ])
  assert.match(printed, /^npx -y skills@latest add repo\/one --skill one --skill three --agent opencode --agent pi -y$/m)
  assert.match(printed, /exit 0/)
  assert.equal(exitCode, 0)
})

test('-g selects the user tier: the user lockfile with -g, cwd the home, the user file harnesses', () => {
  const f = fixture()
  environment(f, HARNESS_ENV)
  userLock(f, { u: { source: 'repo/u', sourceType: 'github' } })
  const { exitCode } = run(f, { global: true, yes: true })
  const ran = calls(f)
  assert.equal(ran.length, 1)
  assert.deepEqual(ran[0].argv, [
    '-y', 'skills@latest', 'add', 'repo/u',
    '--skill', 'u',
    '--agent', 'opencode', '--agent', 'pi',
    '-g', '-y',
  ])
  assert.equal(ran[0].cwd, f.home)
  assert.equal(exitCode, 0)
})

test('a selected tier with no declared harnesses — absent file or absent key — warns and exits 1 before any spawn', () => {
  // No environment file at all for the selected tier.
  const absent = fixture()
  projectLock(absent, { p: { source: 'repo/p', sourceType: 'github' } })
  const first = run(absent)
  assert.equal(first.exitCode, 1)
  assert.equal(calls(absent).length, 0)
  assert.equal(first.printed, '')
  assert.match(first.warned, /declares no harnesses/)

  // A file that exists but declares no harnesses key; the unselected user tier has a file, a
  // list and a lockfile, and none of it is read because the tier was never selected.
  const noKey = fixture()
  environment(noKey, HARNESS_ENV)
  userLock(noKey, { u: { source: 'repo/u', sourceType: 'github' } })
  projectEnvironment(noKey, 'version = 1\n')
  projectLock(noKey, { p: { source: 'repo/p', sourceType: 'github' } })
  const second = run(noKey)
  assert.equal(second.exitCode, 1)
  assert.equal(calls(noKey).length, 0)
  assert.doesNotMatch(second.printed, /npx/)
  assert.doesNotMatch(second.warned, /user tier/)
  assert.match(second.warned, /declares no harnesses/)
})

test('a refused environment file for the selected tier warns and exits 1 without spawning', () => {
  const f = fixture()
  projectEnvironment(f, 'version = 1\nharnesses = [42]\n')
  projectLock(f, { p: { source: 'repo/p', sourceType: 'github' } })
  const result = run(f)
  assert.equal(result.exitCode, 1)
  assert.equal(calls(f).length, 0)
  assert.match(result.warned, /refused environment/)
})

test('--dry-run prints every command and runs nothing', () => {
  const f = fixture()
  projectEnvironment(f, HARNESS_ENV)
  projectLock(f, { b: { source: 'repo/two', sourceType: 'github' } })
  const { printed, exitCode } = run(f, { dryRun: true })
  assert.equal(calls(f).length, 0)
  assert.match(printed, /^npx -y skills@latest add repo\/two --skill b --agent opencode --agent pi -y$/m)
  assert.match(printed, /dry run: nothing was run/)
  assert.equal(exitCode, 0)
})

test('-y prints and runs without asking; no -y and no prompt prints and stops', () => {
  const withYes = fixture()
  projectEnvironment(withYes, HARNESS_ENV)
  projectLock(withYes, { b: { source: 'repo/two', sourceType: 'github' } })
  const yes = run(withYes, { yes: true })
  assert.equal(calls(withYes).length, 1)
  assert.equal(yes.exitCode, 0)

  // A run with neither -y nor a confirm callback is the non-TTY case: the commands print, and
  // nothing spawns.
  const nonTty = fixture()
  projectEnvironment(nonTty, HARNESS_ENV)
  projectLock(nonTty, { b: { source: 'repo/two', sourceType: 'github' } })
  const stopped = run(nonTty)
  assert.equal(calls(nonTty).length, 0)
  assert.match(stopped.printed, /^npx -y skills@latest add repo\/two/m)
  assert.doesNotMatch(stopped.printed, /exit/)
  assert.equal(stopped.exitCode, 0)
})

test('a yes answer runs everything; a no answer runs nothing and exits 0', () => {
  const f = fixture()
  projectEnvironment(f, HARNESS_ENV)
  projectLock(f, {
    a: { source: 'repo/one', sourceType: 'github' },
    b: { source: 'repo/two', sourceType: 'github' },
  })
  const asked: string[] = []
  const yes = run(f, {}, f.env, (message) => {
    asked.push(message)
    return true
  })
  assert.match(asked.join(''), /run these 2 command\(s\)/)
  assert.equal(calls(f).length, 2)
  assert.equal(yes.exitCode, 0)

  const declined = fixture()
  projectEnvironment(declined, HARNESS_ENV)
  projectLock(declined, { b: { source: 'repo/two', sourceType: 'github' } })
  const no = run(declined, {}, declined.env, () => false)
  assert.equal(calls(declined).length, 0)
  assert.equal(no.exitCode, 0)
  // The commands were printed before the ask.
  assert.match(no.printed, /^npx -y skills@latest add repo\/two/m)
})

test('a missing selected lockfile warns and installs nothing, exit 0', () => {
  const f = fixture()
  projectEnvironment(f, HARNESS_ENV)
  const result = run(f)
  assert.match(result.warned, /no skills lockfile for the project tier/)
  assert.equal(calls(f).length, 0)
  assert.equal(result.exitCode, 0)
})

test('an entry with no source is skipped with a warning and the rest still install', () => {
  const f = fixture()
  projectEnvironment(f, HARNESS_ENV)
  projectLock(f, {
    good: { source: 'repo/one', sourceType: 'github' },
    bad: { sourceType: 'github' },
  })
  const { warned, exitCode } = run(f, { yes: true })
  const ran = calls(f)
  assert.equal(ran.length, 1)
  assert.deepEqual(ran[0].argv.slice(0, 6), ['-y', 'skills@latest', 'add', 'repo/one', '--skill', 'good'])
  assert.match(warned, /'bad'.*has no source/)
  assert.equal(exitCode, 0)
})

test('one failed command does not stop the rest, and the exit status is non-zero', () => {
  const f = fixture()
  projectEnvironment(f, HARNESS_ENV)
  projectLock(f, {
    broken: { source: 'fail-me', sourceType: 'github' },
    fine: { source: 'repo/good', sourceType: 'github' },
  })
  const { printed, exitCode } = run(f, { yes: true })
  const ran = calls(f)
  assert.equal(ran.length, 2)
  assert.match(printed, /exit 7/)
  assert.match(printed, /exit 0/)
  assert.equal(exitCode, 1)
})

// The user lockfile's path is fixed by the spec: ~/.agents/.skill-lock.json. XDG_STATE_HOME is
// not consulted — a variable that moved the file would install a different set of skills.
test('a -g run uses config.home as the child home, not the process home', () => {
  const f = fixture()
  environment(f, HARNESS_ENV)
  userLock(f, { userSkill: { source: 'repo/user' } })
  const homes = path.join(path.dirname(f.log), 'homes.jsonl')
  const fake = path.join(path.dirname(f.log), 'bin', 'npx')
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
fs.appendFileSync(${JSON.stringify(homes)}, JSON.stringify({ home: os.homedir(), profile: process.env.USERPROFILE, global: process.argv.includes('-g') }) + '\\n')
`)
  const processHome = path.join(path.dirname(f.home), 'process-home')
  fs.mkdirSync(processHome)
  const result = run(f, { global: true, yes: true }, { ...f.env, HOME: processHome, USERPROFILE: processHome })
  assert.equal(result.exitCode, 0)
  const actual = fs.readFileSync(homes, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(actual, [{ home: f.home, profile: f.home, global: true }])
})

test('XDG_STATE_HOME does not move the user lockfile', () => {
  const f = fixture()
  const xdg = path.join(f.home, 'xdg-state')
  fs.mkdirSync(path.join(xdg, 'skills'), { recursive: true })
  fs.writeFileSync(
    path.join(xdg, 'skills', '.skill-lock.json'),
    JSON.stringify({ version: 3, skills: { decoy: { source: 'repo/decoy', sourceType: 'github' } } }),
  )
  environment(f, HARNESS_ENV)
  userLock(f, { real: { source: 'repo/real', sourceType: 'github' } })
  const { warned } = run(f, { global: true, yes: true }, { ...f.env, XDG_STATE_HOME: xdg })
  const ran = calls(f)
  assert.equal(ran.length, 1)
  assert.deepEqual(ran[0].argv.slice(0, 6), ['-y', 'skills@latest', 'add', 'repo/real', '--skill', 'real'])
  assert.doesNotMatch(warned, /no skills lockfile for the user tier/)
})

// A NUL byte in a lockfile value makes spawnSync throw synchronously. That is one command's
// failure, not the run's: the groups after it still execute and the exit status says so.
test('a spawn that throws does not stop the groups after it', () => {
  const f = fixture()
  environment(f, HARNESS_ENV)
  userLock(f, {
    bad: { source: 'repo/bad\u0000source', sourceType: 'github' },
    good: { source: 'repo/good', sourceType: 'github' },
  })
  const { printed, exitCode } = run(f, { global: true, yes: true })
  const ran = calls(f)
  // The NUL group never reached npx; the next group did.
  assert.equal(ran.length, 1)
  assert.deepEqual(ran[0].argv.slice(0, 6), ['-y', 'skills@latest', 'add', 'repo/good', '--skill', 'good'])
  assert.match(printed, /failed to start/)
  assert.match(printed, /exit 0/)
  assert.equal(exitCode, 1)
})

// A lockfile value is file bytes, and file bytes can hold control characters. The printed command
// is a line a human reads, so it prints the printable spelling; the argv that runs is untouched.
test('the printed command strips control characters the argv still carries', () => {
  const f = fixture()
  projectEnvironment(f, HARNESS_ENV)
  projectLock(f, {
    sneaky: { source: 'repo/one\nignored', sourceType: 'github' },
  })
  const { printed } = run(f, { dryRun: true })
  assert.doesNotMatch(printed, /\nignored/)
  assert.match(printed, /repo\/one\?ignored/)
})
