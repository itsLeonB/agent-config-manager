import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { loadEnvironment } from './loader.ts'
import { printable } from './print.ts'
import { shellWord } from './command.ts'
import type { EnvironmentTier } from './types.ts'

// Skills come from the skills CLI's lockfiles, never from Provisions: `acm skills install` is the
// converge command, reads `~/.agents/.skill-lock.json` (user scope, `-g`) and the project's
// `skills-lock.json` (project scope), groups each file's entries by `source`, and runs one
// `npx skills add` per group with the harness list the matching environment file declares. The
// lockfile is the source of truth and stays untouched — nothing here writes the store either.

export interface SkillsLockSkill {
  name: string
  source: string
}

export interface SkillsLockRead {
  // In file order, one per `skills` entry that carried a source.
  skills: SkillsLockSkill[]
  // One line per problem a warning should carry: a missing file, unreadable bytes, bad JSON, a
  // missing `skills` map, or an entry with no `source`.
  warnings: string[]
}

// The `skills` CLI's global lock lives under `$XDG_STATE_HOME/skills/` when that variable is set,
// otherwise `~/.agents/`; the project lock is always `<project>/skills-lock.json`.
// The two per-tier answers the installer reads: keyed by the closed tier names so a file can never
// answer for the other scope's lockfile or harness list.
export interface SkillsLockPaths {
  user: string
  project: string
}
export interface SkillsLockReads {
  user: SkillsLockRead
  project: SkillsLockRead
}

export function skillsLockPaths(config: EngineConfig, env: NodeJS.ProcessEnv = process.env): SkillsLockPaths {
  const xdg = env.XDG_STATE_HOME
  const user =
    xdg === undefined
      ? path.join(config.home, '.agents', '.skill-lock.json')
      : path.join(xdg, 'skills', '.skill-lock.json')
  return { user, project: path.join(config.projectRoot, 'skills-lock.json') }
}

// The reader is a pure function over bytes: every lockfile shape is testable without `npx`. The
// global lock is schema v3 and the project lock schema v1, and both share `{ version, skills: {
// <name>: { source, ... } } }`, so a `version` the file spells is accepted as written — a newer
// schema's extra fields survive for the CLI that owns them. A `skills` map entry without a string
// `source` has nothing to install and is skipped with a warning.
export function readSkillsLock(file: string, tier: EnvironmentTier): SkillsLockRead {
  if (!existsSync(file)) return { skills: [], warnings: [`${file}: no skills lockfile for the ${tier} tier`] }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { skills: [], warnings: [`${file}: could not be read: ${reason}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { skills: [], warnings: [`${file}: is not valid JSON: ${reason}`] }
  }
  // The lockfile's root is `{ version, skills }` plus fields the schema does not own; a missing
  // or non-map `skills` is the one shape that reads as "no skills", everything else is a warning.
  const root = z.looseObject({ skills: z.record(z.string(), z.unknown()).optional() }).safeParse(parsed)
  const map = root.success ? root.data.skills : undefined
  if (map === undefined) {
    return { skills: [], warnings: [`${file}: has no 'skills' map`] }
  }
  const skills: SkillsLockSkill[] = []
  const warnings: string[] = []
  for (const [name, entry] of Object.entries(map)) {
    const record = z.record(z.string(), z.unknown()).safeParse(entry)
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a lock entry's source is the discriminator
    const source = record.success && typeof record.data.source === 'string' ? record.data.source : undefined
    if (source === undefined || source === '') {
      warnings.push(`${file}: skill '${name}' has no source and was skipped`)
      continue
    }
    skills.push({ name, source })
  }
  return { skills, warnings }
}

export interface SkillsCommand {
  // The exact argv `npx` receives, in order.
  argv: string[]
  cwd: string
  tier: EnvironmentTier
}

export interface SkillsInstallOptions {
  dryRun?: boolean
}

// One `npx skills add` per source group: `npx -y skills@latest add <source> --skill <name>...
// [--agent <harness>...] [-g] -y`. Groups keep first-seen source order and file order inside a
// group. A tier with no declared harnesses omits `--agent` so the CLI detects installed harnesses
// itself. The user groups run from the home directory with `-g`; the project groups run from the
// Project root without it.
export function skillsCommands(
  reads: SkillsLockReads,
  harnessesByTier: Record<EnvironmentTier, string[]>,
  roots: SkillsLockPaths,
): SkillsCommand[] {
  const commands: SkillsCommand[] = []
  for (const tier of ['user', 'project'] as const) {
    const bySource = new Map<string, string[]>()
    for (const skill of reads[tier].skills) {
      bySource.set(skill.source, [...(bySource.get(skill.source) ?? []), skill.name])
    }
    for (const [source, names] of bySource) {
      const argv = ['-y', 'skills@latest', 'add', source]
      for (const name of names) argv.push('--skill', name)
      for (const harness of harnessesByTier[tier]) argv.push('--agent', harness)
      if (tier === 'user') argv.push('-g')
      argv.push('-y')
      commands.push({ argv, cwd: roots[tier], tier })
    }
  }
  return commands
}

// The shell spelling of one command, for the line a real run and a dry run both print.
function commandText(command: SkillsCommand): string {
  return `npx ${command.argv.map(shellWord).join(' ')}`
}

// The one spawn in the skills installer: argv goes to `npx` untouched — no shell, so a source or a
// skill name is data, never text a shell could read. stdin is /dev/null like every ACM command.
// `env` reaches the child as given so a test can put a fake `npx` first on PATH.
function runCommand(command: SkillsCommand, env: NodeJS.ProcessEnv): number | null {
  const result = spawnSync('npx', command.argv, { cwd: command.cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
  return result.status
}

export function skillsInstallRun(
  write: (text: string) => void,
  warn: (text: string) => void,
  options: SkillsInstallOptions = {},
  config: EngineConfig = resolveDefaultConfig(),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const paths = skillsLockPaths(config, env)
  const environment = loadEnvironment(config)
  const reads: SkillsLockReads = {
    user: readSkillsLock(paths.user, 'user'),
    project: readSkillsLock(paths.project, 'project'),
  }
  for (const tier of ['user', 'project'] as const) {
    for (const warning of reads[tier].warnings) warn(`${printable(warning)}\n`)
    if (reads[tier].skills.length === 0 && reads[tier].warnings.length === 0) {
      warn(`${printable(paths[tier])}: no skills installed for the ${tier} tier\n`)
    }
  }
  const commands = skillsCommands(
    reads,
    environment.harnessesByTier,
    { user: config.home, project: config.projectRoot },
  )
  if (options.dryRun === true) {
    for (const command of commands) write(`${commandText(command)}\n`)
    write('dry run: nothing was run\n')
    return 0
  }
  let exitCode = 0
  for (const command of commands) {
    write(`${commandText(command)}\n`)
    const status = runCommand(command, env)
    if (status === 0) {
      write('  exit 0\n')
    } else {
      exitCode = 1
      write(`  ${status === null ? 'failed to start' : `exit ${status}`}\n`)
    }
  }
  return exitCode
}
