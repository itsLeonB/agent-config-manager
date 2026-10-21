import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The host paths scan.cjs reads under HOME; any one of them present means the home is mounted.
const SCANNED_HOME_ENTRIES = ['.claude', '.claude.json', '.agents']

// HOST_HOME is the one host-specific value: the home directory bind-mounted at
// its own absolute path. Pointing HOME at it keeps the absolute paths inside
// skip-path config and snapshots meaningful in the container.
// A mount whose container path is not exactly HOST_HOME — a ":ro" suffix pasted into the
// mount path, say — leaves this directory missing, and the scan then inventories the
// container's own empty HOME and stores zeros. Fail loudly so the container restarts on a
// visible error instead of serving an empty dashboard.
if (process.env.HOST_HOME) {
  const hostHome = process.env.HOST_HOME
  let isDirectory = false
  try {
    isDirectory = statSync(hostHome).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    console.error(
      `HOST_HOME=${hostHome} is not a directory in the container; bind-mount the host home at that exact path`,
    )
    process.exit(1)
  }
  process.env.HOME = hostHome
  // The home arrives as one mount per scanned path, so a wrong container path on any of
  // them leaves this directory present but empty and the scan reports nothing.
  if (!SCANNED_HOME_ENTRIES.some((entry) => existsSync(path.join(hostHome, entry)))) {
    console.warn(
      `No Claude configuration under HOST_HOME=${hostHome} (${SCANNED_HOME_ENTRIES.join(', ')}); the scan will report nothing — check each path is bind-mounted at its own absolute path`,
    )
  }
}

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
