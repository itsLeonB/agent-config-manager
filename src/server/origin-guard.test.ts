import test from 'node:test'
import assert from 'node:assert/strict'
import { isSameOriginRequest } from './origin-guard.ts'

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
