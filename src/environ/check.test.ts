import test from 'node:test'
import assert from 'node:assert'
import { evaluateCheck } from './check.ts'

// Seam B: the evaluator is a pure function of the bytes a Check names, so the fixtures are strings
// here and the filesystem never enters. Ticket 07 derives `unknown` for a missing directory, an
// unparseable config, and an unreadable PATH; 03 answers the two file predicates it ships.

test('an exists check is present when the file was read and absent when it is not there', () => {
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc' }, 'export PATH=$PATH:/bin\n'), {
    presence: 'present',
    detail: null,
  })
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc' }, null), { presence: 'absent', detail: null })
})

test('a contains check finds an export in a shell profile', () => {
  const profile = 'export PATH="$HOME/.bun/bin:$PATH"\nexport OPENCODE_DISABLE_CLAUDE_CODE=1\n'
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc', contains: 'OPENCODE_DISABLE_CLAUDE_CODE' }, profile), {
    presence: 'present',
    detail: null,
  })
})

test('a contains check reports absent when the pattern is not in the file', () => {
  const profile = 'export PATH="$HOME/.bun/bin:$PATH"\n'
  assert.deepEqual(evaluateCheck({ file: '/home/ann/.zshrc', contains: 'OPENCODE_DISABLE_CLAUDE_CODE' }, profile), {
    presence: 'absent',
    detail: null,
  })
})

// The pattern is a multiline regular expression, which is what lets a markdown block be addressed by
// its heading rather than by the whole file: `^` has to mean the start of a line.
test('a contains pattern with an anchor matches per line, not only at the start of the file', () => {
  const agents = '# AGENTS\n\n## Output style\n\nBe terse.\n'
  assert.deepEqual(evaluateCheck({ file: '/home/ann/AGENTS.md', contains: '^## Output style' }, agents), {
    presence: 'present',
    detail: null,
  })
})

// A pattern that is not a regex is not the same as an absence: the file may be fine and the pattern
// broken, so the answer says it could not be decided and why.
test('a pattern that does not compile is unknown with the reason', () => {
  const answer = evaluateCheck({ file: '/home/ann/.zshrc', contains: 'OPENCODE(' }, 'x\n')
  assert.equal(answer.presence, 'unknown')
  assert.match(answer.detail ?? '', /OPENCODE\(/)
})
