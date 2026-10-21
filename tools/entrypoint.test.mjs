import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const entrypoint = path.join(path.dirname(fileURLToPath(import.meta.url)), 'entrypoint.mjs')

// A HOST_HOME that is not mounted (e.g. the mount landed at "/home/leon:ro") used to start
// the scanner against the container's own empty HOME, storing an all-zero snapshot.
test('the entrypoint refuses to start when HOST_HOME is not a directory in the container', () => {
  const hostHome = '/nonexistent-host-home'
  const run = spawnSync(process.execPath, [entrypoint], {
    env: { ...process.env, HOST_HOME: hostHome },
    encoding: 'utf8',
    timeout: 10_000,
  })

  assert.equal(run.status, 1)
  assert.match(run.stderr, new RegExp(`HOST_HOME=${hostHome} is not a directory in the container`))
})
