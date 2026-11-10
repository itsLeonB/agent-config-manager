import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { deriveProjectRoot, resolveDefaultConfig, resolveProjectRoot } from './config.ts'

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
  const boundary = new Set(['ACM_PROJECT_ROOT', 'ACM_HOME', 'ACM_STORE', 'CODEX_HOME', 'CLAUDE_PROJECT_DIR'])
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !entry[0].startsWith('ACM_') && !boundary.has(entry[0]),
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

// The chain is a precedence, not a fallback order a later reader has to reconstruct from the CLI.
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

// The store is one file for every project, so aiming a pass at another project must not leave a
// second store inside it.
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
  // The row the caller asked for, not just some path: the demo skill is the fixture's only project
  // skill, and it has to be the one that came back.
  const listed = z
    .object({
      projectRoot: z.string(),
      installations: z.array(z.object({ category: z.string(), nativeFile: z.string() })),
    })
    .parse(JSON.parse(result.stdout))
  assert.equal(listed.projectRoot, fs.realpathSync(project))
  const rows = listed.installations
  assert.equal(
    rows.some(
      (row) => row.category === 'skills' && row.nativeFile === path.join(project, '.agents', 'skills', 'demo'),
    ),
    true,
    result.stdout,
  )
  assert.equal(result.stdout.includes(repoRoot), false, result.stdout)
  assert.equal(fs.existsSync(path.join(project, 'database')), false)
  assert.equal(fs.existsSync(path.join(root, 'database', 'dashboard.db')), true)
})

const listedSchema = z.object({
  projectRoot: z.string(),
  installations: z.array(z.object({ name: z.string(), scope: z.string(), nativeFile: z.string() })),
})

// A harness pinned once at user scope writes no absolute project path into its entry, so what acm
// reads is whatever directory the harness started it in.
function piEntry(dir: string, names: string[]): void {
  fs.mkdirSync(path.join(dir, '.pi'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.pi', 'mcp.json'),
    JSON.stringify({
      mcpServers: Object.fromEntries(names.map((name) => [name, { command: name }])),
    }),
  )
}

function listed(
  entry: string,
  cwd: string,
  env: Record<string, string>,
  args: string[] = ['list', '--json'],
): z.infer<typeof listedSchema> {
  const result = run('node', entry, cwd, env, args)
  assert.equal(result.status, 0, result.stderr)
  return listedSchema.parse(JSON.parse(result.stdout))
}

test('acm list reads the project it runs in, from a subdirectory too, and names that root', () => {
  const { entry } = installedBundle()
  const env = derivedEnv({ ACM_HOME: somewhere() })
  const project = somewhere()
  piEntry(project, ['alpha'])
  const nested = path.join(project, 'packages', 'one')
  fs.mkdirSync(nested, { recursive: true })

  const atRoot = listed(entry, project, env)
  assert.equal(atRoot.projectRoot, fs.realpathSync(project))
  assert.deepEqual(
    atRoot.installations.filter((row) => row.scope === 'project').map((row) => row.name),
    ['alpha'],
  )

  // The subdirectory is the project: the `.pi` above it is a layer this harness never loaded, and
  // walking up to it would describe config that was not read.
  const atNested = listed(entry, nested, env)
  assert.equal(atNested.projectRoot, fs.realpathSync(nested))
  assert.deepEqual(atNested.installations.filter((row) => row.scope === 'project'), [])

  // The human line names the root too, so an empty list is not a mystery.
  const human = run('node', entry, project, env, ['list'])
  assert.equal(human.status, 0, human.stderr)
  assert.match(human.stdout, new RegExp(`1 installation · ${fs.realpathSync(project)} · scanned`))
})

test('a project with no config answers an empty inventory and its root, never another project\u2019s rows', () => {
  const { entry } = installedBundle()
  const env = derivedEnv({ ACM_HOME: somewhere() })
  const projectA = somewhere()
  piEntry(projectA, ['alpha'])
  listed(entry, projectA, env)

  const projectB = somewhere()
  const bare = listed(entry, projectB, env)
  assert.equal(bare.projectRoot, fs.realpathSync(projectB))
  assert.deepEqual(bare.installations, [])
  // The stored rows of A are still there and still invisible from B, tombstones included.
  assert.deepEqual(listed(entry, projectB, env, ['list', '--all', '--json']).installations, [])
  assert.deepEqual(listed(entry, projectA, env).installations.map((row) => row.name), ['alpha'])
})

test('a symlinked path and its target are one project, so they record one installation', () => {
  const { entry } = installedBundle()
  const env = derivedEnv({ ACM_HOME: somewhere() })
  const real = somewhere()
  piEntry(real, ['alpha'])
  const link = path.join(somewhere(), 'linked')
  fs.symlinkSync(real, link)

  assert.equal(listed(entry, link, env).projectRoot, fs.realpathSync(real))
  const throughTarget = listed(entry, real, env)
  assert.equal(throughTarget.projectRoot, fs.realpathSync(real))
  assert.deepEqual(throughTarget.installations.map((row) => row.name), ['alpha'])
})

test('an inherited ACM_PROJECT_ROOT reads a project the caller did not stand in', () => {
  const { entry } = installedBundle()
  const project = somewhere()
  piEntry(project, ['alpha'])
  const env = derivedEnv({ ACM_HOME: somewhere(), ACM_PROJECT_ROOT: project })
  const listedFrom = listed(entry, somewhere(), env)
  assert.equal(listedFrom.projectRoot, fs.realpathSync(project))
  assert.deepEqual(listedFrom.installations.map((row) => row.name), ['alpha'])
})

// Claude Code starts a user-scope MCP server in its own configuration directory, so it is the one
// harness that hands its project over instead of standing in it.
test('CLAUDE_PROJECT_DIR answers for a harness started elsewhere, and the acm overrides outrank it', () => {
  const { entry } = installedBundle()
  const project = somewhere()
  piEntry(project, ['alpha'])
  const other = somewhere()
  piEntry(other, ['beta'])

  const fromHarness = derivedEnv({ ACM_HOME: somewhere(), CLAUDE_PROJECT_DIR: project })
  const named = listed(entry, somewhere(), fromHarness)
  assert.equal(named.projectRoot, fs.realpathSync(project))
  assert.deepEqual(named.installations.map((row) => row.name), ['alpha'])

  const both = { ...fromHarness, ACM_PROJECT_ROOT: other }
  assert.deepEqual(listed(entry, somewhere(), both).installations.map((row) => row.name), ['beta'])
})
