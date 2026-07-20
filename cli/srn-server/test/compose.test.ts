import { test } from 'node:test'
import assert from 'node:assert/strict'

import { composeDownArgs, composeLogsArgs, composeUpArgs, parseArgs } from '../src/cli.ts'

const logs = (argv: string[]) => composeLogsArgs(parseArgs(argv))
const up = (argv: string[]) => composeUpArgs(parseArgs(argv))
const down = (argv: string[]) => composeDownArgs(parseArgs(argv))

test('logs with no options', () => {
  assert.deepEqual(logs([]), ['compose', 'logs'])
})

test('logs appends the service name last, after the option flags', () => {
  assert.deepEqual(logs(['server', '--tail', '100']), ['compose', 'logs', '--tail', '100', 'server'])
})

test('logs maps both --follow and -f to -f, once', () => {
  assert.deepEqual(logs(['--follow']), ['compose', 'logs', '-f'])
  assert.deepEqual(logs(['-f']), ['compose', 'logs', '-f'])
  assert.deepEqual(logs(['--follow', '-f']), ['compose', 'logs', '-f'], '-f must not be duplicated')
})

test('logs keeps the service when -f is given before it', () => {
  // Regression: `-f` used to land in the positionals, so it became the service
  // name and the real service was dropped.
  assert.deepEqual(logs(['-f', 'server']), ['compose', 'logs', '-f', 'server'])
})

test('logs passes --tail as a separate argv entry, not "--tail=N"', () => {
  assert.deepEqual(logs(['--tail', '50']), ['compose', 'logs', '--tail', '50'])
  assert.deepEqual(logs(['--tail=50']), ['compose', 'logs', '--tail', '50'])
})

test('logs omits --tail when it is a bare boolean flag', () => {
  assert.deepEqual(logs(['--tail']), ['compose', 'logs'], 'a valueless --tail must not emit a dangling flag')
})

test('up is always detached', () => {
  assert.deepEqual(up([]), ['compose', 'up', '-d'])
  assert.ok(up(['--build', 'server']).includes('-d'), '-d must survive every option combination')
})

test('up adds --build only when asked, and keeps the service last', () => {
  assert.deepEqual(up(['--build']), ['compose', 'up', '-d', '--build'])
  assert.deepEqual(up(['server', '--build']), ['compose', 'up', '-d', '--build', 'server'])
  assert.deepEqual(up(['server']), ['compose', 'up', '-d', 'server'])
})

test('up keeps the service when --build is given BEFORE it', () => {
  // Regression: `--build` used to bind "server" as its value, so the service
  // vanished and `up --build server` rebuilt and started the ENTIRE stack.
  assert.deepEqual(up(['--build', 'server']), ['compose', 'up', '-d', '--build', 'server'])
})

test('logs keeps the service when --follow is given BEFORE it', () => {
  // Same class as above: `logs --follow server` used to tail every service.
  assert.deepEqual(logs(['--follow', 'server']), ['compose', 'logs', '-f', 'server'])
})

test('up ignores unrelated flags', () => {
  assert.deepEqual(up(['--repo', '/tmp/x']), ['compose', 'up', '-d'])
})

test('down never takes a service argument', () => {
  // `docker compose down <service>` is not the same operation; a stray positional
  // must not be forwarded.
  assert.deepEqual(down(['server']), ['compose', 'down'])
})

test('down omits --volumes unless explicitly requested', () => {
  assert.deepEqual(down(['--yes']), ['compose', 'down'])
  assert.ok(!down(['--yes']).includes('--volumes'), 'data volumes must never be removed implicitly')
})

test('down adds --volumes when requested', () => {
  assert.deepEqual(down(['--yes', '--volumes']), ['compose', 'down', '--volumes'])
})

test('argument builders return fresh arrays (no shared mutable state between calls)', () => {
  const a = up([])
  a.push('mutated')
  assert.deepEqual(up([]), ['compose', 'up', '-d'])
})
