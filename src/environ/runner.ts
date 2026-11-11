import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { evaluateChecks } from './check.ts'
import { recordRun } from './history.ts'
import { installCommand } from './command.ts'
import { isPayloadInstall, isSectionInstall, loadEnvironment } from './loader.ts'
import { counted, printable } from './print.ts'
import { headingOf, rewriteSection } from './section.ts'
import type { EnvironmentTier, FileRefusal, InstallCommand, Presence, ResolvedProvision, SectionInstall } from './types.ts'

// The run is the only place ACM executes anything. `install` is the single field that acts, in one
// of three spellings, and the preview prints what the run does. A string command is its own text —
// nothing is interpolated or evaluated on the way — and that text is what runs. A Payload is spelled
// `sh <payload> <args…>`, every word re-quoted the way a shell reads it back, and that spelling is
// what runs. A Section install never reaches a shell: the preview prints the label
// `write <file> from <section>` with no `$` prefix because there is no command text, and the write
// is what happens. A Check still only reads, so the Presence a run reports is the files' answer
// rather than the command's own word for what it did.
//
// A run is a function of the environment plus the filesystem: the preview is read and printed before
// the first command starts, the commands go in loader order, and a Present Provision is left alone
// unless the caller runs everything.

export interface InstallOptions {
  // Off a terminal the run is a dry run unless the caller asks for one, so a piped or scheduled
  // invocation cannot change the machine by accident.
  dryRun?: boolean
  force?: boolean
  // Provision names or tags to restrict the run to. Empty means the whole environment.
  only?: string[]
  // Only the entries one tier owns after the merge. `--tier` restricts a run the way `--only` does.
  tier?: EnvironmentTier
}

export interface InstallEntry {
  provision: ResolvedProvision
  before: Presence
  after: Presence
  // False for a skipped Provision and for every Provision of a dry run.
  attempted: boolean
  // The shell's status, or null when it never started.
  commandExit: number | null
  // Why the command failed, for the summary. Null when it did not fail or did not run.
  failure: string | null
}

export interface InstallOutcome {
  entries: InstallEntry[]
  refusals: FileRefusal[]
  dryRun: boolean
  exitCode: number
}

interface Previewed {
  provision: ResolvedProvision
  presence: Presence
  skip: boolean
}

// The identity of one Provision's shared Install command inside a run: the Provision's name, the
// Tier root it runs from, and the command's spelling. Two entries of one Provision declared in one
// file share it, so the command runs once; the same name and spelling at two tiers are two
// commands — a relative path means a different file under each root — and each runs.
function sharedKey(provision: ResolvedProvision, install: InstallCommand): string {
  return `${provision.name}\u0000${provision.root}\u0000${installCommand(install)}`
}

// Where each shared command prints: once, above the first entry that will run it. When every entry
// of its group is skipped the command does not run, but the preview still shows it above the
// group's first entry — what a run will not do is part of what a human reviews.
function sharedTriggers(previewed: Previewed[]): Set<number> {
  const groups = new Map<string, number[]>()
  previewed.forEach((item, index) => {
    if (item.provision.sharedInstall === null) return
    const key = sharedKey(item.provision, item.provision.sharedInstall)
    groups.set(key, [...(groups.get(key) ?? []), index])
  })
  const triggers = new Set<number>()
  for (const indices of groups.values()) {
    triggers.add(indices.find((index) => !previewed[index].skip) ?? indices[0])
  }
  return triggers
}

// One command's answer: the shell's status, and the text the summary reports when it went wrong.
interface CommandResult {
  status: number | null
  failure: string | null
}

function label(provision: ResolvedProvision): string {
  return `${printable(provision.name)} (${provision.harness})`
}

// Every Provision, harness, tier, and what it runs — the exact command, or the label a Section write
// prints because it has no command text — all of it before anything runs. A Present
// Provision is still printed: what a run will not do is part of what a human reviews. The selection
// line names the `--only` values that produced this preview, so a tag-filtered run does not read as
// the whole environment.
function previewText(previewed: Previewed[], dryRun: boolean, only: string[]): string {
  if (previewed.length === 0) return 'preview: no Provisions declared\n'
  const nameWidth = Math.max(...previewed.map((item) => printable(item.provision.name).length))
  const harnessWidth = Math.max(...previewed.map((item) => item.provision.harness.length))
  const tierWidth = Math.max(...previewed.map((item) => item.provision.tier.length))
  const toRun = previewed.filter((item) => !item.skip).length
  const lines = [
    `preview: ${counted(previewed.length, 'entry', 'entries')}, ${toRun} to run, ${previewed.length - toRun} already present${dryRun ? ' · dry run' : ''}`,
  ]
  if (only.length > 0) lines.push(`selection: --only ${only.join(', ')}`)
  const triggers = sharedTriggers(previewed)
  for (const [index, item] of previewed.entries()) {
    const action = item.skip ? 'present, skipped' : item.presence === 'present' ? 'present, forced' : item.presence
    lines.push(
      `  ${printable(item.provision.name).padEnd(nameWidth)}  ${item.provision.harness.padEnd(harnessWidth)}  ${item.provision.tier.padEnd(tierWidth)}  ${action}`,
    )
    // The shared command prints once, labeled, above the first entry that runs it; the entry's own
    // command prints under its row as before.
    if (triggers.has(index) && item.provision.sharedInstall !== null) {
      lines.push(installPreviewLine(item.provision.sharedInstall, true))
    }
    if (item.provision.install !== null) lines.push(installPreviewLine(item.provision.install, false))
  }
  return `${lines.join('\n')}\n`
}

// One Install command's preview line: `$ ` marks a command that runs — a Section write's label
// prints without it, because there is no command text for the prompt to mark — and `shared: `
// marks the Provision's shared command, which prints once for the group rather than per entry.
function installPreviewLine(install: InstallCommand, shared: boolean): string {
  const spelled = printable(installCommand(install))
  const marks = `${isSectionInstall(install) ? '' : '$ '}${shared ? 'shared: ' : ''}`
  return `    ${marks}${spelled}`
}

function joined(labels: string[]): string {
  return labels.length === 0 ? 'none' : labels.join(', ')
}

// A failure reason can carry a path read from the environment file and an operating system's own
// message, so it reaches the summary through the same sanitiser a Provision name does: one line in,
// one line out.
function reason(entry: InstallEntry): string {
  if (entry.failure !== null) return printable(entry.failure)
  // An entry that ran can still have no status of its own: every Install command it had left was
  // a shared one an earlier entry of the same Provision already spent.
  return entry.commandExit === null ? 'no command ran' : `exit ${entry.commandExit}`
}

function summaryText(entries: InstallEntry[], refusals: FileRefusal[]): string {
  const present = entries.filter((entry) => !entry.attempted)
  const ran = entries.filter((entry) => entry.attempted)
  const failed = entries.filter((entry) => entry.failure !== null)
  const absent = entries.filter((entry) => entry.after !== 'present')
  const lines = [
    '',
    `summary: ${counted(entries.length, 'entry', 'entries')}, ${present.length} already present, ${ran.length} ran, ${failed.length} failed, ${absent.length} still absent`,
    `  already present: ${joined(present.map((entry) => label(entry.provision)))}`,
    `  ran: ${joined(ran.map((entry) => `${label(entry.provision)} ${reason(entry)}`))}`,
    `  failed: ${joined(failed.map((entry) => `${label(entry.provision)} ${reason(entry)}`))}`,
    // An `unknown` is not an absence, so the value is printed beside the entry rather than folded
    // into a count a reader would take as "not installed".
    `  still absent: ${joined(absent.map((entry) => `${label(entry.provision)} ${entry.after}`))}`,
  ]
  if (refusals.length > 0) {
    lines.push(`  refused: ${refusals.length} environment file(s) contributed nothing, so this run is partial`)
  }
  return `${lines.join('\n')}\n`
}

function notRun(provision: ResolvedProvision, presence: Presence): InstallEntry {
  return { provision, before: presence, after: presence, attempted: false, commandExit: null, failure: null }
}

// The one spawn in ACM. stdin is /dev/null, so a command that asks a question gets end of input and
// fails now instead of holding the run. stdout and stderr are the run's own. No `env` is passed, so
// the parent environment arrives unchanged and ACM adds no variables. `shell: true` is the POSIX
// shell with the command text as a single argument, which is the text that was printed.
// shortcut: no per-command timeout; add one when a real command hangs.
function spawnInstall(install: InstallCommand, root: string): CommandResult {
  // A Section install writes bytes itself, so it never reaches a shell.
  if (isSectionInstall(install)) return sectionInstall(install)
  const command = installCommand(install)
  // A Payload that cannot be read fails its entry here, before the shell starts: `sh` would report
  // the same fault, but only after a spawn the preview said nothing about.
  if (isPayloadInstall(install)) {
    try {
      accessSync(install.payload, constants.R_OK)
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      return { status: null, failure: `${install.payload} could not be read: ${cause}` }
    }
  }
  const result = spawnSync(command, {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: true,
  })
  if (result.status === 0) return { status: 0, failure: null }
  if (result.status !== null) return { status: result.status, failure: `exit ${result.status}` }
  // A signal, or a shell that never started at all: either way there is no status of its own.
  if (result.signal !== null) return { status: null, failure: `signal ${result.signal}` }
  return { status: null, failure: result.error === undefined ? 'did not start' : result.error.message }
}

// The one install that is a write rather than a spawn: the Payload's text replaces the Section its
// heading names, appends it when the Section is missing, and creates the file when the file itself
// is missing. Nothing outside the Section is touched.
function sectionInstall(install: SectionInstall): CommandResult {
  let payload: string
  try {
    payload = readFileSync(install.section, 'utf8')
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    return { status: null, failure: `${install.section} could not be read: ${cause}` }
  }
  const spelled = headingOf(payload)
  if (!spelled.ok) return { status: null, failure: `${install.section} ${spelled.reason}` }
  const heading = spelled.heading
  let existing: string
  try {
    existing = readFileSync(install.file, 'utf8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      const cause = error instanceof Error ? error.message : String(error)
      return { status: null, failure: `${install.file} could not be read: ${cause}` }
    }
    // A missing file is the one read failure that is not a failure: the Section is missing too.
    existing = ''
  }
  const written = rewriteSection(existing, payload, heading)
  if (!written.ok) return { status: null, failure: `${install.file}: ${written.reason}` }
  try {
    mkdirSync(dirname(install.file), { recursive: true })
    writeFileSync(install.file, written.text)
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    return { status: null, failure: `${install.file} could not be written: ${cause}` }
  }
  return { status: 0, failure: null }
}

export function installRun(
  write: (text: string) => void,
  options: InstallOptions = {},
  config: EngineConfig = resolveDefaultConfig(),
): InstallOutcome {
  const environment = loadEnvironment(config)
  const dryRun = options.dryRun ?? !process.stdin.isTTY
  const only = options.only ?? []
  const outcome = (entries: InstallEntry[], exitCode: number, isDryRun: boolean): InstallOutcome => ({
    entries,
    refusals: environment.refusals,
    dryRun: isDryRun,
    exitCode,
  })
  // The tier narrows the environment before anything else reads it, so a name or tag it leaves out
  // is one this run cannot reach and says so instead of running nothing quietly.
  const inTier =
    options.tier === undefined
      ? environment.provisions
      : environment.provisions.filter((entry) => entry.tier === options.tier)
  // A value that matches no Provision name and no tag is a typo, not an empty environment: running
  // the rest would look like the named fix succeeded.
  const matches = (value: string, entry: ResolvedProvision): boolean => entry.name === value || entry.tags.includes(value)
  const missing = only.filter((value) => !inTier.some((entry) => matches(value, entry)))
  if (missing.length > 0) {
    write(`no Provision named or tagged ${missing.join(', ')} (each tried as a name and as a tag)\n`)
    return outcome([], 1, dryRun)
  }
  const selected = only.length === 0 ? inTier : inTier.filter((entry) => only.some((value) => matches(value, entry)))
  const previewed: Previewed[] = selected.map((provision) => {
    const presence = evaluateChecks(provision.checks).presence
    return { provision, presence, skip: presence === 'present' && options.force !== true }
  })
  write(previewText(previewed, dryRun, only))
  if (dryRun) {
    write('\ndry run: nothing was run\n')
    return outcome(
      previewed.map((item) => notRun(item.provision, item.presence)),
      environment.refusals.length === 0 ? 0 : 1,
      true,
    )
  }
  const entries: InstallEntry[] = []
  // A Provision's shared Install command runs at most once per run, before the first entry that
  // needs it, and is skipped entirely when no entry of the Provision runs. The key is the
  // Provision's name and the command's spelling, so two entries that share one declaration run it
  // once while a same-named Provision at another tier with a different command still runs its own.
  const sharedRan = new Set<string>()
  for (const item of previewed) {
    const provision = item.provision
    if (item.skip) {
      entries.push(notRun(provision, item.presence))
      continue
    }
    // Presence is live, not the preview's: a shared command an earlier entry of this Provision
    // already ran can make this entry present before its turn comes, and it then runs nothing.
    const before = evaluateChecks(provision.checks).presence
    if (before === 'present' && options.force !== true) {
      entries.push(notRun(provision, before))
      continue
    }
    write(`\n→ ${label(provision)} ${provision.tier} in ${provision.root}\n`)
    const commands: InstallCommand[] = []
    if (provision.sharedInstall !== null) {
      const key = sharedKey(provision, provision.sharedInstall)
      if (!sharedRan.has(key)) {
        sharedRan.add(key)
        commands.push(provision.sharedInstall)
      }
    }
    if (provision.install !== null) commands.push(provision.install)
    let commandExit: number | null = null
    let failure: string | null = null
    for (const command of commands) {
      const result = spawnInstall(command, provision.root)
      // Each command is its own Run, recorded now, before the next command starts: the row is
      // committed on its own, so an interrupted run keeps the history of the commands that had
      // already finished. The presence recorded is this entry's answer after that command.
      recordRun(provision, command, result.status, evaluateChecks(provision.checks).presence, config)
      if (result.failure !== null && failure === null) {
        failure = result.failure
        commandExit = result.status
      } else if (failure === null) {
        commandExit = result.status
      }
    }
    // The answer after the commands, not before and not the command's report of itself: a command
    // that half-worked is present if its Check now passes.
    const after = evaluateChecks(provision.checks).presence
    entries.push({
      provision,
      before,
      after,
      attempted: true,
      commandExit,
      failure,
    })
  }
  write(summaryText(entries, environment.refusals))
  // A failure and a machine still short of what the file declares are both non-zero, so a wrapper
  // script and the summary agree. A refused file leaves the run partial, which is also not success.
  const clean =
    entries.every((entry) => entry.failure === null && entry.after === 'present') && environment.refusals.length === 0
  return outcome(entries, clean ? 0 : 1, false)
}
