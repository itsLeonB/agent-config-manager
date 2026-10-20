import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// HOST_HOME is the one host-specific value: the home directory bind-mounted at
// its own absolute path. Pointing HOME at it keeps the absolute paths inside
// skip-path config and snapshots meaningful in the container.
if (process.env.HOST_HOME) process.env.HOME = process.env.HOST_HOME

// Same interpreter as the serving process, so Bun (dev) and Node (prod) both work.
const scanner = spawn(process.execPath, [path.join(root, 'scan.cjs'), '--loop'], {
  stdio: 'inherit',
})

let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shuttingDown = true
    scanner.kill(signal)
    process.exit(0)
  })
}

// A dead scanner means silently stale data; restart the whole container instead.
scanner.on('exit', (code) => {
  if (shuttingDown) return
  console.error(`Scanner loop exited with code ${code}; stopping so the container restarts`)
  process.exit(code ?? 1)
})

await import('./serve.mjs')
