import test from 'node:test'
import assert from 'node:assert'
import type { EngineConfig } from '../config.ts'
import { nativeTier, nativeTiers } from './native-paths.ts'
import { createCodexAdapter } from './codex/index.ts'
import { createOpenCodeAdapter } from './opencode/index.ts'
import { createPiAdapter } from './pi/index.ts'
import type { Tier } from './types.ts'

// A fixture config, not a temporary directory: the lookup only joins strings, so a literal root makes
// every expected path literal too. Recomputed with the same `path.join` it would pin nothing.
const CONFIG: EngineConfig = {
  home: '/fixtures/home',
  projectRoot: '/fixtures/project',
  storePath: '/fixtures/store.db',
  codexHome: '/fixtures/codex-home',
}

const EXPECTED: readonly Tier[] = [
  {
    id: 'pi:user',
    nativeLabel: 'user',
    rank: 1,
    configPaths: ['/fixtures/home/.pi/agent/mcp.json'],
    categoryPaths: {
      skills: { reads: ['/fixtures/home/.agents/skills', '/fixtures/home/.pi/agent/skills'] },
      instructions: { reads: ['/fixtures/home/.pi/agent/AGENTS.md'] },
      hooks: { reads: ['/fixtures/home/.pi/agent/hooks.json'] },
    },
  },
  {
    id: 'pi:project',
    nativeLabel: 'project',
    rank: 2,
    configPaths: ['/fixtures/project/.pi/mcp.json'],
    categoryPaths: {
      skills: { reads: ['/fixtures/project/.agents/skills', '/fixtures/project/.pi/skills'] },
      instructions: { reads: ['/fixtures/project/AGENTS.md'] },
      hooks: { reads: ['/fixtures/project/.pi/hooks.json'] },
    },
  },
  {
    id: 'codex:user',
    nativeLabel: 'user',
    rank: 1,
    configPaths: ['/fixtures/codex-home/config.toml'],
    categoryPaths: {
      skills: { reads: ['/fixtures/home/.agents/skills'] },
      instructions: { reads: ['/fixtures/codex-home/AGENTS.md'] },
      hooks: { reads: ['/fixtures/codex-home/hooks.json'] },
    },
  },
  {
    id: 'codex:project',
    nativeLabel: 'project',
    rank: 2,
    configPaths: ['/fixtures/project/.codex/config.toml'],
    categoryPaths: {
      skills: { reads: ['/fixtures/project/.agents/skills'] },
      instructions: { reads: ['/fixtures/project/AGENTS.md'] },
      hooks: { reads: ['/fixtures/project/.codex/hooks.json'] },
    },
  },
  {
    id: 'oc:project',
    nativeLabel: 'project',
    rank: 1,
    // Both accepted extensions, at the repository root and under `.opencode/`, in read order.
    configPaths: [
      '/fixtures/project/opencode.json',
      '/fixtures/project/opencode.jsonc',
      '/fixtures/project/.opencode/opencode.json',
      '/fixtures/project/.opencode/opencode.jsonc',
    ],
    categoryPaths: {
      skills: {
        reads: [
          '/fixtures/project/.agents/skills',
          '/fixtures/project/.opencode/skills',
          '/fixtures/project/.claude/skills',
        ],
      },
      instructions: { reads: ['/fixtures/project/AGENTS.md'] },
    },
  },
  {
    id: 'oc:user',
    nativeLabel: 'user',
    rank: 2,
    configPaths: ['/fixtures/home/.config/opencode/opencode.json', '/fixtures/home/.config/opencode/opencode.jsonc'],
    categoryPaths: {
      skills: {
        reads: [
          '/fixtures/home/.agents/skills',
          '/fixtures/home/.config/opencode/skills',
          '/fixtures/home/.claude/skills',
        ],
      },
      instructions: { reads: ['/fixtures/home/.config/opencode/AGENTS.md'] },
    },
  },
  {
    id: 'oc:system',
    nativeLabel: '/etc/opencode',
    rank: 3,
    configPaths: ['/etc/opencode/opencode.json', '/etc/opencode/opencode.jsonc'],
  },
]

test('every harness tier keeps its declared native paths', () => {
  assert.deepEqual(
    [...nativeTiers(CONFIG, 'pi'), ...nativeTiers(CONFIG, 'codex'), ...nativeTiers(CONFIG, 'opencode')],
    EXPECTED,
  )
})

test('a tier is answerable on its own and an unnamed one is undefined', () => {
  assert.deepEqual(nativeTier(CONFIG, 'opencode', 'oc:project'), EXPECTED[4])
  assert.deepEqual(nativeTier(CONFIG, 'pi', 'pi:project'), EXPECTED[1])
  assert.equal(nativeTier(CONFIG, 'pi', 'codex:project'), undefined)
})

test('Codex falls back to `~/.codex` when no CODEX_HOME is resolved', () => {
  const withoutCodexHome: EngineConfig = {
    home: CONFIG.home,
    projectRoot: CONFIG.projectRoot,
    storePath: CONFIG.storePath,
  }
  assert.deepEqual(nativeTiers(withoutCodexHome, 'codex')[0]?.configPaths, ['/fixtures/home/.codex/config.toml'])
  assert.equal(nativeTiers(withoutCodexHome, 'codex')[0]?.categoryPaths?.hooks?.reads[0], '/fixtures/home/.codex/hooks.json')
})

test('each adapter reads its tiers from the lookup, not its own table', () => {
  const adapters = [createPiAdapter(CONFIG), createCodexAdapter(CONFIG), createOpenCodeAdapter(CONFIG)]
  for (const adapter of adapters) {
    assert.deepEqual(adapter.tiers, nativeTiers(CONFIG, adapter.harness))
  }
})
