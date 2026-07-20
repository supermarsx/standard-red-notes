/**
 * End-to-end tests for src/index.ts — the srn-client entry point.
 *
 * The real entry is executed as a child process (see harness.ts) against a
 * throwaway $SRN_HOME, so dispatch, every argument-validation path, the
 * not-logged-in guard on each command, and the import/export file handling are
 * exercised exactly as a user would hit them.
 *
 * NOT covered here, deliberately: the authenticated happy paths. They require a
 * live Standard Notes server and a real end-to-end-encrypted account; faking one
 * convincingly enough would leave the test asserting nothing about encryption.
 * Those are listed in the package README/report as untestable offline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { makeSandbox, runCli, writeFixture, type Sandbox } from './harness.ts'

const sandbox: Sandbox = makeSandbox()

/** Seed $SRN_HOME with an active profile, as a successful `login` would. */
function seedProfile(
  sb: Sandbox,
  profile: { serverUrl: string; email: string; profileId: string; serverKey?: string },
): void {
  mkdirSync(path.join(sb.home, 'data', profile.profileId), { recursive: true })
  writeFileSync(
    path.join(sb.home, 'config.json'),
    JSON.stringify({ activeProfile: profile.profileId, profiles: { [profile.profileId]: profile } }, null, 2),
  )
}

function clearProfile(sb: Sandbox): void {
  writeFileSync(path.join(sb.home, 'config.json'), JSON.stringify({ profiles: {} }))
}

// --- help / dispatch ---------------------------------------------------------

test('bare invocation prints HELP and exits 0', async () => {
  const r = await runCli(sandbox, [])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /srn-client 0\.1\.0 — manage a Standard Red Notes account/)
  assert.match(r.stdout, /NOTES ON SECURITY/)
  assert.equal(r.stderr, '')
})

test('`help`, --help and -h all print HELP and exit 0', async () => {
  for (const argv of [['help'], ['--help'], ['-h']]) {
    const r = await runCli(sandbox, argv)
    assert.equal(r.code, 0, `argv ${argv.join(' ')}`)
    assert.match(r.stdout, /USAGE\n {2}srn-client <command> \[options]/)
  }
})

test('--help short-circuits a real command instead of running it', async () => {
  const r = await runCli(sandbox, ['notes', '--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /USAGE/)
  assert.doesNotMatch(r.stderr, /Unknown notes subcommand/)
})

test('an unknown command reports it on stderr, prints HELP and exits 1', async () => {
  const r = await runCli(sandbox, ['frobnicate'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Unknown command: frobnicate\n/)
  assert.match(r.stderr, /USAGE/)
  assert.equal(r.stdout, '')
})

test('version prints only the CLI version and exits 0', async () => {
  const r = await runCli(sandbox, ['version'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'srn-client 0.1.0\n')
  assert.equal(r.stderr, '')
})

// --- login argument validation ----------------------------------------------

test('login without --server fails and names the env var alternative', async () => {
  const r = await runCli(sandbox, ['login'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Error: Missing --server <url> \(or set SRN_SERVER_URL\)\.\n$/)
})

test('login without --email fails after the server check', async () => {
  const r = await runCli(sandbox, ['login', '--server', 'http://127.0.0.1:1'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Error: Missing --email <email>\.\n$/)
})

test('login without a password fails and steers away from shell history', async () => {
  const r = await runCli(sandbox, ['login', '--server', 'http://127.0.0.1:1', '--email', 'a@b.c'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Missing --password <pw> \(or set SRN_PASSWORD/)
  assert.match(r.stderr, /avoid putting passwords in shell history/)
})

test('$SRN_SERVER_URL substitutes for --server', async () => {
  const r = await runCli(sandbox, ['login', '--email', 'a@b.c'], { env: { SRN_SERVER_URL: 'http://127.0.0.1:1' } })
  assert.equal(r.code, 1)
  // Got past the server check, so the URL was picked up from the environment.
  assert.match(r.stderr, /Missing --password/)
})

test('$SRN_PASSWORD substitutes for --password', async () => {
  const r = await runCli(sandbox, ['login', '--server', 'http://127.0.0.1:1', '--email', 'a@b.c'], {
    env: { SRN_PASSWORD: 'from-env' },
  })
  assert.equal(r.code, 1)
  // Past validation; it failed at the network instead.
  assert.doesNotMatch(r.stderr, /Missing --password/)
})

test('a failed login leaves NO keychain behind and never echoes the password', async () => {
  const r = await runCli(sandbox, [
    'login',
    '--server',
    'http://127.0.0.1:1',
    '--email',
    'nobody@example.com',
    '--password',
    'correct-horse-battery-staple',
  ])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Error: sign-in failed: /)
  assert.doesNotMatch(r.stdout + r.stderr, /correct-horse-battery-staple/)
  // A half-written keychain that masquerades as a valid session must not survive.
  const cfgPath = path.join(sandbox.home, 'config.json')
  let active: unknown
  try {
    active = (JSON.parse(readFileSync(cfgPath, 'utf8')) as { activeProfile?: string }).activeProfile
  } catch {
    active = undefined
  }
  assert.equal(active, undefined)
})

test('--register takes the account-creation branch, not sign-in', async () => {
  const r = await runCli(sandbox, [
    'login',
    '--register',
    '--server',
    'http://127.0.0.1:1',
    '--email',
    'nobody@example.com',
    '--password',
    'pw',
  ])
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.stderr, /sign-in failed/)
})

// --- logout / whoami ---------------------------------------------------------

test('logout with no session says so and exits 0', async () => {
  clearProfile(sandbox)
  const r = await runCli(sandbox, ['logout'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'No active session.\n')
})

test('logout clears the active profile and its on-disk data dir', async () => {
  seedProfile(sandbox, { serverUrl: 'http://127.0.0.1:1', email: 'me@example.com', profileId: 'deadbeef01' })
  const r = await runCli(sandbox, ['logout'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /^Logged out \(cleared local session for me@example\.com\)\.\n$/)
  const cfg = JSON.parse(readFileSync(path.join(sandbox.home, 'config.json'), 'utf8')) as {
    activeProfile?: string
    profiles: Record<string, unknown>
  }
  assert.equal(cfg.activeProfile, undefined)
  assert.deepEqual(Object.keys(cfg.profiles), [])
})

test('whoami with no session exits 1 without touching the network', async () => {
  clearProfile(sandbox)
  const r = await runCli(sandbox, ['whoami'])
  assert.equal(r.code, 1)
  assert.equal(r.stdout, 'Not logged in.\n')
})

test('whoami answers offline from the stored profile before confirming online', async () => {
  seedProfile(sandbox, { serverUrl: 'http://127.0.0.1:1', email: 'me@example.com', profileId: 'cafe0001' })
  const r = await runCli(sandbox, ['whoami'])
  // The offline answer is printed first, then the online confirmation fails.
  assert.match(r.stdout, /^email: {2}me@example\.com\nserver: http:\/\/127\.0\.0\.1:1\n/)
  assert.doesNotMatch(r.stdout, /session: valid/)
})

test('whoami reports that a gate key is configured WITHOUT printing it', async () => {
  seedProfile(sandbox, {
    serverUrl: 'http://127.0.0.1:1',
    email: 'me@example.com',
    profileId: 'cafe0002',
    serverKey: 'the-gate-key-value',
  })
  const r = await runCli(sandbox, ['whoami'])
  assert.match(r.stdout, /^server-key: configured \(X-Shared-Server-Key will be sent\)$/m)
  assert.doesNotMatch(r.stdout + r.stderr, /the-gate-key-value/)
})

// --- notes: validation and the not-logged-in guard ---------------------------

test('every notes subcommand refuses to run without a session', async () => {
  clearProfile(sandbox)
  for (const argv of [
    ['notes', 'list'],
    ['notes', 'get', 'some-uuid'],
    ['notes', 'create', '--title', 'T'],
    ['notes', 'update', 'some-uuid', '--title', 'T'],
    ['notes', 'delete', 'some-uuid'],
    ['export'],
  ]) {
    const r = await runCli(sandbox, argv)
    assert.equal(r.code, 1, argv.join(' '))
    assert.match(r.stderr, /Not logged in\. Run `srn-client login/, argv.join(' '))
  }
})

test('an unknown notes subcommand lists the valid ones', async () => {
  const r = await runCli(sandbox, ['notes', 'frobnicate'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Unknown notes subcommand: frobnicate\. Try: list, get, create, update, delete\./)
})

test('a bare `notes` reports "(none)" rather than crashing', async () => {
  const r = await runCli(sandbox, ['notes'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Unknown notes subcommand: \(none\)/)
})

test('notes get/update/delete without a uuid print their usage', async () => {
  const cases: [string[], RegExp][] = [
    [['notes', 'get'], /Usage: srn-client notes get <uuid>/],
    [['notes', 'update'], /Usage: srn-client notes update <uuid>/],
    [['notes', 'delete'], /Usage: srn-client notes delete <uuid>/],
  ]
  for (const [argv, expected] of cases) {
    const r = await runCli(sandbox, argv)
    assert.equal(r.code, 1, argv.join(' '))
    assert.match(r.stderr, expected)
  }
})

test('notes create without --title prints its usage', async () => {
  const r = await runCli(sandbox, ['notes', 'create'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Usage: srn-client notes create --title <t>/)
})

test('notes update with no field to change is rejected before any session work', async () => {
  clearProfile(sandbox)
  const r = await runCli(sandbox, ['notes', 'update', 'some-uuid'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Nothing to update\. Provide --title, --text, and\/or --tag\./)
  // The validation must come first: no "Not logged in" here.
  assert.doesNotMatch(r.stderr, /Not logged in/)
})

test('a leading --json still leaves the uuid as the delete target', async () => {
  // Regression guard: --json used to swallow the uuid, and with two positionals
  // it silently targeted the SECOND one.
  clearProfile(sandbox)
  const r = await runCli(sandbox, ['notes', 'delete', '--json', 'uuid-a'])
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.stderr, /Usage: srn-client notes delete/)
  assert.match(r.stderr, /Not logged in/)
})

test('a leading --json still leaves the notes SUBCOMMAND intact', async () => {
  const r = await runCli(sandbox, ['notes', '--json', 'frobnicate'])
  assert.match(r.stderr, /Unknown notes subcommand: frobnicate/)
})

// --- export ------------------------------------------------------------------

test('export rejects an unsupported --format before opening a session', async () => {
  const r = await runCli(sandbox, ['export', '--format', 'xml'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Error: --format must be json or md\n$/)
})

test('export accepts json and md case-insensitively', async () => {
  clearProfile(sandbox)
  for (const format of ['JSON', 'Md']) {
    const r = await runCli(sandbox, ['export', '--format', format])
    // Format accepted, so it proceeds as far as the session check.
    assert.match(r.stderr, /Not logged in/, format)
  }
})

// --- import ------------------------------------------------------------------

test('import without a file prints its usage', async () => {
  const r = await runCli(sandbox, ['import'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Usage: srn-client import <file\.json>/)
})

test('import of a missing file reports the path and the OS error', async () => {
  const missing = path.join(sandbox.dir, 'definitely-not-here.json')
  const r = await runCli(sandbox, ['import', missing])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Error: Cannot read /)
  assert.ok(r.stderr.includes('definitely-not-here.json'))
})

test('import of malformed JSON names the file and fails before any session work', async () => {
  const file = writeFixture(sandbox, 'broken.json', '{not json at all')
  const r = await runCli(sandbox, ['import', file])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Error: /)
  assert.doesNotMatch(r.stderr, /Not logged in/)
})

test('import of a non-array payload is rejected', async () => {
  const file = writeFixture(sandbox, 'object.json', '{"title":"a"}')
  const r = await runCli(sandbox, ['import', file])
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.stderr, /Not logged in/)
})

test('a well-formed import payload gets as far as the session check', async () => {
  clearProfile(sandbox)
  const file = writeFixture(sandbox, 'good.json', JSON.stringify([{ title: 'a', text: 'b', tags: ['x'] }]))
  const r = await runCli(sandbox, ['import', file])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Not logged in/)
})
