import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { deriveProjectRoot, resolveDefaultConfig } from './config.ts'

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const sourceEntry = path.join(repoRoot, 'src', 'cli', 'main.ts')
// The bundle is wherever the package says its bin is: a hard-coded `dist/` would let the manifest
// and the test drift apart.
const builtEntry = path.join(
  repoRoot,
  z
    .object({ bin: z.object({ acm: z.string() }) })
    .parse(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))).bin.acm,
)

// Everything the engine derives is overridable, so a test clears the overrides and hands back only
// what it wants: an inherited `ACM_*` from a surrounding shell would otherwise answer the question.
function somewhere(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acm-config-test-'))
}

function derivedEnv(extra: Record<string, string>) {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !entry[0].startsWith('ACM_') && entry[0] !== 'CODEX_HOME',
  )
  return { ...Object.fromEntries(inherited), ...extra }
}

function run(
  runtime: string,
  entry: string,
  cwd: string,
  env: Record<string, string>,
  args: string[] = ['list', '--json'],
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(runtime, [entry, ...args], { cwd, encoding: 'utf8', env })
}

// A fixture layout a build could plausibly be installed into: a package root owning the bundle one
// directory down, and a working directory that is neither — the bundle has to find its own root.
function installedBundle() {
  assert.ok(
    fs.existsSync(builtEntry),
    `${builtEntry} is missing: run \`bun run build:acm\` before the suite`,
  )
  const root = somewhere()
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-acm', type: 'module' }))
  fs.mkdirSync(path.join(root, 'dist'))
  const entry = path.join(root, 'dist', 'acm.mjs')
  fs.copyFileSync(builtEntry, entry)
  return { root, entry }
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
  for (const key of ['ACM_PROJECT_ROOT', 'ACM_STORE', 'ACM_HOME', 'CODEX_HOME']) delete process.env[key]
  try {
    const config = resolveDefaultConfig()
    assert.equal(config.projectRoot, repoRoot)
    assert.equal(config.storePath, path.join(repoRoot, 'database', 'dashboard.db'))
  } finally {
    process.env = saved
  }
})

test('the built bundle run from a foreign directory writes its store under its own package root', () => {
  const { root, entry } = installedBundle()
  const home = somewhere()
  // Node, not this process: a harness runs the bundle on Node with no Bun present.
  const result = run('node', entry, somewhere(), derivedEnv({ ACM_HOME: home }))

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(path.join(root, 'database', 'dashboard.db')), true)
})

test('ACM_HOME, ACM_PROJECT_ROOT, and ACM_STORE override the derived values in both entry forms', () => {
  for (const entry of [sourceEntry, builtEntry]) {
    const root = somewhere()
    const home = path.join(root, 'home')
    const projectRoot = path.join(root, 'project')
    const storePath = path.join(root, 'store', 'acm.db')
    for (const dir of [path.join(home, '.pi', 'agent'), projectRoot]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(
      path.join(home, '.pi', 'agent', 'mcp.json'),
      JSON.stringify({ mcpServers: { serena: { command: 'serena' } } }),
    )

    const result = run(
      process.execPath,
      entry,
      somewhere(),
      derivedEnv({ ACM_HOME: home, ACM_PROJECT_ROOT: projectRoot, ACM_STORE: storePath }),
    )

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /serena/, entry)
    assert.equal(fs.existsSync(storePath), true, entry)
    assert.equal(fs.existsSync(path.join(root, 'database')), false, entry)
  }
})

// The project an MCP client sees is the one acm is installed in, so a pass over any other project
// has to be asked for by name — and it must not leave a second store inside that project.
test('--project-root reads another project and leaves the store where acm is installed', () => {
  const { root, entry } = installedBundle()
  const home = somewhere()
  const project = somewhere()
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# fixture project instructions\n')
  fs.mkdirSync(path.join(project, '.agents', 'skills', 'demo'), { recursive: true })
  fs.writeFileSync(path.join(project, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo skill\n')

  const result = run('node', entry, somewhere(), derivedEnv({ ACM_HOME: home }), [
    'list',
    '--project-root',
    project,
    '--scope',
    'project',
    '--json',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.includes(project), true, result.stdout)
  assert.equal(result.stdout.includes(repoRoot), false, result.stdout)
  assert.equal(fs.existsSync(path.join(project, 'database')), false)
  assert.equal(fs.existsSync(path.join(root, 'database', 'dashboard.db')), true)
})
