import test from 'node:test'
import assert from 'node:assert/strict'
import { isSameOriginRequest, isSameOriginMutationRequest } from './origin-guard.ts'

const ALLOWED = ['http://localhost:3000']

test('same-origin request is allowed', () => {
  assert.equal(isSameOriginRequest('http://localhost:3000', 'same-origin', ALLOWED), true)
})

test('same-origin request without a fetch indicator is allowed when the origin matches', () => {
  assert.equal(isSameOriginRequest('http://localhost:3000', null, ALLOWED), true)
})

test('cross-origin request is rejected', () => {
  assert.equal(isSameOriginRequest('https://evil.example', 'cross-site', ALLOWED), false)
})

test('cross-origin request that forges a same-origin fetch indicator is rejected', () => {
  assert.equal(isSameOriginRequest('https://evil.example', 'same-origin', ALLOWED), false)
})

test('request with neither origin nor a same-origin fetch indicator is rejected', () => {
  assert.equal(isSameOriginRequest(null, null, ALLOWED), false)
})

test('request with no origin and a non same-origin fetch indicator is rejected', () => {
  assert.equal(isSameOriginRequest(null, 'cross-site', ALLOWED), false)
})

test('a mutation from the dashboard origin is allowed', () => {
  const request = new Request('http://localhost:3000/settings', {
    headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(isSameOriginMutationRequest(request), true)
})

test('a mutation from a foreign origin is rejected', () => {
  const request = new Request('http://localhost:3000/settings', {
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(isSameOriginMutationRequest(request), false)
})

test('forwarded headers do not widen the allowlist for a foreign origin', () => {
  const request = new Request('http://10.0.0.5:3000/settings', {
    headers: {
      origin: 'https://evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'sec-fetch-site': 'same-origin',
    },
  })
  assert.equal(isSameOriginMutationRequest(request), false)
})

test('PUBLIC_ORIGIN widens the allowlist for a proxied deployment', (t) => {
  const previous = process.env.PUBLIC_ORIGIN
  process.env.PUBLIC_ORIGIN = 'http://acm.localhost'
  t.after(() => {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN
    else process.env.PUBLIC_ORIGIN = previous
  })

  const request = new Request('http://10.0.0.5:3000/settings', {
    headers: { origin: 'http://acm.localhost', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(isSameOriginMutationRequest(request), true)
})

test('an empty PUBLIC_ORIGIN adds nothing', (t) => {
  const previous = process.env.PUBLIC_ORIGIN
  process.env.PUBLIC_ORIGIN = '   '
  t.after(() => {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN
    else process.env.PUBLIC_ORIGIN = previous
  })

  const request = new Request('http://10.0.0.5:3000/settings', {
    headers: { origin: 'http://acm.localhost', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(isSameOriginMutationRequest(request), false)
})

test('a non-loopback received origin is rejected while PUBLIC_ORIGIN is unset', (t) => {
  const previous = process.env.PUBLIC_ORIGIN
  delete process.env.PUBLIC_ORIGIN
  t.after(() => {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN
    else process.env.PUBLIC_ORIGIN = previous
  })

  // The Host header is browser-supplied, so a matching Origin on a non-loopback request
  // proves nothing on its own; only PUBLIC_ORIGIN may vouch for that address.
  const request = new Request('http://10.0.0.5:3000/settings', {
    headers: { origin: 'http://10.0.0.5:3000', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(isSameOriginMutationRequest(request), false)
})

test('a loopback received origin is trusted without PUBLIC_ORIGIN', (t) => {
  const previous = process.env.PUBLIC_ORIGIN
  delete process.env.PUBLIC_ORIGIN
  t.after(() => {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN
    else process.env.PUBLIC_ORIGIN = previous
  })

  const request = new Request('http://127.0.0.1:3000/settings', {
    headers: { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(isSameOriginMutationRequest(request), true)
})
