import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BASE_URL,
  defaultProbes,
  gateHeaders,
  normalizeBaseUrl,
  parseArgs,
  resolveBaseUrl,
  resolveSharedKey,
} from '../src/cli.ts'

test('normalizeBaseUrl strips a single trailing slash', () => {
  assert.equal(normalizeBaseUrl('http://h:3001/'), 'http://h:3001')
  assert.equal(normalizeBaseUrl('http://h:3001'), 'http://h:3001')
})

test('normalizeBaseUrl preserves a path prefix', () => {
  assert.equal(normalizeBaseUrl('https://h/srn/'), 'https://h/srn')
})

test('defaultProbes builds exactly one healthcheck probe', () => {
  const probes = defaultProbes('http://localhost:3001')
  assert.equal(probes.length, 1)
  assert.equal(probes[0].url, 'http://localhost:3001/healthcheck')
  assert.ok(probes[0].name.length > 0)
})

test('defaultProbes does not double the slash when the base URL has one', () => {
  assert.equal(defaultProbes('http://localhost:3001/').at(0)?.url, 'http://localhost:3001/healthcheck')
})

test('defaultProbes appends to a path prefix rather than replacing it', () => {
  assert.equal(defaultProbes('https://h/srn').at(0)?.url, 'https://h/srn/healthcheck')
})

test('resolveBaseUrl prefers --url over $SRN_SERVER_URL over the default', () => {
  assert.equal(resolveBaseUrl(parseArgs(['--url', 'http://flag']), { SRN_SERVER_URL: 'http://env' }), 'http://flag')
  assert.equal(resolveBaseUrl(parseArgs([]), { SRN_SERVER_URL: 'http://env' }), 'http://env')
  assert.equal(resolveBaseUrl(parseArgs([]), {}), DEFAULT_BASE_URL)
})

test('resolveBaseUrl ignores a valueless --url and falls through', () => {
  assert.equal(resolveBaseUrl(parseArgs(['--url']), {}), DEFAULT_BASE_URL)
})

test('the default base URL is loopback, so a bare `health` never probes a remote host', () => {
  assert.match(DEFAULT_BASE_URL, /^http:\/\/localhost:/)
})

test('resolveSharedKey prefers --server-key over $SHARED_SERVER_ACCESS_KEY', () => {
  assert.equal(resolveSharedKey(parseArgs(['--server-key', 'flag']), { SHARED_SERVER_ACCESS_KEY: 'env' }), 'flag')
  assert.equal(resolveSharedKey(parseArgs([]), { SHARED_SERVER_ACCESS_KEY: 'env' }), 'env')
})

test('resolveSharedKey is undefined when the gate is not configured', () => {
  assert.equal(resolveSharedKey(parseArgs([]), {}), undefined)
})

test('gateHeaders sends no header at all when there is no key', () => {
  assert.deepEqual(gateHeaders(undefined), {})
  assert.deepEqual(gateHeaders(''), {}, 'an empty key must not become an empty header')
})

test('gateHeaders sends the shared key under the exact header the server gate reads', () => {
  assert.deepEqual(gateHeaders('k'), { 'X-Shared-Server-Key': 'k' })
})
