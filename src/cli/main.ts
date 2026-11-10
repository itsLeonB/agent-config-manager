#!/usr/bin/env node
import { statSync } from 'node:fs'
import path from 'node:path'
import { formatRefusal, formatStatus, readStatus, statusDocument } from '../environ/service.ts'

const USAGE = `usage: acm <command> [--project-root <dir>]

  --project-root <dir>  read that project's config instead of the working directory's

  status [--json]  print every Provision and the Presence of each harness's entry

  mcp serve  speak the MCP protocol over stdin/stdout
`

// The project a pass reads is the working directory, so a caller aiming elsewhere names it here.
// The flag is stripped before dispatch: the engine reads the override from the environment.
function withoutProjectRoot(argv: string[]): string[] | null {
  const at = argv.findIndex((arg) => arg === '--project-root' || arg.startsWith('--project-root='))
  if (at === -1) return argv
  const arg = argv[at]
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[at + 1]
  if (value === undefined || value === '' || value.startsWith('--')) return null
  // A path that is not a directory would read no config and report an empty project, which reads
  // like "this project has no config" rather than "the flag was wrong".
  const root = path.resolve(value)
  try {
    if (!statSync(root).isDirectory()) return null
  } catch {
    return null
  }
  process.env.ACM_PROJECT_ROOT = root
  return arg.includes('=')
    ? [...argv.slice(0, at), ...argv.slice(at + 1)]
    : [...argv.slice(0, at), ...argv.slice(at + 2)]
}

function main(input: string[]): number | Promise<number> {
  const argv = withoutProjectRoot(input)
  if (argv === null) {
    process.stderr.write('--project-root needs an existing directory\n')
    return 1
  }
  const command = argv[0]
  const rest = argv.slice(1)
  // The MCP face loads the SDK only when it is asked for it.
  if (command === 'mcp' && rest[0] === 'serve' && rest.length === 1) return mcpServe()
  if (command === 'status') return status(rest)
  process.stderr.write(USAGE)
  return 1
}

// Status re-evaluates every Check, so what it prints is this machine's now rather than a remembered
// answer. A refused environment file makes the command fail: an environment acm could not read is
// not an environment with nothing in it, and a script that ignored the difference would converge
// half a machine.
function status(rest: string[]): number {
  const unknown = rest.find((arg) => arg !== '--json')
  if (unknown !== undefined) {
    process.stderr.write(`status takes --json, not ${unknown}\n`)
    return 1
  }
  const answer = readStatus()
  for (const refusal of answer.refusals) process.stderr.write(`${formatRefusal(refusal)}\n`)
  process.stdout.write(
    rest.includes('--json') ? `${JSON.stringify(statusDocument(answer), null, 2)}\n` : formatStatus(answer),
  )
  return answer.refusals.length === 0 ? 0 : 1
}

// The server runs until the client closes stdin; there is no exit code to report on success.
async function mcpServe(): Promise<number> {
  const { serve } = await import('../mcp/server.ts')
  await serve()
  return 0
}

process.exitCode = await main(process.argv.slice(2))
