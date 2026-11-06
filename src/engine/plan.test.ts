import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { EngineConfig } from './config.ts'
import { recordDiscovery } from './repo.ts'
import { alsoReadBy, planIntact, type MirrorPlan } from './plan.ts'
import type { Adapter } from './adapters/types.ts'
import { MCP_FIELDS } from './adapters/mcp-facts.ts'
import { MCP_WRITE_SURFACES } from './adapters/mcp-write.ts'
import { discover, listInstallations, planMirror } from './service.ts'

function fixture(): EngineConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-plan-test-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  for (const dir of [
    [home, '.pi', 'agent'],
    [projectRoot, '.pi'],
    [home, '.codex'],
    [projectRoot, '.codex'],
    [home, '.config', 'opencode'],
    [projectRoot, '.opencode'],
  ]) {
    fs.mkdirSync(path.join(...dir), { recursive: true })
  }
  return { home, projectRoot, storePath: path.join(root, 'dashboard.db') }
}

function piFixture(config: EngineConfig, servers: Record<string, PiServer>): void {
  fs.writeFileSync(
    path.join(config.home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: servers }),
  )
  discover(config)
}

function codexFixture(config: EngineConfig, toml: string): void {
  fs.writeFileSync(path.join(config.home, '.codex', 'config.toml'), toml)
  discover(config)
}

interface PiServer {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  description?: string
  timeout?: number
  exposure?: string
  enabled?: boolean
}

function codexFile(config: EngineConfig): string {
  return path.join(config.home, '.codex', 'config.toml')
}

// The one source id a fixture holds, so a test can name the installation by prefix.
function onlyId(config: EngineConfig, name: string): string {
  const row = listInstallations(config, {}).installations.find((candidate) => candidate.name === name)
  assert.ok(row, `${name} was not discovered`)
  return row.id
}

function plan(config: EngineConfig, name: string, target: string): MirrorPlan {
  const result = planMirror(config, onlyId(config, name), target)
  assert.equal(result.kind, 'plan', result.kind === 'refused' ? result.reason : '')
  return result.kind === 'plan' ? result.plan : assert.fail('unreachable')
}

// The prefix `acm list` prints, which is what a caller types. Slicing the raw id would take eight
// characters of `sha256:` and leave a one-character prefix that can match two rows.
function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 8)
}

function writeValues(plan: MirrorPlan): Map<string, unknown> {
  return new Map(plan.writes.map((write) => [write.pointer, write.value]))
}

test('a Pi server plans into Codex: fields partitioned, writes addressed, nothing written', () => {
  const config = fixture()
  piFixture(config, {
    serena: {
      command: 'serena',
      args: ['start-mcp-server'],
      env: { LOG_LEVEL: 'debug' },
      timeout: 30,
      description: 'symbol tools',
    },
  })

  const planned = plan(config, 'serena', 'codex:user')
  const values = writeValues(planned)

  assert.equal(planned.kind, 'mirror')
  assert.match(planned.source.installationId, /^sha256:[0-9a-f]{64}$/)
  assert.equal(planned.source.harness, 'pi')
  assert.equal(planned.source.tierId, 'pi:user')
  assert.equal(planned.target.harness, 'codex')
  assert.equal(planned.target.tierId, 'codex:user')
  assert.equal(planned.target.nativeLocation, `${codexFile(config)}#mcp_servers.serena`)
  // An MCP location is harness-private: no other adapter declares this file.
  assert.deepEqual(planned.target.alsoReadBy, [])

  // Carried 1:1, renamed with the transform named, dropped with a reason.
  assert.ok(planned.equivalence.carried.includes('command'))
  assert.ok(planned.equivalence.carried.includes('args'))
  assert.deepEqual(
    planned.equivalence.mapped.map((mapped) => [mapped.transform, mapped.targetField]),
    [
      // Codex has no transport key: the fact travels as which address field is present.
      ['infer', null],
      ['rename', 'tool_timeout_sec'],
    ],
  )
  // A literal `env` value is credential-bearing by construction (every harness keeps tokens there)
  // and is withheld at read time, so it can only be a gap with a manual step.
  assert.deepEqual(planned.equivalence.gaps, [
    { field: 'env', reason: 'credential', replacement: 'dropped' },
    { field: 'description', reason: 'fieldAbsent', replacement: 'dropped' },
  ])
  assert.deepEqual(planned.security.secrets, [{ pointer: 'env', verdict: 'secret' }])
  assert.deepEqual(planned.equivalence.preserved, [])

  // The target's own addresses, one write per leaf pointer, each gated on the file it lands in.
  assert.deepEqual([...values.keys()].sort(), [
    'mcp_servers.serena.args',
    'mcp_servers.serena.command',
    'mcp_servers.serena.tool_timeout_sec',
  ])
  assert.equal(values.get('mcp_servers.serena.tool_timeout_sec'), 30)
  assert.deepEqual(values.get('mcp_servers.serena.args'), ['start-mcp-server'])
  for (const write of planned.writes) {
    assert.deepEqual(write.precondition, { exists: false, digest: null })
    assert.equal(write.priorValue, null)
    assert.equal(write.reversible, true)
  }
  // Verification asserts the writes, never a whole-file copy.
  assert.deepEqual(
    planned.verify.asserts.map((assertion) => assertion.pointer),
    planned.writes.map((write) => write.pointer),
  )
  // A location that does not exist yet needs a human answer before apply.
  assert.equal(planned.security.grade, 'risky')
  assert.deepEqual(
    planned.manualSteps.map((step) => step.step),
    ["set env on codex:user from the source harness's own credential store"],
  )

  // Planning wrote nothing: the target file is still absent.
  assert.equal(fs.existsSync(codexFile(config)), false)
})

test('a reference-shaped env value becomes Codex passthrough, never a literal', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena', env: { GH_TOKEN: '${GH_TOKEN}' } } })

  const planned = plan(config, 'serena', 'codex:user')
  const values = writeValues(planned)

  // Codex interpolates nothing, so `${GH_TOKEN}` in `env` would reach the child process as those
  // nine characters. The variable name travels in `env_vars` instead.
  assert.deepEqual(planned.equivalence.mapped, [
    { transform: 'infer', fields: ['transport'], targetField: null },
    {
      transform: 'extract',
      fields: ['env'],
      targetField: 'env_vars',
      template: '^\\$\\{([A-Za-z_]\\w*)\\}$',
    },
  ])
  assert.deepEqual(values.get('mcp_servers.serena.env_vars'), ['GH_TOKEN'])
  assert.equal(
    planned.writes.some((write) => JSON.stringify(write.value).includes('${')),
    false,
  )
  assert.deepEqual(planned.security.secrets, [])
})

test('a write whose parent is a literal is refused instead of replacing it', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena', timeout: 30 } })
  // `timeout = 30` is a scalar, so the OpenCode write to `timeout.startup` would delete it.
  fs.writeFileSync(
    path.join(config.home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ mcp: { servers: { serena: { command: ['serena'], timeout: 5 } } } }),
  )

  const result = planMirror(config, onlyId(config, 'serena'), 'oc:user')

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /timeout is a literal 5/)
})

test('a source that would leave the other transport field in place is refused', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  fs.writeFileSync(
    codexFile(config),
    ['[mcp_servers.serena]', "url = 'https://example.test/mcp'", ''].join('\n'),
  )

  const result = planMirror(config, onlyId(config, 'serena'), 'codex:user')

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /would leave the entry HTTP/)
})

test('a project override with no transport of its own is refused', () => {
  const config = fixture()
  fs.writeFileSync(
    path.join(config.projectRoot, '.pi', 'mcp.json'),
    JSON.stringify({ mcpServers: { serena: { enabled: false } } }),
  )
  discover(config)

  const result = planMirror(config, onlyId(config, 'serena'), 'codex:user')

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /project override of a base entry/)
})

test('a literal token already in the target is withheld from the diff', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  fs.writeFileSync(
    codexFile(config),
    [
      '[mcp_servers.serena]',
      "command = 'serena'",
      '[mcp_servers.serena.env]',
      'GH_TOKEN = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      '',
    ].join('\n'),
  )

  const result = planMirror(config, onlyId(config, 'serena'), 'codex:user')

  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') return
  assert.deepEqual(result.plan.conflicts, [])
  assert.equal(JSON.stringify(result.plan).includes('ghp_'), false)
})

test('a Pi command retrieval is flagged executable and is not graded safe', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena', env: { TOKEN: '!op read op://vault/token' } } })
  // The same entry is already in the project tier, so nothing conflicts — only the content runs.
  fs.writeFileSync(
    path.join(config.projectRoot, '.pi', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        serena: { command: 'serena', env: { TOKEN: '!op read op://vault/token' } },
      },
    }),
  )
  discover(config)

  const planned = plan(config, 'serena', 'pi:project')

  const executable = planned.writes.filter((write) => write.executable)
  assert.equal(executable.length, 1)
  assert.equal(planned.security.grade, 'risky')
  assert.deepEqual(planned.security.executables, [
    { file: path.join(config.projectRoot, '.pi', 'mcp.json'), why: 'mcpServers.serena.env.TOKEN runs a command at harness runtime' },
  ])
})

test('a Codex env and env_vars naming the same key leaves the passthrough preserved', () => {
  const config = fixture()
  codexFixture(
    config,
    [
      '[mcp_servers.serena]',
      "command = 'serena'",
      "env_vars = ['ORG']",
      '[mcp_servers.serena.env]',
      'ORG = "${ORG}"',
      '',
    ].join('\n'),
  )

  const planned = plan(config, 'serena', 'pi:user')

  // Pi's literal `env` map already holds ORG, so the passthrough has nowhere to land — and saying so
  // is the difference between a reported field and a silently dropped one.
  assert.deepEqual(planned.equivalence.preserved, ['envPassthrough'])
  assert.equal(writeValues(planned).get('mcpServers.serena.env.ORG'), '${ORG}')
  const claimed = [
    ...planned.equivalence.carried,
    ...planned.equivalence.mapped.flatMap((mapped) => mapped.fields),
    ...planned.equivalence.gaps.map((gap) => gap.field),
    ...planned.equivalence.preserved,
  ]
  assert.equal(new Set(claimed).size, claimed.length)
})

test('a server defined in two OpenCode candidate files is refused as ambiguous', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  const root = path.join(config.projectRoot, 'opencode.json')
  const nested = path.join(config.projectRoot, '.opencode', 'opencode.json')
  for (const file of [root, nested]) {
    fs.writeFileSync(file, JSON.stringify({ mcp: { servers: { serena: { command: ['serena'] } } } }))
  }

  const result = planMirror(config, onlyId(config, 'serena'), 'oc:project')

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /defined in both/)
})

test('an existing target reports its digest and its value as the diff, and is left unchanged', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  const target = codexFile(config)
  const written = ['[mcp_servers.serena]', "command = 'serena-old'", ''].join('\n')
  fs.writeFileSync(target, written)

  const planned = plan(config, 'serena', 'codex:user')
  const [write] = planned.writes

  assert.match(String(write?.precondition.digest), /^sha256:[0-9a-f]{64}$/)
  assert.equal(write?.precondition.exists, true)
  // The diff is the pointer's current value against the proposed one, never a whole-file copy.
  assert.equal(write?.priorValue, 'serena-old')
  assert.deepEqual(planned.conflicts, [
    { file: target, pointer: 'mcp_servers.serena.command', current: 'serena-old', proposed: 'serena' },
  ])
  assert.equal(planned.security.grade, 'risky')
  assert.equal(fs.readFileSync(target, 'utf8'), written)
})

test('a plan whose writes already hold the target values is safe, not risky', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  fs.writeFileSync(
    codexFile(config),
    ['[mcp_servers.serena]', "command = 'serena'", ''].join('\n'),
  )

  const planned = plan(config, 'serena', 'codex:user')

  assert.deepEqual(planned.conflicts, [])
  assert.equal(planned.security.grade, 'safe')
  assert.equal(planned.manualSteps.length, 0)
})

test('a plan id is the hash of its own body, so a hand edit fails the check', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  const planned = plan(config, 'serena', 'codex:user')

  assert.match(planned.planId, /^sha256:[0-9a-f]{64}$/)
  assert.equal(planIntact(planned), true)

  const edited = {
    ...planned,
    writes: planned.writes.map((write, index) => (index === 0 ? { ...write, value: 'tampered' } : write)),
  }
  assert.equal(planIntact(edited), false)
})

test('every source field appears exactly once for all six writable targets', () => {
  const config = fixture()
  piFixture(config, {
    serena: {
      command: 'serena',
      args: ['start'],
      url: 'https://example.test/mcp',
      env: { LOG_LEVEL: 'debug' },
      headers: { 'X-Org': '${ORG}' },
      timeout: 30,
      description: 'symbol tools',
      exposure: 'onDemand',
    },
  })

  for (const target of ['pi:user', 'pi:project', 'codex:user', 'codex:project', 'oc:user', 'oc:project']) {
    const planned = plan(config, 'serena', target)
    const claimed = [
      ...planned.equivalence.carried,
      ...planned.equivalence.mapped.flatMap((mapped) => mapped.fields),
      ...planned.equivalence.gaps.map((gap) => gap.field),
      ...planned.equivalence.preserved,
    ]
    assert.equal(
      new Set(claimed).size,
      claimed.length,
      `${target}: duplicate field in ${claimed.join(', ')}`,
    )
    const sourceFields = Object.entries(planned.source.knownFields)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field)
    assert.deepEqual([...claimed].sort(), [...sourceFields].sort(), target)
    // `exposure` is Pi-only; every other harness reports it as a dropped field rather than writing it.
    if (target !== 'pi:user' && target !== 'pi:project') {
      assert.ok(planned.equivalence.gaps.some((gap) => gap.field === 'exposure'), target)
    }
  }

  // A rename is named as one: `headers` is not carried into Codex, it is written to `http_headers`.
  const codex = plan(config, 'serena', 'codex:user')
  assert.ok(
    codex.equivalence.mapped.some(
      (mapped) => mapped.transform === 'rename' && mapped.targetField === 'http_headers',
    ),
  )
  assert.equal(codex.equivalence.carried.includes('headers'), false)
})

// The write tables are data, so their invariants are checked rather than trusted: a misspelled
// field name would never match and the fact would vanish from every plan without a trace.
test('each write surface only names canonical fields, with no field both written and absent', () => {
  const canonical: ReadonlySet<string> = new Set(MCP_FIELDS)
  for (const [harness, surface] of Object.entries(MCP_WRITE_SURFACES)) {
    const written = surface.rules.flatMap((rule) => rule.fields)
    for (const field of [...written, ...surface.absent]) {
      assert.ok(canonical.has(field), `${harness} names ${field}, which is not a canonical fact`)
    }
    for (const field of surface.absent) {
      assert.equal(written.includes(field), false, `${harness} both writes and drops ${field}`)
    }
    for (const rule of surface.rules) {
      // A rule with no target and no gap claims a mapping it never makes.
      assert.ok(
        rule.target !== '' || rule.transform === 'infer' || rule.gap !== undefined,
        `${harness} has a rule for ${rule.fields.join('+')} that writes nothing and reports nothing`,
      )
    }
  }
})

test('a field no adapter names is preserved, never written and never claimed as a gap', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  // A row a future adapter could store: one canonical field plus one this build has no rule for,
  // recorded through the same boundary discovery uses.
  recordDiscovery(
    config.storePath,
    [
      {
        harness: 'pi',
        tierId: 'pi:user',
        health: 'ok',
        detail: null,
        installations: [
          {
            category: 'mcp',
            name: 'future',
            scope: 'user',
            tierId: 'pi:user',
            nativeFile: path.join(config.home, '.pi', 'agent', 'mcp.json'),
            nativePointer: 'mcpServers.future',
            knownFieldsJson: JSON.stringify({ command: 'future', futureField: 'kept' }),
            contentDigest: `sha256:${'b'.repeat(64)}`,
          },
        ],
      },
    ],
    new Date().toISOString(),
  )

  const planned = plan(config, 'future', 'codex:user')

  assert.deepEqual(planned.equivalence.preserved, ['futureField'])
  assert.ok(planned.equivalence.carried.includes('command'))
  assert.equal(
    planned.writes.some((write) => write.pointer.includes('futureField')),
    false,
  )
})

test('a stored row that cannot be decoded is refused, not planned from nothing', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  recordDiscovery(
    config.storePath,
    [
      {
        harness: 'pi',
        tierId: 'pi:user',
        health: 'ok',
        detail: null,
        installations: [
          {
            category: 'mcp',
            name: 'broken',
            scope: 'user',
            tierId: 'pi:user',
            nativeFile: path.join(config.home, '.pi', 'agent', 'mcp.json'),
            nativePointer: 'mcpServers.broken',
            knownFieldsJson: 'not json at all',
            contentDigest: `sha256:${'c'.repeat(64)}`,
          },
        ],
      },
    ],
    new Date().toISOString(),
  )

  const result = planMirror(config, onlyId(config, 'broken'), 'codex:user')

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /known fields cannot be decoded/)
})

test('planning never tombstones an installation the scan no longer sees', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' }, gone: { command: 'gone' } })
  const id = onlyId(config, 'serena')
  const goneId = onlyId(config, 'gone')
  // `gone` disappears from disk after the scan; only a scan may tombstone it.
  fs.writeFileSync(
    path.join(config.home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: { serena: { command: 'serena' } } }),
  )

  const planned = runCli(config, ['mirror', shortId(id), '--target', 'codex:user', '--plan'])
  assert.equal(planned.status, 0, planned.stderr)

  const rows = listInstallations(config, { includeRemoved: true }).installations
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((row) => row.removedAt),
    [null, null],
  )

  // Once a scan has tombstoned it, the row is no longer a source a plan can name.
  discover(config)
  const gone = planMirror(config, goneId, 'codex:user')
  assert.equal(gone.kind, 'refused')
  assert.match(gone.kind === 'refused' ? gone.reason : '', /was removed from/)
})

test('a withheld value is never concatenated into a command', () => {
  const config = fixture()
  piFixture(config, {
    serena: { command: 'serena', args: ['start', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa'] },
  })

  const planned = plan(config, 'serena', 'oc:user')

  assert.deepEqual(planned.equivalence.gaps, [
    { field: 'args', reason: 'credential', replacement: 'dropped' },
  ])
  assert.equal(JSON.stringify(planned.writes).includes('withheld'), false)
})

test('a Pi bearer header becomes a bare Codex token variable, never a literal reference', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena', headers: { Authorization: 'Bearer ${GH_TOKEN}' } } })

  const planned = plan(config, 'serena', 'codex:user')
  const values = writeValues(planned)

  assert.deepEqual(planned.equivalence.mapped, [
    { transform: 'infer', fields: ['transport'], targetField: null },
    {
      transform: 'extract',
      fields: ['headers'],
      targetField: 'bearer_token_env_var',
      template: '^Bearer \\$\\{([A-Za-z_]\\w*)\\}$',
    },
  ])
  assert.equal(values.get('mcp_servers.serena.bearer_token_env_var'), 'GH_TOKEN')
  // Codex does no interpolation, so a copied `Bearer ${GH_TOKEN}` would be a literal token.
  assert.equal(
    planned.writes.some((write) => String(write.value).includes('$')),
    false,
  )
  assert.equal(
    planned.writes.some((write) => write.pointer.includes('http_headers')),
    false,
  )
})

test('a Codex token variable wraps into a Pi header, and env names into Pi references', () => {
  const config = fixture()
  codexFixture(
    config,
    ["[mcp_servers.serena]", "command = 'serena'", "bearer_token_env_var = 'GH_TOKEN'", "env_vars = ['ORG']"].join('\n'),
  )

  const planned = plan(config, 'serena', 'pi:user')
  const values = writeValues(planned)

  assert.deepEqual(
    planned.equivalence.mapped.map((mapped) => [mapped.transform, mapped.targetField]),
    [
      ['infer', null],
      ['wrap', 'env'],
      ['wrap', 'headers'],
    ],
  )
  assert.equal(values.get('mcpServers.serena.headers.Authorization'), 'Bearer ${GH_TOKEN}')
  assert.equal(values.get('mcpServers.serena.env.ORG'), '${ORG}')
})

test('a Codex timeout rescales into OpenCode milliseconds, and an enabled flag inverts', () => {
  const config = fixture()
  codexFixture(
    config,
    [
      '[mcp_servers.serena]',
      "command = 'serena'",
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 5',
      'enabled = false',
    ].join('\n'),
  )

  const planned = plan(config, 'serena', 'oc:user')
  const values = writeValues(planned)
  const mapped = planned.equivalence.mapped.map((entry) => [entry.transform, entry.targetField])

  assert.equal(planned.target.nativeLocation, `${path.join(config.home, '.config', 'opencode', 'opencode.json')}#mcp.servers.serena`)
  assert.deepEqual(mapped, [
    ['infer', 'type'],
    ['concat', 'command'],
    ['invert', 'disabled'],
    ['unit', 'timeout.startup'],
    ['unit', 'timeout.execution'],
  ])
  // OpenCode stores milliseconds where Codex stores seconds.
  assert.equal(values.get('mcp.servers.serena.timeout.startup'), 30_000)
  assert.equal(values.get('mcp.servers.serena.timeout.execution'), 5_000)
  assert.equal(values.get('mcp.servers.serena.disabled'), true)
  assert.equal(values.get('mcp.servers.serena.type'), 'local')
})

test('a command and its args concatenate into the OpenCode command array', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena', args: ['start-mcp-server', '--port', '0'] } })

  const planned = plan(config, 'serena', 'oc:user')

  assert.deepEqual(planned.equivalence.mapped, [
    { transform: 'infer', fields: ['transport'], targetField: 'type' },
    { transform: 'concat', fields: ['command', 'args'], targetField: 'command' },
  ])
  assert.deepEqual(writeValues(planned).get('mcp.servers.serena.command'), [
    'serena',
    'start-mcp-server',
    '--port',
    '0',
  ])
})

test('a remote source is inferred as the remote type OpenCode requires', () => {
  const config = fixture()
  piFixture(config, { serena: { url: 'https://example.test/mcp' } })

  const planned = plan(config, 'serena', 'oc:user')
  const values = writeValues(planned)

  assert.deepEqual(planned.equivalence.mapped, [
    { transform: 'infer', fields: ['transport'], targetField: 'type' },
  ])
  assert.equal(values.get('mcp.servers.serena.type'), 'remote')
  assert.equal(values.get('mcp.servers.serena.url'), 'https://example.test/mcp')
})

test('a target tier that cannot be written is refused before any plan exists', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  const id = onlyId(config, 'serena')

  const profile = planMirror(config, id, 'codex:profile')
  assert.equal(profile.kind, 'refused')
  assert.match(profile.kind === 'refused' ? profile.reason : '', /codex:profile is notState/)

  const system = planMirror(config, id, 'oc:system')
  assert.equal(system.kind, 'refused')
  assert.match(system.kind === 'refused' ? system.reason : '', /oc:system is elevationRequired/)

  const unknownTier = planMirror(config, id, 'codex:nowhere')
  assert.match(unknownTier.kind === 'refused' ? unknownTier.reason : '', /unknown tier "codex:nowhere"/)

  const unknownHarness = planMirror(config, id, 'cursor:user')
  assert.match(unknownHarness.kind === 'refused' ? unknownHarness.reason : '', /unknown harness "cursor"/)

  const noSeparator = planMirror(config, id, 'codex')
  assert.equal(noSeparator.kind, 'refused')
})

test('a server name containing a dot keeps one address in the target', () => {
  const config = fixture()
  piFixture(config, { 'my.server': { command: 'serena' } })
  fs.writeFileSync(
    codexFile(config),
    ['[mcp_servers."my.server"]', "command = 'serena-old'", ''].join('\n'),
  )

  const planned = plan(config, 'my.server', 'codex:user')
  const [write] = planned.writes

  assert.equal(write?.pointer, 'mcp_servers."my.server".command')
  // The prior value is read back through the quoted segment, so the diff names the same entry.
  assert.equal(write?.priorValue, 'serena-old')
})

test('a project target names the switch that makes its write take effect', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })

  const codex = plan(config, 'serena', 'codex:project')
  assert.equal(codex.target.nativeLocation, `${path.join(config.projectRoot, '.codex', 'config.toml')}#mcp_servers.serena`)
  assert.equal(codex.permissions.trust, 'required')
  assert.match(codex.manualSteps[0]?.why ?? '', /treats an untrusted project config as inert/)

  const opencode = plan(config, 'serena', 'oc:project')
  assert.equal(opencode.permissions.trust, 'notRequired')
  assert.match(opencode.manualSteps[0]?.why ?? '', /root-managed layer outranks the project config/)
})

test('a target holding the legacy flat shape is normalised into one shape, siblings preserved', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena', args: ['start'], enabled: false, timeout: 30 } })
  const file = path.join(config.home, '.config', 'opencode', 'opencode.json')
  const onDisk = {
    theme: 'dark',
    mcp: {
      timeout: 5000,
      other: { type: 'local', command: ['other'], enabled: true, timeout: 30_000 },
      serena: { type: 'local', command: ['serena-old'], enabled: true },
    },
  }
  const written = JSON.stringify(onDisk, null, 2)
  fs.writeFileSync(file, written)

  const planned = plan(config, 'serena', 'oc:user')
  const [write] = planned.writes

  // One write replaces the whole block: a document left with both shapes would define every legacy
  // server twice, and this slice has no removal op to delete the flat keys with.
  assert.equal(planned.writes.length, 1)
  assert.equal(write?.pointer, 'mcp')
  assert.deepEqual(write?.value, {
    servers: {
      // The legacy spellings are converted: `enabled` becomes its inverted `disabled`, and the one
      // numeric timeout covers both phases.
      other: { type: 'local', command: ['other'], disabled: false, timeout: { startup: 30_000, execution: 30_000 } },
      serena: {
        type: 'local',
        command: ['serena', 'start'],
        disabled: true,
        timeout: { execution: 30_000 },
      },
    },
    timeout: 5000,
  })
  // The value the legacy address already held is reported, not guessed absent from `mcp.servers`.
  assert.deepEqual(planned.conflicts, [
    { file, pointer: 'mcp', current: onDisk.mcp, proposed: write?.value },
  ])
  assert.deepEqual(planned.verify.asserts, [{ file, pointer: 'mcp', equals: write?.value }])
  assert.deepEqual(
    planned.equivalence.mapped.map((mapped) => [mapped.transform, mapped.targetField]),
    [
      ['infer', 'type'],
      ['concat', 'command'],
      ['invert', 'disabled'],
      ['unit', 'timeout.execution'],
    ],
  )
  assert.equal(fs.readFileSync(file, 'utf8'), written)
})

test('a server defined in both OpenCode shapes is refused rather than resolved by picking one', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  fs.writeFileSync(
    path.join(config.home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      mcp: { serena: { type: 'local', command: ['flat'] }, servers: { serena: { type: 'local', command: ['v2'] } } },
    }),
  )

  const result = planMirror(config, onlyId(config, 'serena'), 'oc:user')

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /defined both flat and under mcp\.servers/)
})

test('a legacy sibling holding a credential is refused, never copied into the plan', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  fs.writeFileSync(
    path.join(config.home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      mcp: {
        other: { type: 'local', command: ['other'], environment: { GH_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      },
    }),
  )

  const result = planMirror(config, onlyId(config, 'serena'), 'oc:user')

  // Carrying the sibling into one block write would put its token into the plan document.
  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /mcp\.servers\.other\.environment\.GH_TOKEN/)
  assert.equal(JSON.stringify(result).includes('ghp_'), false)
})

test('a field OpenCode cannot hold becomes a gap, and a timeout it can is mapped', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena', timeout: 30, description: 'symbol tools' } })

  const planned = plan(config, 'serena', 'oc:user')

  assert.deepEqual(planned.equivalence.gaps, [
    { field: 'description', reason: 'fieldAbsent', replacement: 'dropped' },
  ])
  assert.ok(
    planned.equivalence.mapped.some(
      (mapped) => mapped.transform === 'unit' && mapped.targetField === 'timeout.execution',
    ),
  )
  assert.equal(writeValues(planned).get('mcp.servers.serena.timeout.execution'), 30_000)
})

test('an OpenCode user target names the root-managed layer that could shadow it', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })

  const planned = plan(config, 'serena', 'oc:user')

  assert.match(planned.manualSteps[0]?.step ?? '', /\/etc\/opencode/)
  assert.match(planned.manualSteps[0]?.why ?? '', /outranks the user config/)
})

test('a target file that does not parse is refused rather than planned over', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  fs.writeFileSync(codexFile(config), 'this is not toml = = =')

  const result = planMirror(config, onlyId(config, 'serena'), 'codex:user')

  assert.equal(result.kind, 'refused')
  assert.match(result.kind === 'refused' ? result.reason : '', /cannot be parsed/)
})

test('a shared native location names the other harnesses that read it', () => {
  const config = fixture()
  const shared = path.join(config.home, '.agents', 'skills', 'review', 'SKILL.md')
  const reader = (harness: 'pi' | 'codex', writability: 'writable'): Adapter => ({
    harness,
    claimedCategories: ['skills'],
    handlers: {},
    tiers: [
      {
        id: `${harness}:user`,
        nativeLabel: 'user',
        rank: 1,
        scopeBucket: 'user',
        configPaths: [shared],
        writability,
      },
    ],
  })

  // Two harnesses declaring one path is what a shared `.agents` location looks like: a write there
  // lands for both, so the plan has to say so.
  assert.deepEqual(alsoReadBy([reader('pi', 'writable'), reader('codex', 'writable')], 'codex', shared), [
    'pi',
  ])
  assert.deepEqual(alsoReadBy([reader('pi', 'writable'), reader('codex', 'writable')], 'codex', '/elsewhere'), [])
})

test('the CLI prints the plan document and writes nothing; without --plan it refuses', () => {
  const config = fixture()
  piFixture(config, { serena: { command: 'serena' } })
  const id = onlyId(config, 'serena')

  const planned = runCli(config, ['mirror', shortId(id), '--target', 'codex:user', '--plan'])
  assert.equal(planned.status, 0, planned.stderr)
  const document = JSON.parse(planned.stdout)
  assert.equal(document.kind, 'mirror')
  assert.equal(document.target.tierId, 'codex:user')
  assert.equal(planIntact(document), true)
  assert.equal(fs.existsSync(codexFile(config)), false)

  const noPlan = runCli(config, ['mirror', shortId(id), '--target', 'codex:user'])
  assert.equal(noPlan.status, 1)
  assert.match(noPlan.stderr, /pass --plan/)

  const refused = runCli(config, ['mirror', shortId(id), '--target', 'codex:profile', '--plan'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /refused: codex:profile is notState/)
})

function runCli(config: EngineConfig, args: string[]) {
  const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ACM_HOME: config.home,
      ACM_PROJECT_ROOT: config.projectRoot,
      ACM_STORE: config.storePath,
      CODEX_HOME: path.join(config.home, '.codex'),
    },
  })
}
