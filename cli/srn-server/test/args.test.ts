import { test } from 'node:test'
import assert from 'node:assert/strict'

import { flagStr, parseArgs } from '../src/cli.ts'

test('parseArgs splits positionals from flags', () => {
  const { _, flags } = parseArgs(['logs', 'server'])
  assert.deepEqual(_, ['logs', 'server'])
  assert.deepEqual(flags, {})
})

test('parseArgs reads --key=value without consuming the next token', () => {
  const { _, flags } = parseArgs(['--url=http://localhost:3001', 'health'])
  assert.equal(flags.url, 'http://localhost:3001')
  assert.deepEqual(_, ['health'])
})

test('parseArgs keeps everything after the first = in --key=value', () => {
  assert.equal(parseArgs(['--url=http://h/p?a=1&b=2']).flags.url, 'http://h/p?a=1&b=2')
})

test('parseArgs reads --key value and skips the consumed value', () => {
  const { _, flags } = parseArgs(['logs', '--tail', '100'])
  assert.equal(flags.tail, '100')
  assert.deepEqual(_, ['logs'], 'the consumed value must not leak into positionals')
})

test('parseArgs stops at ANY leading dash, so short flags are not swallowed as values', () => {
  // srn-server's parser is stricter than srn-client's (which only stops at "--"):
  // `--follow -f` must be two flags, not follow="-f".
  const { _, flags } = parseArgs(['logs', '--follow', '-f'])
  assert.equal(flags.follow, true)
  assert.deepEqual(_, ['logs'])
})

test('parseArgs maps -f to follow, as HELP documents', () => {
  assert.equal(parseArgs(['logs', '-f']).flags.follow, true)
})

test('parseArgs never treats a dash-leading token as a positional', () => {
  // Regression: `-f` used to fall through to `_`, so `logs -f server` resolved
  // the SERVICE to "-f" and silently dropped "server".
  assert.deepEqual(parseArgs(['logs', '-f', 'server'])._, ['logs', 'server'])
  assert.deepEqual(parseArgs(['logs', '-x'])._, ['logs'], 'an unknown switch is dropped, not used as a service')
})

test('parseArgs treats a flag followed by another flag as boolean', () => {
  const { flags } = parseArgs(['--build', '--repo', '/tmp/x'])
  assert.equal(flags.build, true)
  assert.equal(flags.repo, '/tmp/x')
})

test('parseArgs treats a trailing flag as boolean', () => {
  assert.equal(parseArgs(['down', '--yes']).flags.yes, true)
})

// --- valueless boolean flags -------------------------------------------------
//
// Regression: boolean switches were not declared, so the parser could not tell
// `--build server` (switch + service) from `--tail 50` (flag + value). It bound
// the following token as the switch's VALUE, which both made the flag a string
// and removed the service from the positionals — `up --build server` ran
// `docker compose up -d --build` against the WHOLE stack.

const BOOLEANS = ['help', 'follow', 'build', 'yes', 'volumes', 'compose-config']

for (const name of BOOLEANS) {
  test(`--${name} is boolean true when followed by a positional, and keeps the positional`, () => {
    const { _, flags } = parseArgs([`--${name}`, 'server'])
    assert.equal(flags[name], true, `--${name} must not bind "server" as its value`)
    assert.deepEqual(_, ['server'], `--${name} must not consume the positional`)
  })

  test(`--${name} is boolean true at the end of argv`, () => {
    assert.equal(parseArgs([`--${name}`]).flags[name], true)
  })

  test(`--${name} is boolean true when followed by another flag`, () => {
    const { flags } = parseArgs([`--${name}`, '--repo', '/tmp/x'])
    assert.equal(flags[name], true)
    assert.equal(flags.repo, '/tmp/x')
  })
}

test('value-taking flags still consume their value', () => {
  // The fix must not turn every flag into a boolean.
  const { _, flags } = parseArgs(['logs', '--tail', '50', '--repo', '/tmp/x', '--env', '.env.prod', 'server'])
  assert.equal(flags.tail, '50')
  assert.equal(flags.repo, '/tmp/x')
  assert.equal(flags.env, '.env.prod')
  assert.deepEqual(_, ['logs', 'server'])
})

test('value-taking url/server-key/timeout flags still consume their value', () => {
  const { flags } = parseArgs(['health', '--url', 'http://h:3001', '--server-key', 'k', '--timeout', '250'])
  assert.equal(flags.url, 'http://h:3001')
  assert.equal(flags['server-key'], 'k')
  assert.equal(flags.timeout, '250')
})

test('a boolean flag and a value flag mix without stealing each others tokens', () => {
  const { _, flags } = parseArgs(['up', '--build', 'server', '--repo', '/tmp/x'])
  assert.equal(flags.build, true)
  assert.equal(flags.repo, '/tmp/x')
  assert.deepEqual(_, ['up', 'server'])
})

test('parseArgs maps -h to help', () => {
  assert.equal(parseArgs(['-h']).flags.help, true)
  assert.equal(parseArgs(['status', '-h']).flags.help, true)
})

test('parseArgs lets a later occurrence win', () => {
  assert.equal(parseArgs(['--tail', '10', '--tail', '50']).flags.tail, '50')
})

test('flagStr returns undefined for boolean flags', () => {
  assert.equal(flagStr(parseArgs(['--repo']).flags, 'repo'), undefined)
})

test('flagStr returns undefined for absent flags', () => {
  assert.equal(flagStr({}, 'repo'), undefined)
})
