import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineConfig } from '../engine/config.ts'
import { latestRuns } from './history.ts'
import { installRun, readStatus, statusDocument } from './service.ts'
import type { InstallOutcome } from './service.ts'
import type { Run } from './types.ts'

// Seam A: one run against a fixture, then the rows it left. A temp home, a temp project root, a temp
// store, a hand-written environment file, and shell scripts that print or fail. The assertions are
// the stored rows, the database file's own bytes, and the document `acm status --json` prints.

interface Fixture {
  home: string
  projectRoot: string
  log: string
  config: EngineConfig
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-history-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projectRoot, { recursive: true })
  return {
    home,
    projectRoot,
    log: path.join(root, 'ran.log'),
    config: { home, projectRoot, storePath: path.join(root, 'store', 'dashboard.db') },
  }
}

function file(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}

function script(f: Fixture, name: string, body: string): string {
  const target = path.join(f.home, name)
  file(target, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(target, 0o755)
  return `./${name}`
}

function environment(f: Fixture, text: string): void {
  file(path.join(f.home, 'agents_environ.toml'), text)
}

function run(f: Fixture, force = false): InstallOutcome {
  return installRun(() => {}, { dryRun: false, force }, f.config)
}

// One script every row-shape test reuses: it appends its marker to the log and creates the file its
// own Check names, so the Presence afterwards is the file's answer rather than the command's word.
function installer(f: Fixture, marker: string, checkFile: string): string {
  return script(f, `${marker}.sh`, `echo "${marker}" >> "${f.log}"\nmkdir -p "$(dirname "${checkFile}")"\ntouch "${checkFile}"`)
}

// Every byte the store occupies. WAL mode means a row can sit in the log beside the database until
// the last connection closes, so a check that only read `dashboard.db` could pass without ever
// looking at the bytes the row was written to.
function storeBytes(f: Fixture): Buffer[] {
  const dir = path.dirname(f.config.storePath)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(path.basename(f.config.storePath)))
    .map((name) => fs.readFileSync(path.join(dir, name)))
}

function byEntry(runs: Run[], harness: Run['harness']): Run {
  const found = runs.find((entry) => entry.harness === harness)
  assert.ok(found !== undefined, `no run recorded for ${harness}`)
  return found
}

test('each executed command records its time, Provision, harness, tier, command, exit code and Presence', () => {
  const f = fixture()
  const command = installer(f, 'pi-check', path.join(f.home, '.pi', 'mcp.json'))
  environment(f, `version = 1

[provision.serena.pi]
check   = { file = "~/.pi/mcp.json" }
install = "${command}"
`)
  const before = Date.now()
  const outcome = run(f)
  const after = Date.now()
  assert.equal(outcome.exitCode, 0)
  assert.deepEqual(runs(f).map((entry) => entry.provision), ['serena'])
  const recorded = runs(f)[0]
  assert.equal(recorded.provision, 'serena')
  assert.equal(recorded.harness, 'pi')
  assert.equal(recorded.tier, 'user')
  // The text that ran, not a rendering of it.
  assert.equal(recorded.command, command)
  assert.equal(recorded.exitCode, 0)
  // The Presence the Check answered after the command, which is the one the outcome reports.
  assert.equal(recorded.presence, 'present')
  assert.equal(outcome.entries[0].after, 'present')
  const at = Date.parse(recorded.at)
  assert.ok(at >= before && at <= after, `${recorded.at} is not the time this run happened`)
})

function runs(f: Fixture): Run[] {
  return latestRuns(f.config)
}

test('a Provision skipped because it was already present records nothing', () => {
  const f = fixture()
  file(path.join(f.home, '.zshrc'), 'export ALREADY=1\n')
  const command = installer(f, 'skipped', path.join(f.home, 'unused'))
  environment(f, `version = 1

[provision.already.pi]
check   = { file = "~/.zshrc", contains = "ALREADY" }
install = "${command}"
`)
  const outcome = run(f)
  assert.equal(outcome.entries[0].attempted, false)
  assert.equal(outcome.exitCode, 0)
  // No run happened, so there is no run: not a row with exit 0, and not a row at all.
  assert.deepEqual(runs(f), [])
  // The command never started, so even its own log is not there.
  assert.equal(fs.existsSync(f.log), false)
})

test('a failing command has its own row and the run continues', () => {
  const f = fixture()
  const first = installer(f, 'first', path.join(f.home, 'first.txt'))
  const failing = script(f, 'broken.sh', 'echo "broken" >> "$0.log" 2>/dev/null; exit 7')
  const third = installer(f, 'third', path.join(f.home, 'third.txt'))
  environment(f, `version = 1

[provision.first.pi]
check   = { file = "~/first.txt" }
install = "${first}"

[provision.broken.codex]
check   = { file = "~/second.txt" }
install = "${failing}"

[provision.third.opencode]
check   = { file = "~/third.txt" }
install = "${third}"
`)
  const outcome = run(f)
  assert.equal(outcome.exitCode, 1)
  const recorded = runs(f)
  // Loader order is the run's, not the store's: the rows are read as a set of entries.
  const named = recorded.map((entry) => entry.provision).sort()
  assert.deepEqual(named, ['broken', 'first', 'third'])
  const broken = recorded.find((entry) => entry.provision === 'broken')
  assert.ok(broken !== undefined)
  // The Check still fails, so the row says so: the exit code alone does not mean it worked.
  assert.deepEqual(
    [broken.exitCode, broken.presence],
    [7, 'absent'],
  )
  const last = recorded.find((entry) => entry.provision === 'third')
  assert.ok(last !== undefined)
  assert.deepEqual([last.exitCode, last.presence], [0, 'present'])
})

test('no command output reaches the store', () => {
  const f = fixture()
  // A token a command prints and nothing else on this machine holds, so finding it in the file is
  // the only way it could be there.
  const token = 'acm-run-token-4d9e2c'
  const leaky = script(
    f,
    'leaky.sh',
    `echo "${token} to stdout"\necho "${token} to stderr" >&2\ntouch "${path.join(f.home, 'leaky.txt')}"`,
  )
  environment(f, `version = 1

[provision.leaky.pi]
check   = { file = "~/leaky.txt" }
install = "${leaky}"
`)
  assert.equal(run(f).exitCode, 0)

  // The row is there and carries the command text, so the absence below is a fact about a file that
  // was written rather than about a file the test never found.
  assert.equal(runs(f).length, 1)
  const bytes = storeBytes(f)
  assert.ok(bytes.length > 0, 'the run left no store on disk')
  const text = Buffer.concat(bytes).toString('latin1')
  assert.ok(text.includes(leaky), 'the store does not hold the run that was made')
  assert.ok(!text.includes(token), `the store holds command output: ${token}`)
})

test('a command records its row before the next command starts', () => {
  const f = fixture()
  // The second command reads the database while the run is still going. If the rows were written at
  // the end of the run, this reader would see nothing — which is exactly what an interrupted run
  // would lose.
  const reader = path.join(f.home, 'read-runs.mjs')
  file(
    reader,
    `import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(${JSON.stringify(f.config.storePath)})
process.stdout.write(db.prepare('SELECT provision FROM runs ORDER BY id').all().map((row) => row.provision).join(','))
db.close()
`,
  )
  const inspected = script(f, 'inspect.sh', `node "${reader}" > "${f.log}.during"`)
  const first = installer(f, 'first', path.join(f.home, 'first.txt'))
  environment(f, `version = 1

[provision.first.pi]
check   = { file = "~/first.txt" }
install = "${first}"

[provision.second.codex]
check   = { file = "~/second.txt" }
install = "${inspected}"
`)
  run(f)
  // Committed, not pending: a later command that never finished cannot take this row with it.
  assert.equal(fs.readFileSync(`${f.log}.during`, 'utf8'), 'first')
  // And the run did reach the second command, whose row was written after it ended.
  assert.deepEqual(runs(f).map((entry) => entry.provision).sort(), ['first', 'second'])
})

test('the status document names the most recent run for each Provision and harness', () => {
  const f = fixture()
  const pi = installer(f, 'pi', path.join(f.home, '.pi', 'mcp.json'))
  const codex = installer(f, 'codex', path.join(f.home, '.codex', 'config.toml'))
  const other = installer(f, 'other', path.join(f.home, 'other.txt'))
  environment(f, `version = 1

[provision.serena.pi]
check   = { file = "~/.pi/mcp.json" }
install = "${pi}"

[provision.serena.codex]
check   = { file = "~/.codex/config.toml" }
install = "${codex}"

[provision.other.opencode]
check   = { file = "~/other.txt" }
install = "${other}"
`)
  run(f)
  run(f, true)
  const recorded = runs(f)
  assert.equal(recorded.length, 3)
  // One Provision, two harnesses, one run each: the newest per entry, not the newest overall.
  const document = statusDocument(readStatus({}, f.config), recorded)
  const serena = document.provisions.find((row) => row.name === 'serena')
  const otherRow = document.provisions.find((row) => row.name === 'other')
  assert.ok(serena !== undefined && otherRow !== undefined)
  assert.equal(serena.harnesses.length, 2)
  assert.equal(byEntry(recorded, 'pi').command, pi)
  assert.equal(byEntry(recorded, 'codex').command, codex)
  const piEntry = serena.harnesses.find((entry) => entry.harness === 'pi')
  const codexEntry = serena.harnesses.find((entry) => entry.harness === 'codex')
  assert.equal(piEntry?.latestRun?.command, pi)
  assert.equal(codexEntry?.latestRun?.command, codex)
  assert.ok(piEntry !== undefined && piEntry.latestRun !== undefined)
  // Two runs of the same Provision: the later one is the one named, and the entry keeps its own.
  assert.equal(piEntry.latestRun?.tier, 'user')
  assert.equal(piEntry.latestRun?.presence, 'present')
  assert.equal(otherRow.harnesses[0].latestRun?.command, other)
})

test('a Provision with no run yet carries no run key rather than an empty run', () => {
  const f = fixture()
  const command = installer(f, 'pi', path.join(f.home, '.pi', 'mcp.json'))
  environment(f, `version = 1

[provision.never-installed.pi]
check   = { file = "~/.pi/mcp.json" }
install = "${command}"
`)
  const document = statusDocument(readStatus({}, f.config), [])
  const entry = document.provisions[0].harnesses[0]
  assert.equal(entry.presence, 'absent')
  // No run happened, so there is no key to mistake for a run that recorded nothing.
  assert.deepEqual(Object.keys(entry), ['harness', 'tier', 'source', 'presence', 'detail'])
})
