import { readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { resolveDefaultConfig } from '../engine/config.ts'
import type { EngineConfig } from '../engine/config.ts'
import type { HarnessId } from '../engine/adapters/types.ts'
import { evaluateCheck } from './check.ts'
import { loadEnvironment } from './loader.ts'
import type { Check, FileRefusal, ProvisionRow } from './types.ts'

// The environment's whole public surface. The CLI and the MCP face import this module and nothing
// below it: the parser, the evaluator, and the loader are implementation, and a face that reached
// past this file could hold an answer the other face would not.
//
// Presence is never stored: every call re-reads the files a Check names, so the answer is this
// machine's now rather than a remembered one.

// The closed harness list, re-exported because it is the filter's domain and a face may not reach
// into the engine to spell it.
export { HARNESSES } from '../engine/adapters/types.ts'

// The run is the one command that executes anything, and it answers through this module like every
// other part of the environment. It is a CLI surface only: nothing the MCP face registers can start
// one.
export { installRun } from './runner.ts'
export type { InstallEntry, InstallOptions, InstallOutcome } from './runner.ts'

export interface StatusFilter {
  harness?: HarnessId
  name?: string
}

export interface Status {
  provisions: ProvisionRow[]
  refusals: FileRefusal[]
  // Where this answer was read from. Printed in the footer because a harness that started acm
  // somewhere unexpected otherwise reads an empty answer and guesses why.
  home: string
  projectRoot: string
  storePath: string
}

export interface StatusDocument {
  provisions: ProvisionRow[]
}

// A Check names one file and this is that file's only I/O: no process, no network, no write. A file
// that is not there is `null`, which the evaluator answers as an absence.
function checkBytes(check: Check): string | null {
  if (!('file' in check)) return null
  try {
    return readFileSync(check.file, 'utf8')
  } catch {
    return null
  }
}

export function readStatus(filter: StatusFilter = {}, config: EngineConfig = resolveDefaultConfig()): Status {
  const environment = loadEnvironment(config)
  const rows = new Map<string, ProvisionRow>()
  for (const provision of environment.provisions) {
    if (filter.name !== undefined && filter.name !== provision.name) continue
    if (filter.harness !== undefined && filter.harness !== provision.harness) continue
    // Grouping keeps file order: a Provision's entries are the ones the file declares for it, in the
    // order it declares them, and a repeated harness would be a duplicate key the file cannot hold.
    const row = rows.get(provision.name) ?? { name: provision.name, tags: provision.tags, harnesses: [] }
    rows.set(provision.name, row)
    // `PATH` as this process inherited it, split for the evaluator: a Check reads it, never runs it.
    const answer = evaluateCheck(provision.check, {
      bytes: checkBytes(provision.check),
      pathDirs: (process.env.PATH ?? '').split(delimiter),
    })
    row.harnesses.push({
      harness: provision.harness,
      tier: provision.tier,
      presence: answer.presence,
      detail: answer.detail,
    })
  }
  return {
    provisions: [...rows.values()],
    refusals: environment.refusals,
    home: config.home,
    projectRoot: config.projectRoot,
    storePath: config.storePath,
  }
}

// The same rows as data, for `--json` and for the MCP tool: one document, so a script and an agent
// read the answer a human reads.
export function statusDocument(status: Status): StatusDocument {
  return { provisions: status.provisions }
}

export function formatRefusal(refusal: FileRefusal): string {
  return `${refusal.source}:${refusal.line}:${refusal.column}: ${refusal.reason}`
}

// Where acm thinks it is. The store path is the one fact derived from where the bundle is installed,
// so it is also the answer the built-bundle test reads.
function footer(status: Status): string {
  const entries = status.provisions.reduce((total, row) => total + row.harnesses.length, 0)
  return `${counted(entries, 'entry', 'entries')} over ${counted(status.provisions.length, 'provision', 'provisions')} · project ${shorten(status.projectRoot, status.home)} · store ${shorten(status.storePath, status.home)}`
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function shorten(file: string, home: string): string {
  // The separator matters: `/home/ann` is not the home directory of `/home/anna`.
  return file === home || file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

// A Provision name and a Check's detail come from a file, so control characters in them would forge
// or corrupt the row they are printed in.
function printable(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
}

// A pure function of the rows and the paths they were read from: tickets 04 to 06 reuse it rather
// than printing from inside a command.
export function formatStatus(status: Status): string {
  const rows = status.provisions
  const harnessWidth = Math.max('harness'.length, ...rows.flatMap((row) => row.harnesses.map((entry) => entry.harness.length)))
  const nameWidth = Math.max('provision'.length, ...rows.map((row) => printable(row.name).length))
  const lines: string[] = []
  if (rows.length === 0) {
    lines.push('no Provisions declared')
  } else {
    lines.push(`${'provision'.padEnd(nameWidth)}  ${'harness'.padEnd(harnessWidth)}  presence`)
    for (const row of rows) {
      for (const entry of row.harnesses) {
        const detail = entry.detail === null ? '' : `  ${printable(entry.detail)}`
        lines.push(
          `${printable(row.name).padEnd(nameWidth)}  ${entry.harness.padEnd(harnessWidth)}  ${entry.presence}${detail}`,
        )
      }
    }
  }
  return `${lines.join('\n')}\n\n${footer(status)}\n`
}
