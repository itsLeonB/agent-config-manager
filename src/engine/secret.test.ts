import test from 'node:test'
import assert from 'node:assert'
import {
  classify,
  classifyWholeFile,
  storedVerdict,
  withheldMarker,
  type CredentialPointer,
} from './secret.ts'

const POINTERS: CredentialPointer[] = [
  { pointer: 'env.*', kind: 'leaf' },
  { pointer: 'headers.*', kind: 'leaf' },
]

const verdictOf = (pointer: string, value: string, pointers: CredentialPointer[] = []): string =>
  classify(pointer, value, pointers).verdict

// Rule 1: a harness's own indirection is secret-free by construction, so it outranks the pointer.
test('rule 1: interpolation and command retrieval are clean, the command executable', () => {
  assert.equal(verdictOf('env.OPENAI_API_KEY', '${OPENAI_API_KEY}', POINTERS), 'clean')
  assert.equal(verdictOf('headers.Authorization', 'Bearer ${GITHUB_TOKEN}', POINTERS), 'clean')
  assert.equal(verdictOf('env.TOKEN', '{env:TOKEN}', POINTERS), 'clean')
  assert.equal(verdictOf('env.TOKEN', '$TOKEN', POINTERS), 'clean')

  const command = classify('env.TOKEN', '!op read op://vault/token', POINTERS)
  assert.deepEqual(command, { verdict: 'clean', executable: true })
  // A command cannot launder the token it was written to retrieve.
  assert.equal(
    verdictOf('env.TOKEN', '!printf sk-proj-AbCdEfGhIjKlMnOpQrStUvWx', POINTERS),
    'secret',
  )
})

// Rule 0: the adapter's own credential pointers.
test('rule 0: a value at a declared credential pointer is secret whatever it looks like', () => {
  assert.equal(verdictOf('env.GITHUB_TOKEN', 'short', POINTERS), 'secret')
  assert.equal(verdictOf('headers.X-Api-Key', 'anything at all', POINTERS), 'secret')
  // The declaration is data: without it the same value is judged on its shape alone.
  assert.equal(verdictOf('env.GITHUB_TOKEN', 'short'), 'clean')
  // A quoted segment keeps its address, and a dot inside a key does not invent a new level.
  assert.equal(verdictOf('env."A.B"', 'short', POINTERS), 'secret')
})

// Rule 2: length-anchored provider patterns, instanced from the real config corpus.
test('rule 2: provider token shapes are secret', () => {
  const tokens = [
    'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
    'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789012-abcdefghijkl',
    'npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'https://user:pass@example.test/mcp',
  ]
  for (const token of tokens) assert.equal(verdictOf('args.0', token), 'secret', token)
})

// Rule 3: a private-key block.
test('rule 3: a PEM private-key block is secret', () => {
  assert.equal(
    verdictOf('description', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'),
    'secret',
  )
})

// Rule 4: the false-positive guard that keeps digests clean.
test('rule 4: a digest-shaped value under a hash-shaped name stays clean', () => {
  const digest = '9f2c8b1d4a6e0f3c5d7b9a1e2c4f6081d3b5a7c9e1f20486a8c0d2e4f6071829'
  assert.equal(verdictOf('hooks.state.session.trusted_hash', digest), 'clean')
  assert.equal(verdictOf('contentDigest', `sha256:${digest}`), 'clean')
  assert.equal(verdictOf('token_id', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'), 'clean')
  assert.equal(verdictOf('artifact_checksum', '01ARZ3NDEKTSV4RRFFQ69G5FAV'), 'clean')
  // The guard is the name, not the shape: the same digest under a plain name is not a credential
  // either, but a token-shaped value under a digest name is still caught by rules 2 and 3.
  assert.equal(verdictOf('fingerprint', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'), 'secret')
})

// Rule 5: a credential-shaped name is a suspicion even when the value looks arbitrary.
test('rule 5: a credential name with a value long enough to be one is suspect', () => {
  assert.equal(verdictOf('input.password', 'hunter2hunter2'), 'suspect')
  assert.equal(verdictOf('config.apiKey', 'not-a-provider-token'), 'suspect')
  // Too short to be a credential: `enabled: true` style values under a credential name.
  assert.equal(verdictOf('input.password', 'no'), 'clean')
})

// Rule 6: entropy, gated by the alphabet the value is drawn from.
test('rule 6: base64-shaped high-entropy values are suspect, without the gate they are not', () => {
  assert.equal(verdictOf('description', 'Xk9d2mQ4pR7sT1vY3nB6hL0aZ8cW5eJ2'), 'suspect')
  // Same alphabet, no upper case: the gate is what keeps a slug from being flagged.
  assert.equal(verdictOf('description', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'), 'clean')
  assert.equal(verdictOf('description', 'the quick brown fox jumps over the lazy dog'), 'clean')
})

// Rule 7: hex caps below the base64 threshold, so it needs its own bar.
test('rule 7: a long hex value under a credential name is judged on its entropy', () => {
  const hex = '9f2c8b1d4a6e0f3c5d7b9a1e2c4f6081d3b5a7c9e1f20486a8c0d2e4f6071829'
  assert.equal(verdictOf('config.api_key', hex), 'suspect')
  assert.equal(verdictOf('config.api_key', '0'.repeat(64)), 'clean')
  // The name is still required: a hash under a plain name is not a credential.
  assert.equal(verdictOf('description', hex), 'clean')
})

// Rule 8: everything else.
test('rule 8: ordinary configuration values are clean', () => {
  assert.equal(verdictOf('command', 'serena'), 'clean')
  assert.equal(verdictOf('description', 'symbol tools'), 'clean')
  assert.equal(verdictOf('env.NAME', 'OPENAI_API_KEY'), 'clean')
  assert.equal(verdictOf('env.HOST', 'https://example.test/mcp'), 'clean')
  assert.equal(
    verdictOf('public_key', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----'),
    'clean',
  )
})

test('a whole-file category is scanned line by line, and a digest line stays clean', () => {
  const file = 'skills/fixture.md'
  assert.equal(classifyWholeFile(file, '# Skill\n\nUse the token sk-proj-AbCdEfGhIjKlMnOpQrStUvWx\n'), 'secret')
  assert.equal(classifyWholeFile(file, '# Skill\n\ncontentDigest: 9f2c8b1d4a6e0f3c5d7b9a1e2c4f6081\n'), 'clean')
  assert.equal(classifyWholeFile(file, 'a document with plain prose\n'), 'clean')
  // A `key = value` line keeps its key as the pointer, so the name-based rules still apply inside one.
  assert.equal(classifyWholeFile(file, 'api_token = hunter2hunter2\n'), 'suspect')
  assert.equal(classifyWholeFile(file, '## Usage\n\nRun the command.\n'), 'clean')
})

test('a withheld marker carries its own verdict, so a stored value needs no side table', () => {
  assert.equal(withheldMarker('secret'), '[withheld: secret]')
  assert.equal(storedVerdict(withheldMarker('suspect')), 'suspect')
  assert.equal(storedVerdict('[withheld: secret] https://example.test/mcp'), 'secret')
  assert.equal(storedVerdict('serena'), 'clean')
})
