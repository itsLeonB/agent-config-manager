import { spawnSync } from 'node:child_process'
import type { EngineConfig } from '../../config.ts'
import type { ProbeDiagnostic, ProbeResult, TierProbe } from '../tier.ts'

// OpenCode exits 0 on config it silently drops, so an invalid document can only be told from a clean
// one by reading what the tool says about it. `--standalone --print-logs` is what puts those lines on
// stderr: the diagnostics come from its private server's log, which a bare `debug config` never
// prints. `--log-level warn` keeps the rest of that log out.
const PROBE_ARGS = ['debug', 'config', '--standalone', '--print-logs', '--log-level', 'warn']
const DIAGNOSTIC = 'configuration normalization diagnostic'
// The probe boots OpenCode's server, so a hung binary must not hang a discovery pass.
const TIMEOUT_MS = 20_000

// OpenCode reads these from the environment, and any one of them would point the probe at another
// file than the tiers declared: a shell with `OPENCODE_CONFIG` set, or `XDG_CONFIG_HOME` moved,
// would make every tier read `ok` because the diagnostic names a path no tier owns.
const REDIRECTING_ENV = [
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_PROJECT_DISABLE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]

// One probe per discovery pass: the adapter builds this once, and every tier reads the same answer.
// A tier whose own file the probe does not name keeps its parse verdict.
export function openCodeProbe(config: EngineConfig): TierProbe | undefined {
  const bin = config.opencodeProbe ?? 'opencode'
  if (bin === false) return undefined
  let answer: ProbeResult | null = null
  return () => (answer ??= run(bin, config))
}

// A missing binary, an unrunnable one, a timeout, or any non-zero exit is not a verdict about the
// config, so it degrades to the parse instead of failing discovery on machines without OpenCode.
function run(bin: string, config: EngineConfig): ProbeResult {
  const probed = spawnSync(bin, PROBE_ARGS, {
    cwd: config.projectRoot,
    env: probeEnv(config.home),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  })
  const diagnostics: ProbeDiagnostic[] = []
  for (const line of (probed.stderr ?? '').split('\n')) {
    const diagnostic = parseDiagnostic(line)
    if (diagnostic !== null) diagnostics.push(diagnostic)
  }
  // Whatever output arrived is still a verdict about a named file, and `spawnSync` reports an error
  // when it kills the process at its buffer limit — a diagnostic past that point would otherwise
  // turn a rejected config into a clean tier.
  if (diagnostics.length > 0) return { kind: 'diagnostics', diagnostics }
  if (probed.error !== undefined) return { kind: 'unavailable', detail: probed.error.message }
  if (probed.status !== 0) {
    return { kind: 'unavailable', detail: `exited ${probed.status ?? `on ${probed.signal}`}` }
  }
  return { kind: 'diagnostics', diagnostics }
}

// The tier paths derive from the injected home, so the probe must resolve the same one — and only
// the variables that cannot redirect it survive. `PATH` does, because the binary is found through it.
function probeEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const name of REDIRECTING_ENV) delete env[name]
  return env
}

// One logfmt line per problem, naming its own source file and the pointer inside it:
//   level=WARN message="configuration normalization diagnostic" source=/p/opencode.json
//     path=$.mcp kind=invalid action="skipped malformed recognized value"
// `path=$` means the whole document was unreadable, `path=$.x` a dropped field inside a readable one.
function parseDiagnostic(line: string): ProbeDiagnostic | null {
  if (!line.includes(DIAGNOSTIC)) return null
  const kind = logField(line, 'kind')
  const source = logField(line, 'source')
  if (kind !== 'invalid' || source === undefined) return null
  const pointer = logField(line, 'path') ?? '$'
  const action = logField(line, 'action') ?? 'rejected'
  return { source, detail: `${pointer} ${action}` }
}

// A logfmt value is bare, or quoted when it holds a space. Both spellings occur on one line.
function logField(line: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|([^\\s]+))`).exec(line)
  return match?.[1] ?? match?.[2]
}
