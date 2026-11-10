import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { EngineConfig } from '../engine/config.ts'
import { installRun, latestRuns } from './service.ts'
import type { InstallOptions, InstallOutcome } from './service.ts'

// Seam A: one run against a fixture. A temp home, a temp project root, a hand-written environment
// file, and shell scripts that record what happened — the order they ran in, the directory they ran
// in, and whether they were reached at all. The assertions are the printed preview and summary, the
// bytes a command left, and the exit status; nothing here inspects how the runner got there.

interface Fixture {
  home: string
  projectRoot: string
  log: string
  config: EngineConfig
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-install-'))
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

// One script every order-sensitive test reuses: it appends its own marker to the log and writes the
// directory it saw. Both are files after the run, so neither is a claim made by the runner.
function recorder(f: Fixture): string {
  return script(f, 'record.sh', `echo "$1" >> "${f.log}"\npwd -P > "${f.log}.$1.cwd"`)
}

function environment(f: Fixture, text: string): void {
  file(path.join(f.home, 'agents_environ.toml'), text)
}

function logLines(f: Fixture): string[] {
  if (!fs.existsSync(f.log)) return []
  return fs
    .readFileSync(f.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

function sawDirectory(f: Fixture, marker: string): string {
  return fs.readFileSync(`${f.log}.${marker}.cwd`, 'utf8').trim()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Observation {
  outcome: InstallOutcome
  printed: string
  // What the log held when the runner first wrote anything out: the preview, on a run that has not
  // started a command yet.
  logAtFirstWrite: string
}

function run(f: Fixture, options: InstallOptions = {}): Observation {
  const writes: string[] = []
  let logAtFirstWrite: string | null = null
  const outcome = installRun(
    (text) => {
      logAtFirstWrite ??= fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : ''
      writes.push(text)
    },
    { dryRun: false, ...options },
    f.config,
  )
  return { outcome, printed: writes.join(''), logAtFirstWrite: logAtFirstWrite ?? '' }
}

// A child process, so an invocation whose stdin is a pipe is the one under test and a command that
// holds the run open can be killed instead of taking the suite with it.
function probe(f: Fixture, options: string): string {
  const runner = fileURLToPath(new URL('./service.ts', import.meta.url))
  const target = path.join(f.home, 'probe.ts')
  file(
    target,
    `import { installRun } from '${runner}'

const outcome = installRun(
  (text: string) => process.stdout.write(text),
  ${options},
  { home: '${f.home}', projectRoot: '${f.projectRoot}', storePath: '${path.join(f.home, 'store.db')}' },
)
process.stdout.write('EXIT ' + outcome.exitCode + '\\n')
`,
  )
  return target
}

test('the preview prints every Provision, harness, tier and command before the first command starts', () => {
  const f = fixture()
  const command = recorder(f)
  file(path.join(f.home, '.zshrc'), 'export ALREADY=1\n')
  environment(f, `version = 1

[provision.first.pi]
check   = { file = "~/.pi/mcp.json" }
install = "${command} first"

[provision.second.codex]
check   = { file = "~/.codex/config.toml" }
install = "${command} second"

[provision.third.opencode]
check   = { file = "~/.zshrc", contains = "ALREADY" }
install = "${command} third"
`)
  const { printed, logAtFirstWrite, outcome } = run(f)
  // The exact command, not a description of it, and a Present Provision still in the preview: what a
  // run will not do is part of what a human reviews.
  assert.match(printed, /^preview: 3 entries, 2 to run, 1 already present$/m)
  assert.match(printed, /^  first\s+pi\s+user\s+absent$/m)
  assert.match(printed, /^    \$ \.\/record\.sh first$/m)
  assert.match(printed, /^  second\s+codex\s+user\s+absent$/m)
  assert.match(printed, /^  third\s+opencode\s+user\s+present, skipped$/m)
  assert.equal(logAtFirstWrite, '')
  // Loader order, and only what was not already present. Both commands started in the user tier
  // root, which is where a relative path in the entry means.
  assert.deepEqual(logLines(f), ['first', 'second'])
  assert.equal(sawDirectory(f, 'first'), f.home)
  assert.equal(sawDirectory(f, 'second'), f.home)
  // Two Provisions are still absent, so the run is not a success even though nothing reported an
  // error.
  assert.equal(outcome.exitCode, 1)
})

test('a present Provision is skipped, and --force runs it anyway', () => {
  const f = fixture()
  const command = recorder(f)
  file(path.join(f.home, '.zshrc'), 'export ALREADY=1\n')
  environment(f, `version = 1

[provision.already.opencode]
check   = { file = "~/.zshrc", contains = "ALREADY" }
install = "${command} already"
`)
  const skipped = run(f)
  assert.deepEqual(logLines(f), [])
  assert.equal(skipped.outcome.exitCode, 0)
  assert.match(skipped.printed, /^  already\s+opencode\s+user\s+present, skipped$/m)
  assert.match(skipped.printed, /^  already present: already \(opencode\)$/m)

  const forced = run(f, { force: true })
  assert.deepEqual(logLines(f), ['already'])
  assert.match(forced.printed, /^  already\s+opencode\s+user\s+present, forced$/m)
  assert.match(forced.printed, /^  ran: already \(opencode\) exit 0$/m)
})

test('a failing command is reported, the run continues, and the summary names every group', () => {
  const f = fixture()
  script(f, 'boom.sh', 'echo boom-stderr >&2\nexit 7')
  environment(f, `version = 1

[provision.broken.pi]
check   = { file = "~/broken.marker" }
install = "./boom.sh"

[provision.landed.codex]
check   = { file = "~/landed.marker" }
install = "echo yes > landed.marker"
`)
  const { printed, outcome } = run(f)
  // The second command ran even though the first failed.
  assert.equal(fs.readFileSync(path.join(f.home, 'landed.marker'), 'utf8'), 'yes\n')
  assert.match(printed, /^  ran: broken \(pi\) exit 7, landed \(codex\) exit 0$/m)
  assert.match(printed, /^  failed: broken \(pi\) exit 7$/m)
  assert.match(printed, /^  already present: none$/m)
  assert.match(printed, /^  still absent: broken \(pi\) absent$/m)
  assert.equal(outcome.exitCode, 1)
})

// `unknown` is not `present`: a Check that could not answer must not skip its command, and the run
// prints the value it got rather than folding it into "not installed".
test('a Provision whose Presence is unknown still runs', () => {
  const f = fixture()
  file(path.join(f.home, '.pi', 'mcp.json'), '{ "mcpServers": ')
  const repair = script(f, 'repair.sh', `printf '{"mcpServers": {"serena": {"command": "uvx"}}}' > .pi/mcp.json`)
  environment(f, `version = 1

[provision.serena.pi]
check   = { file = "~/.pi/mcp.json", pointer = "mcpServers.serena" }
install = "${repair}"
`)
  const { printed, outcome } = run(f)
  assert.match(printed, /^  serena\s+pi\s+user\s+unknown$/m)
  assert.equal(fs.readFileSync(path.join(f.home, '.pi', 'mcp.json'), 'utf8'), '{"mcpServers": {"serena": {"command": "uvx"}}}')
  assert.match(printed, /^  ran: serena \(pi\) exit 0$/m)
  assert.equal(outcome.exitCode, 0)
})

test('the run is exit zero when every Check passes afterwards', () => {
  const f = fixture()
  environment(f, `version = 1

[provision.one.pi]
check   = { file = "~/one.marker" }
install = "echo one > one.marker"

[provision.two.codex]
check   = { file = "~/two.marker" }
install = "echo two > two.marker"
`)
  const { printed, outcome } = run(f)
  assert.equal(outcome.exitCode, 0)
  assert.match(printed, /^summary: 2 entries, 0 already present, 2 ran, 0 failed, 0 still absent$/m)
  assert.match(printed, /^  still absent: none$/m)
  assert.deepEqual(
    outcome.entries.map((entry) => entry.after),
    ['present', 'present'],
  )
})

// Several Checks: one failing Check is enough to run the entry, and afterwards every Check has to
// pass for the entry to be present — the run reads the fold, not one Check of its choosing.
test('an entry with several Checks runs when any Check fails, and is present when all of them pass', () => {
  const f = fixture()
  file(path.join(f.home, 'first.marker'), 'one\n')
  environment(f, `version = 1

[provision.two-things.pi]
checks = [
  { file = "~/first.marker", contains = "one" },
  { file = "~/second.marker", contains = "two" },
]
install = "echo one > first.marker; echo two > second.marker"
`)
  const { printed, outcome } = run(f)
  assert.match(printed, /^  two-things\s+pi\s+user\s+absent$/m)
  assert.equal(fs.readFileSync(path.join(f.home, 'second.marker'), 'utf8'), 'two\n')
  assert.equal(outcome.entries[0].after, 'present')
  assert.match(printed, /^summary: 1 entry, 0 already present, 1 ran, 0 failed, 0 still absent$/m)
  assert.equal(outcome.exitCode, 0)
})

test('Presence is re-evaluated after the command, so a half-worked command that passes its Check is present', () => {
  const f = fixture()
  environment(f, `version = 1

[provision.half.pi]
check   = { file = "~/half.marker", contains = "enough" }
install = "echo enough > half.marker; exit 1"
`)
  const { printed, outcome } = run(f)
  assert.equal(outcome.entries[0].after, 'present')
  assert.match(printed, /^  failed: half \(pi\) exit 1$/m)
  assert.match(printed, /^  still absent: none$/m)
  // The command failed, so the run fails: a wrapper script and the summary agree about success.
  assert.equal(outcome.exitCode, 1)
})

test('a command starts in its Tier root and inherits the parent environment unchanged', () => {
  const f = fixture()
  // A variable the parent already has is what "unchanged" means; the ones ACM might invent are what
  // "adds nothing" means.
  process.env.ACM_RUNNER_SENTINEL = 'inherited'
  try {
    environment(f, `version = 1

[provision.where.pi]
check   = { file = "~/where.marker" }
install = "env > child.env; pwd -P > child.cwd; echo yes > where.marker"
`)
    const { outcome } = run(f)
    const dumped = fs.readFileSync(path.join(f.home, 'child.env'), 'utf8')
    assert.match(dumped, /^ACM_RUNNER_SENTINEL=inherited$/m)
    for (const invented of ['ACM_HOME=', 'ACM_PROVISION=', 'ACM_HARNESS=', 'ACM_TIER=', 'ACM_INSTALL=']) {
      assert.doesNotMatch(dumped, new RegExp(`^${invented}`, 'm'))
    }
    assert.equal(fs.readFileSync(path.join(f.home, 'child.cwd'), 'utf8').trim(), f.home)
    assert.equal(outcome.exitCode, 0)
  } finally {
    delete process.env.ACM_RUNNER_SENTINEL
  }
})

test('--only restricts the run, and a name that matches no Provision refuses it', () => {
  const f = fixture()
  const command = recorder(f)
  environment(f, `version = 1

[provision.one.pi]
check   = { file = "~/one.marker" }
install = "${command} one; echo x > one.marker"

[provision.two.pi]
check   = { file = "~/two.marker" }
install = "${command} two; echo x > two.marker"
`)
  const narrowed = run(f, { only: ['one'] })
  assert.deepEqual(logLines(f), ['one'])
  assert.match(narrowed.printed, /^preview: 1 entry, 1 to run, 0 already present$/m)
  assert.match(narrowed.printed, /^selection: --only one$/m)
  assert.equal(narrowed.outcome.exitCode, 0)

  fs.rmSync(f.log)
  // A typo is a typo: running the rest would look like the named fix succeeded.
  const refused = run(f, { only: ['nope'] })
  assert.match(refused.printed, /^no Provision named or tagged nope \(each tried as a name and as a tag\)$/m)
  assert.equal(fs.existsSync(f.log), false)
  assert.equal(refused.outcome.exitCode, 1)
})

test('--only selects a tag as well as a name, and the preview names the selection', () => {
  const f = fixture()
  const command = recorder(f)
  environment(f, `version = 1

[provision.one]
tags = ["alpha"]

[provision.one.pi]
check   = { file = "~/one.marker" }
install = "${command} one-pi; echo x > one.marker"

[provision.one.codex]
check   = { file = "~/one-codex.marker" }
install = "${command} one-codex; echo x > one-codex.marker"

[provision.two]
tags = ["shared"]

[provision.two.pi]
check   = { file = "~/two.marker" }
install = "${command} two; echo x > two.marker"

[provision.three.pi]
check   = { file = "~/three.marker" }
install = "${command} three; echo x > three.marker"
`)

  // A tag selects every entry of the Provision that carries it, across harnesses.
  const byTag = run(f, { only: ['alpha'] })
  assert.deepEqual(logLines(f), ['one-pi', 'one-codex'])
  assert.match(byTag.printed, /^selection: --only alpha$/m)
  assert.match(byTag.printed, /^preview: 2 entries, 2 to run, 0 already present$/m)
  assert.equal(byTag.outcome.exitCode, 0)

  fs.rmSync(f.log)
  // A tag and a name in one call select their union.
  const both = run(f, { only: ['shared', 'three'] })
  assert.deepEqual(logLines(f), ['two', 'three'])
  assert.match(both.printed, /^selection: --only shared, three$/m)
  assert.equal(both.outcome.exitCode, 0)
})

test('--only leaves a present entry it selects by tag alone, unless --force', () => {
  const f = fixture()
  const command = recorder(f)
  file(path.join(f.home, '.zshrc'), 'export READY=1\n')
  environment(f, `version = 1

[provision.done]
tags = ["shared"]

[provision.done.opencode]
check   = { file = "~/.zshrc", contains = "READY" }
install = "${command} done"
`)
  const skipped = run(f, { only: ['shared'] })
  assert.deepEqual(logLines(f), [])
  assert.match(skipped.printed, /^preview: 1 entry, 0 to run, 1 already present$/m)
  assert.equal(skipped.outcome.exitCode, 0)

  const forced = run(f, { only: ['shared'], force: true })
  assert.deepEqual(logLines(f), ['done'])
  assert.match(forced.printed, /^  ran: done \(opencode\) exit 0$/m)
})

test('a run never writes an environment file', () => {
  const f = fixture()
  environment(f, `version = 1

[provision.writer.pi]
check   = { file = "~/writer.marker" }
install = "echo ran > writer.marker"
`)
  const source = path.join(f.home, 'agents_environ.toml')
  const before = fs.readFileSync(source)
  const { outcome } = run(f)
  assert.deepEqual(fs.readFileSync(source), before)
  assert.equal(outcome.entries[0].after, 'present')
})

// The suite's own stdin is a terminal in an interactive shell, so the invocation is made in a child
// whose stdin is a pipe: that is the scheduled or piped run the default protects.
test('a run whose stdin is not a TTY is a dry run by default', () => {
  const f = fixture()
  environment(f, `version = 1

[provision.never.pi]
check   = { file = "~/never.marker" }
install = "echo ran > never.marker"
`)
  const child = spawnSync(process.execPath, [probe(f, '{}')], { cwd: f.home, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /dry run: nothing was run/)
  assert.match(child.stdout, /EXIT 0/)
  assert.equal(fs.existsSync(path.join(f.home, 'never.marker')), false)

  // An explicit run is still what a person at a terminal gets.
  const printed = run(f)
  assert.doesNotMatch(printed.printed, /dry run/)
  assert.equal(fs.existsSync(path.join(f.home, 'never.marker')), true)
})

// stdin is an open pipe here, so a command that inherited it would block forever. The timeout is
// the assertion's bound, and `signalCode` is what separates "exited" from "was killed".
test('a command that reads stdin fails instead of hanging the run', async () => {
  const f = fixture()
  script(f, 'reads.sh', `if read line; then echo "answered:$line" >> "${f.log}"; exit 0; fi\necho eof >> "${f.log}"\nexit 3`)
  environment(f, `version = 1

[provision.asks.pi]
check   = { file = "~/asks.marker" }
install = "./reads.sh"
`)
  const child = spawn(process.execPath, [probe(f, '{ dryRun: false }')], { cwd: f.home, timeout: 3000 })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString()
  })
  const exited = await new Promise<number | null>((resolve) => {
    child.on('close', (status) => resolve(status))
  })
  assert.equal(child.signalCode, null, `the run was killed after 3s: a command held it open\n${out}${err}`)
  assert.equal(exited, 0, `${out}${err}`)
  assert.match(out, /EXIT 1/)
  assert.match(out, /failed: asks \(pi\) exit 3/)
  // The command saw end of input rather than a question it could ask.
  assert.deepEqual(logLines(f), ['eof'])
})

// A Payload is read at run time and runs as `sh <payload> <args…>`: the declared path resolves
// against the tier root, the arguments arrive as argv and are never part of the text, and no
// executable bit is needed.
test('a Payload runs as sh payload args, and its arguments arrive as argv', () => {
  const f = fixture()
  // No chmod anywhere in this test: the shell reads the text, so the executable bit is not part of
  // the contract.
  file(
    path.join(f.home, 'payloads', 'with-args.sh'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > argv.dump\ntouch payload.marker\n',
  )
  environment(f, `version = 1

[provision.payloaded.pi]
check   = { file = "~/payload.marker" }
install = { payload = "payloads/with-args.sh", args = ["one", "two"] }
`)
  const { printed, outcome } = run(f)
  const resolved = path.join(f.home, 'payloads', 'with-args.sh')
  // The preview is the command that will run, spelled: the payload path followed by its arguments.
  assert.match(printed, new RegExp(`^    \\$ sh ${escapeRegex(resolved)} one two$`, 'm'))
  // The payload's text reached the shell, and its arguments reached the payload as argv.
  assert.equal(fs.readFileSync(path.join(f.home, 'argv.dump'), 'utf8'), 'one\ntwo\n')
  assert.equal(outcome.entries[0].after, 'present')
  assert.equal(outcome.exitCode, 0)
  // The record holds the same spelling — the path followed by its arguments — never the bytes the
  // file held.
  const recorded = latestRuns(f.config)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].command, `sh ${resolved} one two`)
  assert.equal(recorded[0].command.includes('printf'), false)
  assert.equal(recorded[0].exitCode, 0)
  assert.equal(recorded[0].presence, 'present')
})

// One argument that holds a space or a quote is still one argv word: the spelling is quoted the way
// a shell reads it back, so the preview stays the command that runs.
test('a Payload argument with a space or a quote arrives as one argv word', () => {
  const f = fixture()
  file(
    path.join(f.home, 'payloads', 'argv.sh'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > argv.dump\ntouch payload.marker\n',
  )
  environment(f, `version = 1

[provision.payloaded.pi]
check   = { file = "~/payload.marker" }
install = { payload = "payloads/argv.sh", args = ["a b", "it's"] }
`)
  const { printed } = run(f)
  // The preview is the same quoted spelling the shell is handed.
  assert.match(printed, /'a b' 'it'\\''s'$/m)
  assert.equal(fs.readFileSync(path.join(f.home, 'argv.dump'), 'utf8'), "a b\nit's\n")
})

// A Payload that cannot be read fails its entry without spawning anything, and the run goes on: the
// Presence is still re-evaluated afterwards, and the row records the spelling with no exit code
// because nothing ran.
test('a Payload that cannot be read fails its entry and spawns nothing', () => {
  const f = fixture()
  environment(f, `version = 1

[provision.gone.pi]
check   = { file = "~/gone.marker" }
install = { payload = "~/gone.sh" }

[provision.after.pi]
check   = { file = "~/after.marker" }
install = "echo yes > after.marker"
`)
  const { printed, outcome } = run(f)
  const resolved = path.join(f.home, 'gone.sh')
  assert.match(printed, new RegExp(`^    \\$ sh ${escapeRegex(resolved)}$`, 'm'))
  assert.match(printed, new RegExp(`failed: gone \\(pi\\) ${escapeRegex(resolved)} could not be read: `))
  // The next entry still ran: a missing Payload is one broken entry, not a stopped run.
  assert.equal(fs.readFileSync(path.join(f.home, 'after.marker'), 'utf8'), 'yes\n')
  const gone = outcome.entries.find((entry) => entry.provision.name === 'gone')
  assert.ok(gone !== undefined)
  assert.equal(gone.attempted, true)
  assert.equal(gone.commandExit, null)
  assert.equal(gone.after, 'absent')
  assert.equal(outcome.exitCode, 1)
  const recorded = latestRuns(f.config)
  const goneRun = recorded.find((entry) => entry.provision === 'gone')
  assert.ok(goneRun !== undefined)
  assert.equal(goneRun.command, `sh ${resolved}`)
  assert.equal(goneRun.exitCode, null)
  assert.equal(goneRun.presence, 'absent')
})

// A Section install writes the Payload's text where its `## ` heading names: the Section is
// replaced in place, appended when it is missing, and the file created when that file is missing.
// It never spawns, and every byte outside the Section is the byte it was.
test('a Section install rewrites the drifted Section and leaves every other byte alone', () => {
  const f = fixture()
  const agents = path.join(f.home, '.pi', 'agent', 'AGENTS.md')
  file(
    agents,
    '# AGENTS.md\n\n## Output style\n\nOld text that drifted.\n\n## Next section\n\nKeep me.\n\n```\n## Fenced heading stays\n```\n',
  )
  file(path.join(f.home, 'instructions', 'output-style.md'), '## Output style\n\nBe terse.\n')
  environment(f, `version = 1

[provision.i-have-adhd.pi]
check   = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }
install = { file = "~/.pi/agent/AGENTS.md", section = "instructions/output-style.md" }
`)
  const { printed, outcome } = run(f)
  assert.equal(
    fs.readFileSync(agents, 'utf8'),
    '# AGENTS.md\n\n## Output style\n\nBe terse.\n## Next section\n\nKeep me.\n\n```\n## Fenced heading stays\n```\n',
  )
  const resolved = path.join(f.home, 'instructions', 'output-style.md')
  // The preview and the record spell the path pair, never the bytes the Payload holds.
  assert.match(printed, new RegExp(`^    write ${escapeRegex(agents)} from ${escapeRegex(resolved)}$`, 'm'))
  assert.match(printed, /^  ran: i-have-adhd \(pi\) exit 0$/m)
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.entries[0].after, 'present')
  const recorded = latestRuns(f.config)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].command, `write ${agents} from ${resolved}`)
  assert.equal(recorded[0].command.includes('Be terse'), false)
  assert.equal(recorded[0].exitCode, 0)
  assert.equal(recorded[0].presence, 'present')
})

test('a Section install appends the Section when it is missing and creates the file when that file is missing', () => {
  const f = fixture()
  file(path.join(f.home, 'style.md'), '## Output style\n\nBe terse.\n')
  file(path.join(f.home, '.pi', 'agent', 'AGENTS.md'), '# AGENTS.md\n\n## Other\n\nKept.\n')
  environment(f, `version = 1

[provision.append.pi]
check   = { file = "~/.pi/agent/AGENTS.md", section = "style.md" }
install = { file = "~/.pi/agent/AGENTS.md", section = "style.md" }

[provision.create.codex]
check   = { file = "~/.codex/AGENTS.md", section = "style.md" }
install = { file = "~/.codex/AGENTS.md", section = "style.md" }
`)
  const { outcome } = run(f)
  assert.equal(
    fs.readFileSync(path.join(f.home, '.pi', 'agent', 'AGENTS.md'), 'utf8'),
    '# AGENTS.md\n\n## Other\n\nKept.\n## Output style\n\nBe terse.\n',
  )
  assert.equal(fs.readFileSync(path.join(f.home, '.codex', 'AGENTS.md'), 'utf8'), '## Output style\n\nBe terse.\n')
  assert.deepEqual(
    outcome.entries.map((entry) => entry.after),
    ['present', 'present'],
  )
  assert.equal(outcome.exitCode, 0)
})

// The write is a function of the two files only, so the second write is byte-identical to the
// first: no re-serialisation and nothing accumulated.
test('a Section install is idempotent: writing twice leaves the same bytes', () => {
  const f = fixture()
  const agents = path.join(f.home, 'AGENTS.md')
  file(agents, '# AGENTS.md\n\n## Output style\n\nOld.\n\n## Next\n\nTail.\n')
  file(path.join(f.home, 'style.md'), '## Output style\n\nBe terse.\n')
  environment(f, `version = 1

[provision.idem.pi]
check   = { file = "~/AGENTS.md", section = "style.md" }
install = { file = "~/AGENTS.md", section = "style.md" }
`)
  const first = run(f)
  const once = fs.readFileSync(agents, 'utf8')
  const second = run(f, { force: true })
  assert.equal(fs.readFileSync(agents, 'utf8'), once)
  assert.equal(first.outcome.exitCode, 0)
  assert.equal(second.outcome.exitCode, 0)
})

// A Payload whose last byte is not a newline still writes a whole Section: the writer terminates the
// Payload before the next heading, so the foreign Section is byte-identical, the Check converges,
// and a second run writes the same bytes.
test('a Payload without a trailing newline writes a whole Section and converges', () => {
  const f = fixture()
  const agents = path.join(f.home, 'AGENTS.md')
  const foreign = '## Next\n\nForeign bytes.\n'
  file(agents, `# AGENTS.md\n\n## Output style\n\nOld.\n\n${foreign}`)
  file(path.join(f.home, 'style.md'), '## Output style\n\nBe terse.')
  environment(f, `version = 1

[provision.trim.pi]
check   = { file = "~/AGENTS.md", section = "style.md" }
install = { file = "~/AGENTS.md", section = "style.md" }
`)
  const first = run(f)
  assert.equal(fs.readFileSync(agents, 'utf8'), `# AGENTS.md\n\n## Output style\n\nBe terse.\n${foreign}`)
  assert.equal(first.outcome.entries[0].after, 'present')
  assert.equal(first.outcome.exitCode, 0)
  const once = fs.readFileSync(agents, 'utf8')
  const second = run(f, { force: true })
  assert.equal(fs.readFileSync(agents, 'utf8'), once)
  assert.equal(second.outcome.entries[0].after, 'present')
  assert.equal(second.outcome.exitCode, 0)
})

test('a Section install restores a hand-edited Section and leaves the rest of the edit alone', () => {
  const f = fixture()
  const agents = path.join(f.home, 'AGENTS.md')
  file(agents, '# AGENTS.md\n\n## Output style\n\nOld.\n\n## Next\n\nTail.\n')
  file(path.join(f.home, 'style.md'), '## Output style\n\nBe terse.\n')
  environment(f, `version = 1

[provision.hand.pi]
check   = { file = "~/AGENTS.md", section = "style.md" }
install = { file = "~/AGENTS.md", section = "style.md" }
`)
  run(f)
  // A human edits the Section and adds a sibling heading afterwards: the next run replaces only the
  // Section and keeps the added heading byte for byte.
  fs.writeFileSync(agents, '# AGENTS.md\n\n## Output style\n\nHuman words.\n\n## Hand added\n\nMine.\n')
  const { outcome } = run(f)
  assert.equal(fs.readFileSync(agents, 'utf8'), '# AGENTS.md\n\n## Output style\n\nBe terse.\n## Hand added\n\nMine.\n')
  assert.equal(outcome.entries[0].after, 'present')
  assert.equal(outcome.exitCode, 0)
})

test('a Section install whose Payload cannot be read fails its entry, records the failure, and the run goes on', () => {
  const f = fixture()
  environment(f, `version = 1

[provision.gone.pi]
check   = { file = "~/AGENTS.md", section = "~/gone-style.md" }
install = { file = "~/AGENTS.md", section = "~/gone-style.md" }

[provision.after.codex]
check   = { file = "~/after.marker" }
install = "echo yes > after.marker"
`)
  const { printed, outcome } = run(f)
  const agents = path.join(f.home, 'AGENTS.md')
  const resolved = path.join(f.home, 'gone-style.md')
  assert.match(printed, new RegExp(`^    write ${escapeRegex(agents)} from ${escapeRegex(resolved)}$`, 'm'))
  assert.match(printed, new RegExp(`failed: gone \\(pi\\) ${escapeRegex(resolved)} could not be read: `))
  // The next entry still ran: a missing Payload is one broken entry, not a stopped run.
  assert.equal(fs.readFileSync(path.join(f.home, 'after.marker'), 'utf8'), 'yes\n')
  assert.equal(fs.existsSync(agents), false, 'the failed write created the file')
  const gone = outcome.entries.find((entry) => entry.provision.name === 'gone')
  assert.ok(gone !== undefined)
  assert.equal(gone.attempted, true)
  assert.equal(gone.commandExit, null)
  assert.equal(gone.after, 'absent')
  assert.equal(outcome.exitCode, 1)
  const recorded = latestRuns(f.config)
  const goneRun = recorded.find((entry) => entry.provision === 'gone')
  assert.ok(goneRun !== undefined)
  assert.equal(goneRun.command, `write ${agents} from ${resolved}`)
  assert.equal(goneRun.exitCode, null)
  assert.equal(goneRun.presence, 'absent')
})
