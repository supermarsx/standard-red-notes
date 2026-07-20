import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkRequiredSecret,
  HEX_KEYS,
  parseEnvFile,
  REQUIRED_KEYS,
  resolveEnvValue,
  sharedKeyGate,
} from '../src/env.ts'

const HEX64 = 'a'.repeat(64)

test('parseEnvFile reads KEY=VALUE pairs', () => {
  assert.deepEqual(parseEnvFile('A=1\nB=two\n'), { A: '1', B: 'two' })
})

test('parseEnvFile handles CRLF line endings', () => {
  assert.deepEqual(parseEnvFile('A=1\r\nB=2\r\n'), { A: '1', B: '2' })
})

test('parseEnvFile ignores blank lines and # comments', () => {
  assert.deepEqual(parseEnvFile('# a comment\n\n   \nA=1\n  # indented comment\n'), { A: '1' })
})

test('parseEnvFile ignores lines with no =', () => {
  assert.deepEqual(parseEnvFile('JUST_A_WORD\nA=1\n'), { A: '1' })
})

test('parseEnvFile keeps everything after the first = (secrets contain =)', () => {
  assert.equal(parseEnvFile('TOKEN=abc=def==\n').TOKEN, 'abc=def==')
})

test('parseEnvFile strips one layer of matching surrounding quotes', () => {
  assert.equal(parseEnvFile('A="quoted"\n').A, 'quoted')
  assert.equal(parseEnvFile("B='quoted'\n").B, 'quoted')
})

test('parseEnvFile leaves mismatched or inner quotes alone', () => {
  assert.equal(parseEnvFile('A="unclosed\n').A, '"unclosed')
  assert.equal(parseEnvFile('B=say "hi"\n').B, 'say "hi"')
})

test('parseEnvFile trims surrounding whitespace on key and value', () => {
  assert.deepEqual(parseEnvFile('  A  =  1  \n'), { A: '1' })
})

test('parseEnvFile lets a later duplicate win', () => {
  assert.equal(parseEnvFile('A=1\nA=2\n').A, '2')
})

test('parseEnvFile returns {} for empty content', () => {
  assert.deepEqual(parseEnvFile(''), {})
})

test('every hex-shaped key is also a required key', () => {
  for (const key of HEX_KEYS) {
    assert.ok(REQUIRED_KEYS.includes(key), `${key} is hex-validated but not required`)
  }
})

test('checkRequiredSecret reports an unset or empty secret as missing', () => {
  assert.deepEqual(checkRequiredSecret('MYSQL_PASSWORD', undefined), { status: 'missing' })
  assert.deepEqual(checkRequiredSecret('MYSQL_PASSWORD', ''), { status: 'missing' })
})

test('checkRequiredSecret flags CHANGE-ME placeholders in any casing or spelling', () => {
  for (const value of ['CHANGE-ME', 'changeme', 'please-CHANGEME-now', 'x-Change-Me-x']) {
    assert.deepEqual(checkRequiredSecret('MYSQL_PASSWORD', value), { status: 'placeholder' }, value)
  }
})

test('checkRequiredSecret flags a placeholder even when it is 64 chars of hex-adjacent text', () => {
  // Placeholder must be checked BEFORE the hex shape, or a padded CHANGEME slips through.
  const padded = ('changeme' + 'a'.repeat(56)).slice(0, 64)
  assert.equal(padded.length, 64)
  assert.deepEqual(checkRequiredSecret('AUTH_JWT_SECRET', padded), { status: 'placeholder' })
})

test('checkRequiredSecret accepts 64-char hex for key-material entries', () => {
  assert.deepEqual(checkRequiredSecret('AUTH_JWT_SECRET', HEX64), { status: 'ok', length: 64 })
  assert.deepEqual(checkRequiredSecret('VALET_TOKEN_SECRET', 'F'.repeat(64)), { status: 'ok', length: 64 })
})

test('checkRequiredSecret rejects short, long or non-hex key material as weak', () => {
  assert.deepEqual(checkRequiredSecret('AUTH_JWT_SECRET', 'a'.repeat(63)), { status: 'weak' })
  assert.deepEqual(checkRequiredSecret('AUTH_JWT_SECRET', 'a'.repeat(65)), { status: 'weak' })
  assert.deepEqual(checkRequiredSecret('AUTH_JWT_SECRET', 'z'.repeat(64)), { status: 'weak' })
  assert.deepEqual(checkRequiredSecret('AUTH_JWT_SECRET', 'hunter2'), { status: 'weak' })
})

test('checkRequiredSecret does not impose the hex shape on passwords', () => {
  const verdict = checkRequiredSecret('MYSQL_PASSWORD', 'a perfectly fine passphrase')
  assert.deepEqual(verdict, { status: 'ok', length: 'a perfectly fine passphrase'.length })
})

test('checkRequiredSecret never returns the secret value itself', () => {
  const secret = `${HEX64}`
  const verdict = checkRequiredSecret('AUTH_JWT_SECRET', secret)
  assert.ok(!JSON.stringify(verdict).includes(secret), 'the verdict must carry only a status and a length')
})

test('every required key gets a verdict when validated against a complete env', () => {
  const env: Record<string, string> = {}
  for (const key of REQUIRED_KEYS) {
    env[key] = HEX_KEYS.has(key) ? HEX64 : 'strong-passphrase'
  }
  for (const key of REQUIRED_KEYS) {
    assert.equal(checkRequiredSecret(key, env[key]).status, 'ok', key)
  }
})

test('resolveEnvValue prefers the process environment over the .env file', () => {
  assert.equal(resolveEnvValue('A', { A: 'from-process' }, { A: 'from-file' }), 'from-process')
})

test('resolveEnvValue falls back to the .env file, then to undefined', () => {
  assert.equal(resolveEnvValue('A', {}, { A: 'from-file' }), 'from-file')
  assert.equal(resolveEnvValue('A', {}, {}), undefined)
})

test('sharedKeyGate is off when no key is configured anywhere', () => {
  assert.deepEqual(sharedKeyGate({}, {}), { enabled: false, mode: 'all' })
})

test('sharedKeyGate treats an empty key as off, not enabled', () => {
  assert.equal(sharedKeyGate({}, { SHARED_SERVER_ACCESS_KEY: '' }).enabled, false)
})

test('sharedKeyGate reports enabled with the default mode when only a key is set', () => {
  assert.deepEqual(sharedKeyGate({}, { SHARED_SERVER_ACCESS_KEY: 'k' }), { enabled: true, mode: 'all' })
})

test('sharedKeyGate reports the configured mode', () => {
  assert.deepEqual(sharedKeyGate({ SHARED_SERVER_ACCESS_KEY_MODE: 'write' }, { SHARED_SERVER_ACCESS_KEY: 'k' }), {
    enabled: true,
    mode: 'write',
  })
})

test('sharedKeyGate never returns the key value', () => {
  const gate = sharedKeyGate({}, { SHARED_SERVER_ACCESS_KEY: 'super-secret-gate-value' })
  assert.ok(!JSON.stringify(gate).includes('super-secret'))
})
