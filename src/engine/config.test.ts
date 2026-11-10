import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveProjectRoot, resolveDefaultConfig, resolveProjectRoot } from './config.ts'

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

// Everything the engine derives is overridable, so a test clears the overrides and hands back only
// what it wants: an inherited `ACM_*` from a surrounding shell would otherwise answer the question.
function somewhere(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acm-config-test-'))
}

test('both entry forms derive the project root, and the default store path, from where they sit', () => {
  // The source form: the entry the package script runs, one module deep in `src/engine`.
  assert.equal(deriveProjectRoot(path.join(repoRoot, 'src', 'engine')), repoRoot)
  // The built form: a single file in `dist`, which the old two-directories-up rule would place on
  // the repository's parent — and whose store would then read a file nobody wrote.
  assert.equal(deriveProjectRoot(path.join(repoRoot, 'dist')), repoRoot)
  // A bundle copied somewhere with no package above it owns no root, so its own directory is it.
  const loose = somewhere()
  assert.equal(deriveProjectRoot(loose), loose)

  const saved = { ...process.env }
  for (const key of ['ACM_PROJECT_ROOT', 'ACM_STORE', 'ACM_HOME', 'CODEX_HOME', 'CLAUDE_PROJECT_DIR']) {
    delete process.env[key]
  }
  try {
    const config = resolveDefaultConfig()
    // The store stays anchored where acm is installed; the project is where the caller stood.
    assert.equal(config.projectRoot, fs.realpathSync(process.cwd()))
    assert.equal(config.storePath, path.join(repoRoot, 'database', 'dashboard.db'))
  } finally {
    process.env = saved
  }
})

// The chain is a precedence, not a fallback order a later reader has to reconstruct.
test('the project root is the override, then the harness\u2019s own, then the working directory', () => {
  const saved = { ...process.env }
  const cwd = somewhere()
  const override = somewhere()
  const fromHarness = somewhere()
  try {
    delete process.env.ACM_PROJECT_ROOT
    delete process.env.CLAUDE_PROJECT_DIR
    assert.equal(resolveProjectRoot(cwd), fs.realpathSync(cwd))

    process.env.CLAUDE_PROJECT_DIR = fromHarness
    assert.equal(resolveProjectRoot(cwd), fs.realpathSync(fromHarness))

    process.env.ACM_PROJECT_ROOT = override
    assert.equal(resolveProjectRoot(cwd), fs.realpathSync(override))
  } finally {
    process.env = saved
  }
})
