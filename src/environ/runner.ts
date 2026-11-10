import { spawnSync } from 'node:child_process'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { evaluate } from './check.ts'
import { recordRun } from './history.ts'
import { loadEnvironment } from './loader.ts'
import { counted, printable } from './print.ts'
import type { EnvironmentTier, FileRefusal, Presence, ResolvedProvision } from './types.ts'

// The run is the only place ACM executes anything. `install` is the single field that reaches a
// shell, and the text printed is the text run: nothing is interpolated, re-quoted, or evaluated on
// the way. A Check still only reads, so the Presence a run reports is the files' answer rather than
// the command's own word for what it did.
//
// A run is a function of the environment plus the filesystem: the preview is read and printed before
// the first command starts, the commands go in loader order, and a Present Provision is left alone
// unless the caller runs everything.

export interface InstallOptions {
  // Off a terminal the run is a dry run unless the caller asks for one, so a piped or scheduled
  // invocation cannot change the machine by accident.
  dryRun?: boolean
  force?: boolean
  // Provision names to restrict the run to. Empty means the whole environment.
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

// One command's answer: the shell's status, and the text the summary reports when it went wrong.
interface CommandResult {
  status: number | null
  failure: string | null
}

function label(provision: ResolvedProvision): string {
  return `${printable(provision.name)} (${provision.harness})`
}

// Every Provision, harness, tier, and the exact command, all of it before anything runs. A Present
// Provision is still printed: what a run will not do is part of what a human reviews.
function previewText(previewed: Previewed[], dryRun: boolean): string {
  if (previewed.length === 0) return 'preview: no Provisions declared\n'
  const nameWidth = Math.max(...previewed.map((item) => printable(item.provision.name).length))
  const harnessWidth = Math.max(...previewed.map((item) => item.provision.harness.length))
  const tierWidth = Math.max(...previewed.map((item) => item.provision.tier.length))
  const toRun = previewed.filter((item) => !item.skip).length
  const lines = [
    `preview: ${counted(previewed.length, 'entry', 'entries')}, ${toRun} to run, ${previewed.length - toRun} already present${dryRun ? ' · dry run' : ''}`,
  ]
  for (const item of previewed) {
    const action = item.skip ? 'present, skipped' : item.presence === 'present' ? 'present, forced' : item.presence
    lines.push(
      `  ${printable(item.provision.name).padEnd(nameWidth)}  ${item.provision.harness.padEnd(harnessWidth)}  ${item.provision.tier.padEnd(tierWidth)}  ${action}`,
    )
    lines.push(`    $ ${printable(item.provision.install)}`)
  }
  return `${lines.join('\n')}\n`
}

function joined(labels: string[]): string {
  return labels.length === 0 ? 'none' : labels.join(', ')
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
    `  ran: ${joined(ran.map((entry) => `${label(entry.provision)} ${entry.failure ?? `exit ${entry.commandExit}`}`))}`,
    `  failed: ${joined(failed.map((entry) => `${label(entry.provision)} ${entry.failure}`))}`,
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
function spawnInstall(provision: ResolvedProvision): CommandResult {
  const result = spawnSync(provision.install, {
    cwd: provision.root,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: true,
  })
  if (result.status === 0) return { status: 0, failure: null }
  if (result.status !== null) return { status: result.status, failure: `exit ${result.status}` }
  // A signal, or a shell that never started at all: either way there is no status of its own.
  if (result.signal !== null) return { status: null, failure: `signal ${result.signal}` }
  return { status: null, failure: result.error === undefined ? 'did not start' : result.error.message }
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
  // The tier narrows the environment before anything else reads it, so a name it leaves out is a
  // name this run cannot reach and says so instead of running nothing quietly.
  const inTier =
    options.tier === undefined
      ? environment.provisions
      : environment.provisions.filter((entry) => entry.tier === options.tier)
  // A name that matches no Provision is a typo, not an empty environment: running the rest would
  // look like the named fix succeeded.
  const missing = only.filter((name) => !inTier.some((entry) => entry.name === name))
  if (missing.length > 0) {
    write(`no Provision named ${missing.join(', ')}\n`)
    return outcome([], 1, dryRun)
  }
  const selected = only.length === 0 ? inTier : inTier.filter((entry) => only.includes(entry.name))
  const previewed: Previewed[] = selected.map((provision) => {
    const presence = evaluate(provision.check).presence
    return { provision, presence, skip: presence === 'present' && options.force !== true }
  })
  write(previewText(previewed, dryRun))
  if (dryRun) {
    write('\ndry run: nothing was run\n')
    return outcome(
      previewed.map((item) => notRun(item.provision, item.presence)),
      environment.refusals.length === 0 ? 0 : 1,
      true,
    )
  }
  const entries: InstallEntry[] = []
  for (const item of previewed) {
    if (item.skip) {
      entries.push(notRun(item.provision, item.presence))
      continue
    }
    write(`\n→ ${label(item.provision)} ${item.provision.tier} in ${item.provision.root}\n`)
    const command = spawnInstall(item.provision)
    // The answer after the command, not before and not the command's report of itself: a command
    // that half-worked is present if its Check now passes.
    const after = evaluate(item.provision.check).presence
    // Recorded now, before the next command starts: the row is committed on its own, so an
    // interrupted run keeps the history of the commands that had already finished.
    recordRun(item.provision, command.status, after, config)
    entries.push({
      provision: item.provision,
      before: item.presence,
      after,
      attempted: true,
      commandExit: command.status,
      failure: command.failure,
    })
  }
  write(summaryText(entries, environment.refusals))
  // A failure and a machine still short of what the file declares are both non-zero, so a wrapper
  // script and the summary agree. A refused file leaves the run partial, which is also not success.
  const clean =
    entries.every((entry) => entry.failure === null && entry.after === 'present') && environment.refusals.length === 0
  return outcome(entries, clean ? 0 : 1, false)
}
