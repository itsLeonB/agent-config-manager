import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import { evaluateChecks } from './check.ts'
import { entryKey, loadEnvironment } from './loader.ts'
import { counted, printable } from './print.ts'
import { ENVIRONMENT_TIERS } from './types.ts'
import type {
  EnvironmentTier,
  FileRefusal,
  ProvisionDocumentRow,
  ProvisionRow,
  Run,
} from './types.ts'

// The environment's whole public surface. The CLI and the MCP face import this module and nothing
// below it: the parser, the evaluator, and the loader are implementation, and a face that reached
// past this file could hold an answer the other face would not.
//
// Presence is never stored: every call re-reads the files a Check names, so the answer is this
// machine's now rather than a remembered one.

// The closed harness list, re-exported because it is the filter's domain and a face may not reach
// into the engine to spell it. The tier list is re-exported for the same reason.
export { HARNESSES } from '../engine/adapters/types.ts'
export { ENVIRONMENT_TIERS } from './types.ts'
export type { EnvironmentTier } from './types.ts'

// A native read reuses the harness readers and answers live: nothing is stored, and no Install
// command is read or run. Re-exported so both faces ask the service, never an adapter.
export { readNativeConfig } from './native-read.ts'

// A definition writes an environment file and nothing else: it never runs an Install command and
// never evaluates a Check, so adding a Provision and converging one stay two separate acts.
export { defineProvision } from './define.ts'
export type { DefineOutcome, DefineRequest } from './define.ts'

// A declaration writes one tier's harness list and nothing else, through the same outcome shape a
// definition answers with: the bytes are the only effect, and the parser decides whether they load.
export { declareHarnesses } from './declare.ts'
export type { DeclareOutcome, DeclareRequest } from './declare.ts'

// The skills installer is a CLI surface only, like the run: it converges the lockfiles and no MCP
// tool can start it. `readSkillsLock` and `skillsCommands` stay below the service for the same
// reason — a face asks for the run, never for a lockfile's bytes.
export { skillsInstallRun } from './skills.ts'
export type { SkillsInstallOptions } from './skills.ts'

// The run is the one command that executes anything, and it answers through this module like every
// other part of the environment. It is a CLI surface only: nothing the MCP face registers can start
// one.
export { installRun } from './runner.ts'
export type { InstallEntry, InstallOptions, InstallOutcome } from './runner.ts'

// The history a run leaves. It is read through this module so a face never opens the store itself.
export { latestRuns } from './history.ts'

export interface StatusFilter {
  harness?: string
  name?: string
  // Only the entries a tier owns after the merge, which is what `--tier` asks for.
  tier?: EnvironmentTier
}

export interface Status {
  provisions: ProvisionRow[]
  refusals: FileRefusal[]
  // Each tier's declared harness list — a file's list is never merged into another tier's.
  harnesses: Record<EnvironmentTier, string[]>
  // Where this answer was read from. Printed in the footer because a harness that started acm
  // somewhere unexpected otherwise reads an empty answer and guesses why.
  home: string
  projectRoot: string
  storePath: string
  readFiles: { tier: EnvironmentTier; file: string }[]
}

export interface StatusDocument {
  provisions: ProvisionDocumentRow[]
  // The same per-tier harness lists the footer prints, so `--json` carries what a human reads.
  harnesses: Record<EnvironmentTier, string[]>
}

export function readStatus(filter: StatusFilter = {}, config: EngineConfig = resolveDefaultConfig()): Status {
  const environment = loadEnvironment(config)
  const rows = new Map<string, ProvisionRow>()
  for (const provision of environment.provisions) {
    if (filter.name !== undefined && filter.name !== provision.name) continue
    if (filter.harness !== undefined && filter.harness !== provision.harness) continue
    if (filter.tier !== undefined && filter.tier !== provision.tier) continue
    // Grouping keeps file order: a Provision's entries are the ones the file declares for it, in the
    // order it declares them, and a repeated harness would be a duplicate key the file cannot hold.
    const row = rows.get(provision.name) ?? { name: provision.name, tags: provision.tags, harnesses: [] }
    rows.set(provision.name, row)
    const answer = evaluateChecks(provision.checks)
    row.harnesses.push({
      harness: provision.harness,
      tier: provision.tier,
      source: provision.source,
      presence: answer.presence,
      detail: answer.detail,
    })
  }
  return {
    provisions: [...rows.values()],
    refusals: environment.refusals,
    harnesses: environment.harnessesByTier,
    home: config.home,
    projectRoot: config.projectRoot,
    storePath: config.storePath,
    // What the loader actually read, so the answer names the files behind it rather than a second
    // guess at where they would have been.
    readFiles: environment.readFiles,
  }
}

// The same rows as data, for `--json` and for the MCP tool: one document, so a script and an agent
// read the answer a human reads. `runs` is the most recent Run per (Provision, harness) — the caller
// passes the history it wants shown, so the printed status stays Presence alone.
export function statusDocument(status: Status, runs: Run[] = []): StatusDocument {
  const latest = new Map(runs.map((run) => [entryKey(run.provision, run.harness), run]))
  return {
    harnesses: status.harnesses,
    provisions: status.provisions.map((row) => ({
      name: row.name,
      tags: row.tags,
      harnesses: row.harnesses.map((entry) => {
        const run = latest.get(entryKey(row.name, entry.harness))
        // An entry with no Run has no key, not a null one: the tool answer the spec declares is
        // Presence and detail, and a caller that asked for no history gets exactly that.
        return run === undefined ? entry : { ...entry, latestRun: run }
      }),
    })),
  }
}

// The harness list is per file, so the answers are per tier: no filter returns both tiers'
// lists keyed by tier, and a tier filter narrows to that file's own list. A file with no list
// declares none — the default three are gone.
export function listHarnesses(config?: EngineConfig): Record<EnvironmentTier, string[]>
export function listHarnesses(filter: { tier?: EnvironmentTier }, config?: EngineConfig): string[] | Record<EnvironmentTier, string[]>
export function listHarnesses(
  filterOrConfig: { tier?: EnvironmentTier } | EngineConfig = {},
  config?: EngineConfig,
): string[] | Record<EnvironmentTier, string[]> {
  // A bare config is the no-filter call; a filter object is the tiered one.
  const filter = 'home' in filterOrConfig ? {} : filterOrConfig
  const resolved = 'home' in filterOrConfig ? filterOrConfig : config
  const environment = loadEnvironment(resolved ?? resolveDefaultConfig())
  if (filter.tier === undefined) return environment.harnessesByTier
  return environment.harnessesByTier[filter.tier]
}

export function formatRefusal(refusal: FileRefusal): string {
  return `${refusal.source}:${refusal.line}:${refusal.column}: ${refusal.reason}`
}

// Where acm thinks it is. The store path is the one fact derived from where the bundle is installed,
// so it is also the answer the built-bundle test reads.
function footer(status: Status): string {
  const entries = status.provisions.reduce((total, row) => total + row.harnesses.length, 0)
  const harnesses = ENVIRONMENT_TIERS.map(
    (tier) => `${tier} ${status.harnesses[tier].length > 0 ? status.harnesses[tier].join(', ') : 'none declared'}`,
  ).join('; ')
  return `${counted(entries, 'entry', 'entries')} over ${counted(status.provisions.length, 'provision', 'provisions')} · project ${shorten(status.projectRoot, status.home)} · store ${shorten(status.storePath, status.home)} · harnesses: ${harnesses}`
}

function shorten(file: string, home: string): string {
  // The separator matters: `/home/ann` is not the home directory of `/home/anna`.
  return file === home || file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

// A pure function of the rows and the paths they were read from: tickets 04 to 06 reuse it rather
// than printing from inside a command.
export function formatStatus(status: Status): string {
  const rows = status.provisions
  const harnessWidth = Math.max('harness'.length, ...rows.flatMap((row) => row.harnesses.map((entry) => printable(entry.harness).length)))
  const sourceWidth = Math.max('source'.length, ...rows.flatMap((row) => row.harnesses.map((entry) => shorten(entry.source, status.home).length)))
  const nameWidth = Math.max('provision'.length, ...rows.map((row) => printable(row.name).length))
  const lines: string[] = []
  if (rows.length === 0) {
    lines.push('no Provisions declared')
  } else {
    lines.push(`${'provision'.padEnd(nameWidth)}  ${'harness'.padEnd(harnessWidth)}  ${'source'.padEnd(sourceWidth)}  presence`)
    for (const row of rows) {
      for (const entry of row.harnesses) {
        const detail = entry.detail === null ? '' : `  ${printable(entry.detail)}`
        lines.push(
          `${printable(row.name).padEnd(nameWidth)}  ${printable(entry.harness).padEnd(harnessWidth)}  ${shorten(entry.source, status.home).padEnd(sourceWidth)}  ${entry.presence}${detail}`,
        )
      }
    }
  }
  if (rows.length === 0 && status.readFiles.length) {
    lines.push('tiers read:')
    for (const location of status.readFiles) lines.push(`  ${location.tier} ${shorten(location.file, status.home)}`)
  }
  return `${lines.join('\n')}\n\n${footer(status)}\n`
}
