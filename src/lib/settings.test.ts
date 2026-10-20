import test from 'node:test'
import assert from 'node:assert/strict'
import { draftToSettings, toDraft, validateDraft } from './settings.ts'
import type { SettingsDraft } from './settings.ts'

const validDraft: SettingsDraft = {
  projectsRoot: ' /home/me/Projects ',
  scanIntervalMinutes: '30',
  skipPaths: '/home/me/Projects/noisy\n\n  /home/me/Projects/vendor  \n',
  tools: [
    { rowKey: 'bun', name: 'Bun', checkCommand: 'bun --version', installCommand: 'curl -fsSL https://bun.sh/install | bash' },
  ],
}

test('a draft becomes settings with trimmed values, one path per line and an id derived from the name', () => {
  assert.deepEqual(draftToSettings(validDraft), {
    projectsRoot: '/home/me/Projects',
    scanIntervalMinutes: 30,
    skipPaths: ['/home/me/Projects/noisy', '/home/me/Projects/vendor'],
    environmentTools: [
      {
        id: 'bun',
        name: 'Bun',
        checkCommand: 'bun --version',
        installCommand: 'curl -fsSL https://bun.sh/install | bash',
      },
    ],
  })
})

test('settings round-trip through a draft unchanged', () => {
  const settings = draftToSettings(validDraft)
  assert.deepEqual(draftToSettings(toDraft(settings)), settings)
})

test('a valid draft reports no field errors', () => {
  assert.deepEqual(validateDraft(validDraft), [])
})

test('a relative root and a zero interval are reported against their own fields', () => {
  const errors = validateDraft({ ...validDraft, projectsRoot: 'Projects', scanIntervalMinutes: '0' })
  assert.deepEqual(
    errors.map((error) => error.field),
    ['projectsRoot', 'scanIntervalMinutes'],
  )
})

test('a blank interval and a relative skip path are rejected', () => {
  const errors = validateDraft({ ...validDraft, scanIntervalMinutes: '', skipPaths: 'relative/path' })
  assert.deepEqual(
    errors.map((error) => error.field),
    ['scanIntervalMinutes', 'skipPaths'],
  )
})

test('two tools with the same name are reported against the environment tools area', () => {
  const errors = validateDraft({
    ...validDraft,
    tools: [
      { rowKey: 'bun', name: 'Bun', checkCommand: 'bun --version', installCommand: 'install-bun' },
      { rowKey: 'bun-2', name: 'bun', checkCommand: 'bun --version', installCommand: 'install-bun' },
    ],
  })
  assert.deepEqual(
    errors.map((error) => error.field),
    ['environmentTools'],
  )
})

test('a tool with a blank check command is reported against the environment tools area', () => {
  const errors = validateDraft({ ...validDraft, tools: [{ rowKey: 'bun', name: 'Bun', checkCommand: '', installCommand: 'i' }] })
  assert.equal(errors.length, 1)
  assert.equal(errors[0].field, 'environmentTools')
  assert.match(errors[0].message, /Tool 1/)
})

test('a tool error carries the row it belongs to, so the summary can point at that row', () => {
  const errors = validateDraft({
    ...validDraft,
    tools: [
      { rowKey: 'bun', name: 'Bun', checkCommand: 'bun --version', installCommand: 'install-bun' },
      { rowKey: 'rtk', name: 'RTK', checkCommand: '', installCommand: 'install-rtk' },
    ],
  })
  assert.deepEqual(
    errors.map((error) => [error.field, error.toolIndex, error.message]),
    [['environmentTools', 1, 'Tool 2: Check command is required.']],
  )
})

test('an error outside the tools area carries no row', () => {
  const errors = validateDraft({ ...validDraft, projectsRoot: 'Projects' })
  assert.equal(errors[0].toolIndex, undefined)
})

test('a draft keeps a stable row key per tool, taken from the stored tool id', () => {
  assert.deepEqual(
    toDraft(draftToSettings(validDraft)).tools.map((tool) => tool.rowKey),
    ['bun'],
  )
})
