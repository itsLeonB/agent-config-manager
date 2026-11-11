import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { environmentFiles, loadEnvironment } from './loader.ts'
import { printable } from './print.ts'
import { shellWord } from './command.ts'
import type { EnvironmentTier } from './types.ts'

// Skills come from the skills CLI's lockfiles, never from Provisions: `acm skills install` is the
// converge command and runs one tier per invocation — the project tier by default, the user tier
// with `-g`. It reads that tier's lockfile, groups its entries by `source`, and runs one
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

// The `skills` CLI's global lock lives at `~/.agents/.skill-lock.json` — a fixed path the spec
// names, so no environment variable moves it; the project lock is `<project>/skills-lock.json`.
// The two per-tier answers the installer reads: keyed by the closed tier names so a file can never
// answer for the other scope's lockfile or harness list.
export interface SkillsLockPaths {
  user: string
  project: string
}

export function skillsLockPaths(config: EngineConfig): SkillsLockPaths {
  return {
    user: path.join(config.home, '.agents', '.skill-lock.json'),
    project: path.join(config.projectRoot, 'skills-lock.json'),
  }
}

// The reader is a pure function over bytes: every lockfile shape is testable without `npx`. The
// global lock is schema v3 and the project lock schema v1, and both share `{ version, skills: {
// <name>: { source, ... } } }`, so a `version` the file spells is accepted as written — a newer
// schema's extra fields survive for the CLI that owns them. A `skills` map entry without a string
// `source` has nothing to install and is skipped with a warning. `file` is only the label the
// warnings carry.
export function parseSkillsLock(bytes: Uint8Array, file: string): SkillsLockRead {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { skills: [], warnings: [`${file}: is not valid UTF-8`] }
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
  // The byte walk reads the same bytes the parse did, so it cannot miss a member; the seen-set
  // only collapses a duplicate key's repeated spelling, and the tail keeps the map's order for
  // anything the walk could not see.
  const seen = new Set<string>()
  const names = (skillsKeyOrder(text) ?? Object.keys(map)).filter((name) => {
    if (seen.has(name) || !(name in map)) return false
    seen.add(name)
    return true
  })
  for (const name of Object.keys(map)) if (!seen.has(name)) names.push(name)
  for (const name of names) {
    const entry = map[name]
    const record = z.record(z.string(), z.unknown()).safeParse(entry)
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a lock entry's source is the discriminator
    const source = record.success && typeof record.data.source === 'string' ? record.data.source : undefined
    if (source === undefined || source === '') {
      warnings.push(`${file}: skill '${name}' has no source and was skipped`)
      continue
    }
    if (source.trimStart().startsWith('-') || name.trimStart().startsWith('-')) {
      const field = source.trimStart().startsWith('-') ? 'source' : 'name'
      warnings.push(`${file}: skill '${name}' ${field} looks like a CLI option and was skipped`)
      continue
    }
    skills.push({ name, source })
  }
  return { skills, warnings }
}

// The filesystem half of the reader: whether the file is there and readable is a warning of its
// own, and the bytes it holds go to the pure parser.
export function readSkillsLock(file: string, tier: EnvironmentTier): SkillsLockRead {
  if (!existsSync(file)) return { skills: [], warnings: [`${file}: no skills lockfile for the ${tier} tier`] }
  try {
    return parseSkillsLock(readFileSync(file), file)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { skills: [], warnings: [`${file}: could not be read: ${reason}`] }
  }
}

// The member names of the `skills` object in file order, or null when the bytes cannot be walked
// — a document JSON.parse accepted cannot produce that, so null only ever means "use the map's
// order". JSON.parse orders integer-like keys numerically — "2" before "10" — but the lockfile's
// order is what the file spells, so the names are read off the bytes and each entry's value
// still comes from the parsed map.
function skillsKeyOrder(text: string): string[] | null {
  const members = jsonObjectMembers(text)
  const skills = members?.reverse().find((member) => member.key === 'skills')
  if (skills === undefined) return null
  return jsonObjectMembers(text, skills.start)?.map((member) => member.key) ?? null
}

interface JsonMember {
  key: string
  // The value's first and last byte offsets, so a member's object can be walked again.
  start: number
  end: number
}

function skipJsonWhitespace(text: string, at: number): number {
  while (at < text.length && ' \t\r\n'.includes(text[at] ?? '')) at += 1
  return at
}

// The index just past the string that opens at `at`, escapes honoured; -1 when unterminated.
function jsonStringEnd(text: string, at: number): number {
  for (let index = at + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1
    else if (text[index] === '"') return index + 1
  }
  return -1
}

// The index just past the value that opens at `at`: a string, an object or array walked with
// strings skipped, or a bare token out to its delimiter.
function jsonValueEnd(text: string, at: number): number {
  const char = text[at]
  if (char === '"') return jsonStringEnd(text, at)
  if (char !== '{' && char !== '[') {
    let index = at
    while (index < text.length && !',}] \t\r\n'.includes(text[index] ?? '')) index += 1
    return index
  }
  let depth = 0
  for (let index = at; index < text.length; index += 1) {
    const current = text[index]
    if (current === '"') {
      const end = jsonStringEnd(text, index)
      if (end === -1) return -1
      index = end - 1
      continue
    }
    if (current === '{' || current === '[') depth += 1
    else if (current === '}' || current === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

// The members of the JSON object that opens at `start` (default: the document's first byte), in
// file order. The document already parsed, so a null here means the walk disagreed with the
// parser — the caller falls back rather than invent an order.
function jsonObjectMembers(text: string, start?: number): JsonMember[] | null {
  let at = skipJsonWhitespace(text, start ?? 0)
  if (text[at] !== '{') return null
  at += 1
  const members: JsonMember[] = []
  for (;;) {
    at = skipJsonWhitespace(text, at)
    if (text[at] === '}') return members
    if (text[at] !== '"') return null
    const keyEnd = jsonStringEnd(text, at)
    if (keyEnd === -1) return null
    let key: string
    try {
      key = JSON.parse(text.slice(at, keyEnd))
    } catch {
      return null
    }
    at = skipJsonWhitespace(text, keyEnd)
    if (text[at] !== ':') return null
    at = skipJsonWhitespace(text, at + 1)
    const valueStart = at
    const valueEnd = jsonValueEnd(text, at)
    if (valueEnd === -1) return null
    members.push({ key, start: valueStart, end: valueEnd })
    at = skipJsonWhitespace(text, valueEnd)
    if (text[at] === ',') {
      at += 1
      continue
    }
    return text[at] === '}' ? members : null
  }
}

export interface SkillsCommand {
  // The exact argv `npx` receives, in order.
  argv: string[]
  cwd: string
  tier: EnvironmentTier
}

export interface SkillsInstallOptions {
  global?: boolean
  yes?: boolean
  dryRun?: boolean
}

// One `npx skills add` per source group: `npx -y skills@latest add <source> --skill <name>...
// [--agent <harness>...] [-g] -y`. Groups keep first-seen source order and file order inside a
// group; the tier's root is the caller's choice, passed in.
export function skillsCommands(
  tier: EnvironmentTier,
  read: SkillsLockRead,
  harnesses: string[],
  root: string,
): SkillsCommand[] {
  const commands: SkillsCommand[] = []
  const bySource = new Map<string, string[]>()
  for (const skill of read.skills) {
    bySource.set(skill.source, [...(bySource.get(skill.source) ?? []), skill.name])
  }
  for (const [source, names] of bySource) {
    const argv = ['-y', 'skills@latest', 'add', source]
    for (const name of names) argv.push('--skill', name)
    // --agent is always present: the gate refused the run before this builder when the tier
    // declared no harnesses, so the skills CLI's detector is never consulted.
    for (const harness of harnesses) argv.push('--agent', harness)
    if (tier === 'user') argv.push('-g')
    argv.push('-y')
    commands.push({ argv, cwd: root, tier })
  }
  return commands
}

// The shell spelling of one command, for the line a real run and a dry run both print. The
// words are file bytes, so the printed line goes through `printable` like every file-derived
// value; the argv that actually runs is the untouched one.
function commandText(command: SkillsCommand): string {
  return `npx ${command.argv.map((word) => shellWord(printable(word))).join(' ')}`
}

// The one spawn in the skills installer: argv goes to `npx` untouched — no shell, so a source or a
// skill name is data, never text a shell could read. stdin is /dev/null like every ACM command.
// User commands set HOME and USERPROFILE to their root so Node's os.homedir() agrees with
// config.home on POSIX and Windows; project commands keep the caller's home. A spawn that
// throws — a NUL byte in an argument, say — is one command's failure, reported the same as a
// non-zero exit, and the groups after it still run.
function runCommand(command: SkillsCommand, env: NodeJS.ProcessEnv): number | null {
  try {
    const childEnv = command.tier === 'user'
      ? { ...env, HOME: path.resolve(command.cwd), USERPROFILE: path.resolve(command.cwd) }
      : env
    const result = spawnSync('npx', command.argv, { cwd: command.cwd, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] })
    return result.status
  } catch {
    return null
  }
}

// `confirm` is the injected prompt: the CLI passes a real TTY reader only where asking is right,
// so `undefined` already means a decided outcome — `-y` runs unasked, a non-TTY run prints and
// stops. A declined answer or EOF runs nothing, exit 0.
export function skillsInstallRun(
  write: (text: string) => void,
  warn: (text: string) => void,
  confirm: ((message: string) => boolean) | undefined,
  options: SkillsInstallOptions = {},
  config: EngineConfig = resolveDefaultConfig(),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const tier: EnvironmentTier = options.global === true ? 'user' : 'project'
  const paths = skillsLockPaths(config)
  const environment = loadEnvironment(config)
  const location = environmentFiles(config).find((item) => item.tier === tier)
  if (location !== undefined) {
    const refusal = environment.refusals.find((item) => path.resolve(item.source) === path.resolve(location.file))
    if (refusal !== undefined) {
      warn(`${printable(refusal.source)}:${refusal.line}:${refusal.column}: refused environment: ${printable(refusal.reason)}\n`)
      return 1
    }
  }
  // The harness gate: a tier that declares no harnesses — absent file or absent key — never
  // reaches the command builder, so no install can guess which agent directories to write.
  if (environment.harnessesByTier[tier].length === 0) {
    warn(`${printable(location?.file ?? path.join(config.projectRoot, 'agents_environ.toml'))}: the ${tier} tier declares no harnesses; add harnesses = [...] to its environment file before installing skills for it\n`)
    return 1
  }
  const read = readSkillsLock(paths[tier], tier)
  for (const warning of read.warnings) warn(`${printable(warning)}\n`)
  if (read.skills.length === 0) {
    if (read.warnings.length === 0) {
      warn(`${printable(paths[tier])}: no skills installed for the ${tier} tier\n`)
    }
    return 0
  }
  const commands = skillsCommands(
    tier,
    read,
    environment.harnessesByTier[tier],
    tier === 'user' ? config.home : config.projectRoot,
  )
  for (const command of commands) write(`${commandText(command)}\n`)
  if (options.dryRun === true) {
    write('dry run: nothing was run\n')
    return 0
  }
  if (options.yes !== true) {
    if (confirm === undefined) return 0
    if (!confirm(`run these ${commands.length} command(s)? [y/N] `)) return 0
  }
  let exitCode = 0
  for (const command of commands) {
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
