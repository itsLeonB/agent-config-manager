import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digestOfBytes, digestOfPath, relativeFiles } from './digest.ts'

// The digest is what makes two copies of one thing comparable, so its assertions are about the
// cases a copy has to tell apart: a changed byte, a new file, a moved file, a missing path.
function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-digest-test-'))
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return root
}

test('a file digests to the digest of its own bytes', () => {
  const root = tree({ 'SKILL.md': '# demo\n' })
  const file = path.join(root, 'SKILL.md')
  assert.equal(digestOfPath(file), digestOfBytes(fs.readFileSync(file)))
  // Stable across calls: a digest that moved on its own would read as drift.
  assert.equal(digestOfPath(file), digestOfPath(file))
})

test('a directory covers every file beneath it, by relative path', () => {
  const root = tree({ 'SKILL.md': '# demo\n', 'scripts/run.sh': 'echo hi\n' })
  assert.deepEqual(relativeFiles(root), ['SKILL.md', 'scripts/run.sh'])
})

test('a directory digest follows a changed byte and a new file, and not the copy itself', () => {
  const root = tree({ 'SKILL.md': '# demo\n', 'scripts/run.sh': 'echo hi\n' })
  const copy = tree({ 'SKILL.md': '# demo\n', 'scripts/run.sh': 'echo hi\n' })
  // Two copies of one tree are the same tree, wherever each sits on disk.
  assert.equal(digestOfPath(root), digestOfPath(copy))

  const before = digestOfPath(root)
  fs.writeFileSync(path.join(root, 'scripts', 'run.sh'), 'echo bye\n')
  const edited = digestOfPath(root)
  assert.notEqual(edited, before)

  fs.writeFileSync(path.join(root, 'scripts', 'extra.sh'), 'echo hi\n')
  assert.notEqual(digestOfPath(root), edited)
})

test('a path that is not there has no digest', () => {
  const root = tree({ 'SKILL.md': '# demo\n' })
  assert.equal(digestOfPath(path.join(root, 'missing')), null)
})
