#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolveDefaultConfig } from '../engine/config.ts'
import {
  applyPlan,
  discover,
  inspectInstallation,
  listInstallations,
  planMirror,
  setupSelf,
  verifyPlanDocument,
} from '../engine/service.ts'
import type { Inspection, SetupHarness, SetupReport } from '../engine/service.ts'
import type { InstallationRow } from '../server/store.cjs'
import type { Json } from '../types/dashboard'

const USAGE = `usage: acm <command> [--project-root <dir>]

  --project-root <dir>  read that project's config instead of the project acm is installed in;
                        the store stays where acm is, so both projects share one inventory

  list     report the inventory the store holds
           [--category <category>] [--harness <harness>] [--scope <scope>] [--all] [--json]
  inspect  report one installation's known fields, each credential withheld with its verdict
           <id|prefix> [--json]
  mirror   print the plan for moving one installation into a target tier, writing nothing
           <id|prefix> --target <harness:tier> --plan
  apply    execute the plan document exactly as given, and record what landed
           <plan.json|-> [--on-conflict abort|replace]
  verify   re-read the target and report each of the plan's assertions
           <plan.json|->
  setup    install this acm into all three harnesses through a plan, then apply it
           [--on-conflict abort|replace] [--json]
  mcp serve  speak the MCP protocol over stdin/stdout, exposing the five tools
`

interface ListOptions {
  category?: string
  harness?: string
  scope?: string
  all: boolean
  json: boolean
}

// The project a pass reads defaults to where acm is installed, so a caller names another one here.
// The flag is stripped before dispatch: each subcommand's own parser rejects what it does not know.
function withoutProjectRoot(argv: string[]): string[] | null {
  const at = argv.findIndex((arg) => arg === '--project-root' || arg.startsWith('--project-root='))
  if (at === -1) return argv
  const arg = argv[at]
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[at + 1]
  if (value === undefined || value === '' || value.startsWith('--')) return null
  // A path that is not a directory would scan nothing and report an empty project, which reads like
  // "this project has no config" rather than "the flag was wrong".
  const root = path.resolve(value)
  try {
    if (!statSync(root).isDirectory()) return null
  } catch {
    return null
  }
  process.env.ACM_PROJECT_ROOT = root
  return arg.includes('=') ? [...argv.slice(0, at), ...argv.slice(at + 1)] : [...argv.slice(0, at), ...argv.slice(at + 2)]
}

function main(input: string[]): number | Promise<number> {
  const stripped = withoutProjectRoot(input)
  if (stripped === null) {
    process.stderr.write('--project-root needs an existing directory\n')
    return 1
  }
  // The boundary overrides are read from the environment by the engine, so the flag lands there
  // before any subcommand resolves its config.
  const argv = stripped
  const command = argv[0]
  const rest = argv.slice(1)
  // The MCP face loads the SDK only when it is asked for it: every other subcommand stays lean.
  if (command === 'mcp' && rest[0] === 'serve' && rest.length === 1) return mcpServe()
  if (command === 'list') return list(rest)
  if (command === 'inspect') return inspect(rest)
  if (command === 'mirror') return mirror(rest)
  if (command === 'apply') return apply(rest)
  if (command === 'verify') return verify(rest)
  if (command === 'setup') return setup(rest)
  process.stderr.write(USAGE)
  return 1
}

function list(argv: string[]): number {  const options = parseListOptions(argv)
  if (options === null) {
    process.stderr.write(USAGE)
    return 1
  }
  const config = resolveDefaultConfig()
  // Discovery first, then a read of the store: what is printed is what was recorded, not a second
  // parse of the native files.
  const scan = discover(config)
  const inventory = listInstallations(config, {
    category: options.category,
    harness: options.harness,
    scope: options.scope,
    includeRemoved: options.all,
  })
  if (options.json) {
    // The pass always covers every harness; only what is emitted follows the filter.
    const scanOut =
      options.harness === undefined
        ? scan
        : { ...scan, tierHealth: scan.tierHealth.filter((health) => health.harness === options.harness) }
    process.stdout.write(`${JSON.stringify({ scan: scanOut, ...inventory }, null, 2)}\n`)
    return 0
  }
  for (const row of inventory.installations) {
    process.stdout.write(`${formatRow(row, config.home)}\n`)
  }
  const counted = `${inventory.installations.length} installation${inventory.installations.length === 1 ? '' : 's'}`
  process.stdout.write(`\n${counted} · scanned ${scan.scannedAt}\n`)
  // The tier legend is the answer to "may I propose a write here": one line per harness, each tier
  // with the scope bucket it maps to and whether it is a mirror target.
  for (const harness of inventory.harnesses) {
    const tiers = harness.tiers
      .map((tier) => `${tier.id}(${tier.scopeBucket},${tier.writability})`)
      .join(' ')
    process.stdout.write(`${harness.harness}  ${tiers}\n`)
  }
  for (const health of inventory.tierHealth) {
    if (health.status !== 'ok') {
      process.stdout.write(`unreadable tier ${health.tierId}: ${health.detail ?? 'unknown'}\n`)
    }
  }
  return 0
}

function inspect(argv: string[]): number {
  const { id, json } = parseInspectOptions(argv)
  if (id === undefined) {
    process.stderr.write(USAGE)
    return 1
  }
  const config = resolveDefaultConfig()
  // An inspection reports what the store holds: discovery already classified the source bytes, so
  // this reads the persisted, secret-free row rather than the native file.
  const result = inspectInstallation(config, id)
  if (result.kind === 'notFound') {
    process.stderr.write(`no installation matches ${printable(id)}\n`)
    return 1
  }
  if (result.kind === 'ambiguous') {
    process.stderr.write(`ambiguous id ${printable(id)}: ${result.ids.map(printable).join(', ')}\n`)
    return 1
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result.inspection, null, 2)}\n`)
    return 0
  }
  process.stdout.write(formatInspection(result.inspection, config.home))
  return 0
}

interface MirrorOptions {
  id?: string
  target?: string
  plan: boolean
}

// A plan is one document on stdout: the caller carries it back to apply, so nothing is written and
// no id is printed for a later lookup.
function mirror(argv: string[]): number {
  const options = parseMirrorOptions(argv)
  if (options.id === undefined || options.target === undefined) {
    process.stderr.write(USAGE)
    return 1
  }
  if (!options.plan) {
    process.stderr.write('acm mirror writes nothing: pass --plan, then apply that document\n')
    return 1
  }
  const config = resolveDefaultConfig()
  // No scan here. A planning pass writes nothing at all: the source is the snapshot the last scan
  // stored, and a scan would persist — and tombstone — as a side effect of asking for a plan.
  const result = planMirror(config, options.id, options.target)
  if (result.kind === 'refused') {
    process.stderr.write(`refused: ${result.reason}\n`)
    return 1
  }
  process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`)
  return 0
}

function parseMirrorOptions(argv: string[]): MirrorOptions {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { target: { type: 'string' }, plan: { type: 'boolean' } },
    })
    return { id: positionals[0], target: values.target, plan: values.plan === true }
  } catch {
    return { plan: false }
  }
}

// A plan is carried by the caller, so both faces take the document itself — from a file or from
// stdin — and neither takes a plan id.
function readDocument(source: string | undefined): Json | null {
  try {
    const text = source === undefined || source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

function readPlan(argv: string[]): Json | null {
  let source: string | undefined
  try {
    source = parseArgs({ args: argv, allowPositionals: true, options: {} }).positionals[0]
  } catch {
    return null
  }
  return readDocument(source)
}

// Overwriting a value a human already wrote at that address is a named act: the flag is the ask, and
// its absence is the default refusal. A misspelt value is refused rather than read as the default.
function apply(argv: string[]): number {
  let positionals: string[]
  let onConflict: string | undefined
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { 'on-conflict': { type: 'string' } },
    })
    positionals = parsed.positionals
    onConflict = parsed.values['on-conflict']
  } catch {
    process.stderr.write(USAGE)
    return 1
  }
  if (onConflict !== undefined && onConflict !== 'abort' && onConflict !== 'replace') {
    process.stderr.write(`--on-conflict takes abort or replace, not ${printable(onConflict)}\n`)
    return 1
  }
  const raw = readDocument(positionals[0])
  if (raw === null) {
    process.stderr.write('acm apply reads one plan document from a file or from stdin\n')
    return 1
  }
  const result = applyPlan(resolveDefaultConfig(), raw, {
    onConflict: onConflict === 'replace' ? 'replace' : 'abort',
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.outcome === 'applied' ? 0 : 1
}

function verify(argv: string[]): number {
  const raw = readPlan(argv)
  if (raw === null) {
    process.stderr.write('acm verify reads one plan document from a file or from stdin\n')
    return 1
  }
  const result = verifyPlanDocument(resolveDefaultConfig(), raw)
  if (result.kind === 'refused') {
    process.stderr.write(`refused: ${result.reason}\n`)
    return 1
  }
  process.stdout.write(`${JSON.stringify(result.verification, null, 2)}\n`)
  return result.verification.outcome === 'failed' ? 1 : 0
}

interface InspectOptions {
  id?: string
  json: boolean
}

function parseInspectOptions(argv: string[]): InspectOptions {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: 'boolean' } },
    })
    return { id: positionals[0], json: values.json === true }
  } catch {
    return { json: false }
  }
}

// ACM's own install is a mirror like any other: planned against each harness's user tier, shown,
// then applied by the same executor. A harness that refuses is reported on its own line, so one
// unwritable target never hides the two that landed.
function setup(argv: string[]): number {
  let onConflict: 'abort' | 'replace' = 'abort'
  let json = false
  try {
    const { values } = parseArgs({
      args: argv,
      options: { 'on-conflict': { type: 'string' }, json: { type: 'boolean' } },
    })
    const wanted = values['on-conflict']
    if (wanted !== undefined && wanted !== 'abort' && wanted !== 'replace') {
      process.stderr.write(`--on-conflict takes abort or replace, not ${printable(wanted)}\n`)
      return 1
    }
    onConflict = wanted === 'replace' ? 'replace' : 'abort'
    json = values.json === true
  } catch {
    process.stderr.write(USAGE)
    return 1
  }
  // A harness spawns what this process was started as, never what `PATH` resolves later, so the
  // entry records the absolute path of this bin — and only when that path can be launched at all.
  let bin: string
  try {
    bin = realpathSync(path.resolve(process.argv[1]))
  } catch {
    // A path that no longer resolves is not a bin: it is a refusal with a reason, not a stack trace.
    process.stderr.write(
      `refused: ${printable(process.argv[1])} cannot be resolved, so there is no bin to record; install acm and run its \`setup\` instead\n`,
    )
    return 1
  }
  const fault = launchFault(bin)
  if (fault !== null) {
    process.stderr.write(`refused: ${printable(fault)}; install acm and run its \`setup\` instead\n`)
    return 1
  }
  const report = setupSelf(resolveDefaultConfig(), bin, { onConflict })
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatSetup(report))
  // A landed write whose verification failed is not a settled harness, and neither is one where the
  // targets answered nothing at all.
  const settled = report.harnesses.every(
    (harness) =>
      harness.refused === null &&
      harness.applied?.outcome === 'applied' &&
      harness.applied.verification?.outcome !== 'failed',
  )
  return settled ? 0 : 1
}

// The headline word for one harness: the disposition only when the run really was a no-op, the
// verification's own failure when the writes landed and did not hold, and apply's outcome otherwise.
function appliedState(harness: SetupHarness): string {
  const applied = harness.applied
  if (applied === null) return 'planned'
  if (applied.outcome !== 'applied') return applied.outcome
  if (applied.verification?.outcome === 'failed') return 'verification failed'
  return harness.plan?.disposition.kind === 'alreadyPresent' ? 'already present' : applied.outcome
}

// A harness spawns the entry with its own PATH, so an entry that names its interpreter through
// `/usr/bin/env` is only launchable where that interpreter resolves: a missing one is a bin no
// harness could start, whatever the exec bit says.
function launchFault(bin: string): string | null {
  if (!executable(bin)) return `${bin} is not executable, so a harness could not spawn it`
  let first: string
  try {
    first = readFileSync(bin, 'utf8').split('\n', 1)[0] ?? ''
  } catch {
    return `${bin} cannot be read, so what would launch it is unknown`
  }
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(first)
  if (shebang === null) return null
  const [, interpreter = '', argument] = shebang
  const throughEnv = path.basename(interpreter) === 'env'
  // `env -S` and friends are not a shape this bin has, so the first argument is the interpreter.
  const named = throughEnv ? argument : interpreter
  if (named === undefined || named === '') return null
  const resolves = throughEnv
    ? (process.env.PATH ?? '')
        .split(path.delimiter)
        .some((dir) => dir !== '' && executable(path.join(dir, named)))
    : executable(named)
  return resolves
    ? null
    : `${bin} launches through ${named}, which is not on PATH, so a harness could not spawn it`
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
function formatSetup(report: SetupReport): string {
  const lines: string[] = []
  for (const harness of report.harnesses) {
    const where = harness.tierId ?? harness.harness
    if (harness.refused !== null) {
      lines.push(`${where}  refused  ${printable(harness.refused)}`)
      continue
    }
    const applied = harness.applied
    const state = appliedState(harness)
    lines.push(`${where}  ${state}  ${applied?.landed.length ?? 0} write(s)  ${shortDigest(harness.plan?.planId ?? null)}`)
    // Only a run that landed shows the writes: a plan's writes are what it would have done, and
    // printing them under a refusal reads as though they reached disk.
    for (const write of applied?.outcome === 'applied' ? (harness.plan?.writes ?? []) : []) {
      const at = write.op === 'writeAtPointer' ? printable(write.pointer) : printable(write.file)
      const value = write.op === 'writeAtPointer' ? JSON.stringify(write.value) : write.op
      lines.push(`  ${at} = ${value}`)
    }
    if (applied?.reason !== null && applied?.reason !== undefined) lines.push(`  ${printable(applied.reason)}`)
    for (const step of applied?.manualSteps ?? []) lines.push(`  manual  ${printable(step.step)}`)
  }
  return `${lines.join('\n')}\n`
}

function formatInspection(inspection: Inspection, home: string): string {
  const row = inspection.installation
  const lines = [
    `${row.category}  ${printable(row.name)}  ${row.scope}`,
    row.bindings
      .map((binding) => `${binding.tierId} (${binding.method}, ${binding.verificationStatus})`)
      .join('  '),
    `${shorten(row.nativeFile, home)}#${printable(row.nativePointer ?? '')}`,
    `digest ${row.contentDigest ?? '-'}  first seen ${inspection.provenance.firstSeenAt}  last seen ${inspection.provenance.lastSeenAt}` +
      (inspection.provenance.removedAt === null ? '' : `  removed ${inspection.provenance.removedAt}`),
  ]
  if (inspection.alsoReadBy.length > 0) lines.push(`also read by  ${inspection.alsoReadBy.join(', ')}`)
  lines.push('fields')
  for (const leaf of inspection.leaves) lines.push(`  ${printable(leaf.pointer)} = ${printable(leaf.value)}`)
  // A section that would be empty is left out: the verdict is already on the field it belongs to.
  if (inspection.secrets.length > 0) {
    lines.push('secrets')
    for (const secret of inspection.secrets) lines.push(`  ${printable(secret.pointer)} = ${secret.verdict}`)
  }
  if (inspection.executables.length > 0) {
    lines.push('executables')
    for (const executable of inspection.executables) {
      lines.push(`  ${printable(executable.pointer)} = ${executable.why}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function parseListOptions(argv: string[]): ListOptions | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        category: { type: 'string' },
        harness: { type: 'string' },
        scope: { type: 'string' },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    })
    return {
      category: values.category,
      harness: values.harness,
      scope: values.scope,
      all: values.all === true,
      json: values.json === true,
    }
  } catch {
    return null
  }
}

function formatRow(row: InstallationRow, home: string): string {
  const tiers = row.bindings.map((binding) => binding.tierId).join(',')
  const location = `${shorten(row.nativeFile, home)}#${row.nativePointer ?? ''}`
  const removed = row.removedAt === null ? '' : '  (removed)'
  return [
    row.category,
    printable(row.name),
    row.scope,
    tiers,
    printable(location),
    shortDigest(row.contentDigest),
    // The id is what `acm inspect` takes, and only its prefix is short enough for a row.
    row.id.replace(/^sha256:/, '').slice(0, 8),
  ].join('  ') + removed
}

// A server name and its path come from a config file, so control characters in them would forge or
// corrupt the row they are printed in.
function printable(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
}

function shortDigest(digest: string | null): string {
  return digest === null ? '-' : `${digest.slice(0, 15)}…`
}

function shorten(file: string, home: string): string {
  // The separator matters: `/home/ann` is not the home directory of `/home/anna`.
  return file === home || file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

// The server runs until the client closes stdin; there is no exit code to report on success.
async function mcpServe(): Promise<number> {
  const { serve } = await import('../mcp/server.ts')
  await serve()
  return 0
}

process.exitCode = await main(process.argv.slice(2))
