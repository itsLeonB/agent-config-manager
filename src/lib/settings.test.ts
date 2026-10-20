import test from 'node:test'
import assert from 'node:assert/strict'
import { draftToSettings, toDraft, validateDraft } from './settings.ts'
import type { SettingsDraft } from './settings.ts'

const validDraft: SettingsDraft = {
  projectsRoot: ' /home/me/Projects ',
  scanIntervalMinutes: '30',
  skipPaths: '/home/me/Projects/noisy\n\n  /home/me/Projects/vendor  \n',
  tools: [{ name: 'Bun', checkCommand: 'bun --version', installCommand: 'curl -fsSL https://bun.sh/install | bash' }],
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
      { name: 'Bun', checkCommand: 'bun --version', installCommand: 'install-bun' },
      { name: 'bun', checkCommand: 'bun --version', installCommand: 'install-bun' },
    ],
  })
  assert.deepEqual(
    errors.map((error) => error.field),
    ['environmentTools'],
  )
})

test('a tool with a blank check command is reported against the environment tools area', () => {
  const errors = validateDraft({ ...validDraft, tools: [{ name: 'Bun', checkCommand: '', installCommand: 'i' }] })
  assert.equal(errors.length, 1)
  assert.equal(errors[0].field, 'environmentTools')
  assert.match(errors[0].message, /Tool 1/)
})
