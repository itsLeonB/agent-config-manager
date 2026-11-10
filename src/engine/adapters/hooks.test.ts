import test from 'node:test'
import assert from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { EngineConfig } from '../config.ts'
import { digestOfBytes } from '../digest.ts'
import { nativeTier } from './native-paths.ts'
import { readHookTier } from './hooks.ts'
import type { HookSource } from './hooks.ts'
import type { HarnessId, Tier, TierRead } from './types.ts'

// Seam B: the hooks reader is a function of one tier's declared file, so every fixture is a file this
// test writes and the assertions are the declarations it answers with.

function fixture(): EngineConfig {
  const root = mkdtempSync(path.join(tmpdir(), 'acm-hooks-'))
  const home = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  return { home, projectRoot, storePath: path.join(root, 'store', 'dashboard.db') }
}

// The tier comes from the one path table, so these tests also pin that each harness declares the
// hooks file the reader then reads.
function tier(config: EngineConfig, harness: HarnessId, tierId: string): Tier {
  const found = nativeTier(config, harness, tierId)
  assert.ok(found !== undefined, `${harness} declares no tier ${tierId}`)
  return found
}

function writeHooks(config: EngineConfig, harness: HarnessId, document: string): string {
  const file = path.join(config.home, harness === 'pi' ? '.pi/agent/hooks.json' : '.codex/hooks.json')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, document)
  return file
}

// The reader's own projection, parsed rather than asserted into shape: a declaration answers with
// JSON bytes, and the test reads them as an agent would.
const HOOK_FACTS = z.object({
  event: z.string(),
  matcher: z.string().optional(),
  handlers: z.array(
    z.object({
      type: z.string().optional(),
      command: z.string().optional(),
      timeout: z.number().optional(),
      print: z.boolean().optional(),
      statusMessage: z.string().optional(),
    }),
  ),
})

function factsOf(read: TierRead, index = 0): z.infer<typeof HOOK_FACTS> {
  const declaration = read.declarations[index]
  assert.ok(declaration !== undefined, `nothing was read at index ${index}`)
  return HOOK_FACTS.parse(JSON.parse(declaration.factsJson))
}

function readAt(config: EngineConfig, harness: HarnessId, source: HookSource, tierId = `${harness}:user`): TierRead {
  return readHookTier(tier(config, harness, tierId), source)
}

// Codex's hooks file is three levels deep, and the address a Provision has to name is the entry's own
// position in it.
test('a Codex hook answers its event, matcher, and handlers, addressed where it sits', () => {
  const config = fixture()
  const document = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: 'serena-hooks remind --client=codex', timeout: 5 }],
        },
      ],
    },
  })
  const file = writeHooks(config, 'codex', document)
  const read = readAt(config, 'codex', 'codex')

  assert.deepEqual(read, {
    health: 'ok',
    detail: null,
    declarations: [
      {
        category: 'hooks',
        name: 'PreToolUse',
        tierId: 'codex:user',
        nativeFile: file,
        nativePointer: 'hooks.PreToolUse.0',
        factsJson: JSON.stringify({
          event: 'PreToolUse',
          matcher: '*',
          handlers: [{ type: 'command', command: 'serena-hooks remind --client=codex', timeout: 5 }],
        }),
        // The digest of the bytes the values were read from, not of the projection.
        contentDigest: digestOfBytes(Buffer.from(document)),
      },
    ],
  })
})

// Pi's bridge is the flatter shape: one command per entry, a bare string meaning one too, and
// milliseconds where the vocabulary holds seconds.
test("a Pi hook answers one handler per entry, with the bridge's milliseconds in seconds", () => {
  const config = fixture()
  writeHooks(
    config,
    'pi',
    JSON.stringify({
      hooks: {
        tool_call: ['serena-hooks remind', { command: 'serena-hooks audit', print: true, timeout: 2500 }],
      },
    }),
  )
  const read = readAt(config, 'pi', 'pi')

  assert.equal(read.health, 'ok')
  assert.deepEqual(
    read.declarations.map((declaration) => declaration.nativePointer),
    ['hooks.tool_call.0', 'hooks.tool_call.1'],
  )
  assert.deepEqual(factsOf(read, 0), {
    event: 'tool_call',
    handlers: [{ type: 'command', command: 'serena-hooks remind' }],
  })
  assert.deepEqual(factsOf(read, 1), {
    event: 'tool_call',
    handlers: [{ type: 'command', command: 'serena-hooks audit', print: true, timeout: 2.5 }],
  })
})

// One harness's entry shape is not another's, so a file in the wrong shape is unreadable rather than
// read as empty: an entry that looks like a hook and is not one must not answer "no hooks here".
test("an entry shaped for the other harness fails the tier closed, naming its address", () => {
  const config = fixture()
  writeHooks(
    config,
    'codex',
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] } }),
  )
  const asPi = readAt(config, 'codex', 'pi')
  assert.equal(asPi.health, 'unreadable')
  assert.match(asPi.detail ?? '', /hooks\.PreToolUse\.0/)
  assert.deepEqual(asPi.declarations, [])

  // And a bare command string, which Pi accepts, is not a Codex matcher group.
  const pi = fixture()
  writeHooks(pi, 'pi', JSON.stringify({ hooks: { tool_call: ['serena-hooks remind'] } }))
  const asCodex = readAt(pi, 'pi', 'codex')
  assert.equal(asCodex.health, 'unreadable')
  assert.match(asCodex.detail ?? '', /hooks\.tool_call\.0/)
})

// A name that merely looks like a hook is not one: the top-level key is `hooks`, and an event's value
// is a list of entries. Neither a document without that key nor an event that is not a list declares
// a hook, and reading one as an empty list would answer for bytes this process did misread.
test('a document that only looks like a hook file declares nothing, and one in the wrong shape fails', () => {
  const config = fixture()
  writeHooks(config, 'codex', JSON.stringify({ PreToolUse: [{ hooks: [] }] }))
  assert.deepEqual(readAt(config, 'codex', 'codex'), { health: 'ok', detail: null, declarations: [] })

  const malformed = fixture()
  writeHooks(malformed, 'codex', JSON.stringify({ hooks: { PreToolUse: { command: 'x' } } }))
  const read = readAt(malformed, 'codex', 'codex')
  assert.equal(read.health, 'unreadable')
  assert.deepEqual(read.declarations, [])

  const broken = fixture()
  writeHooks(broken, 'codex', '{ "hooks": ')
  assert.equal(readAt(broken, 'codex', 'codex').health, 'unreadable')
})

// A command is text like any other, and the two guards are on either side of it: an `=` that assigns
// nothing credential-shaped stays as it was written, and a value the classifier knows is withheld
// before it can reach a declaration.
test('a clean command survives an assignment, and a credentialed one is withheld', () => {
  const config = fixture()
  writeHooks(
    config,
    'codex',
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'command', command: 'serena-hooks remind --client=codex' },
              { type: 'command', command: 'deploy --api_key=ghp_012345678901234567890123456789012345' },
            ],
          },
        ],
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'serena-hooks activate',
                statusMessage: 'ghp_012345678901234567890123456789012345',
              },
            ],
          },
        ],
      },
    }),
  )
  const read = readAt(config, 'codex', 'codex')
  assert.equal(read.health, 'ok')

  // The assignment-shaped command carries no token, so it is the command it was written as.
  assert.equal(factsOf(read, 0).handlers[0]?.command, 'serena-hooks remind --client=codex')
  // The token-bearing one, and the status message, are markers instead of values.
  assert.equal(factsOf(read, 0).handlers[1]?.command, '[withheld: secret]')
  assert.equal(factsOf(read, 1).handlers[0]?.statusMessage, '[withheld: secret]')
  assert.ok(read.declarations.every((declaration) => !declaration.factsJson.includes('ghp_')))
})
