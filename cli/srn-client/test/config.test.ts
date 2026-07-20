import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearActiveProfile,
  dataDirFor,
  getActiveProfile,
  loadConfig,
  profileIdFor,
  saveConfig,
  setActiveProfile,
  srnHome,
} from '../src/config.ts'

// Every test runs against a throwaway $SRN_HOME so the developer's real ~/.srn
// keychain is never read, written or deleted.
const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-client-config-'))
let home: string

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(sandboxRoot, 'home-'))
  process.env.SRN_HOME = home
})

after(async () => {
  delete process.env.SRN_HOME
  await fs.rm(sandboxRoot, { recursive: true, force: true })
})

test('srnHome honours $SRN_HOME', () => {
  assert.equal(srnHome(), home)
})

test('srnHome falls back to ~/.srn when $SRN_HOME is unset', () => {
  delete process.env.SRN_HOME
  try {
    assert.equal(srnHome(), path.join(os.homedir(), '.srn'))
  } finally {
    process.env.SRN_HOME = home
  }
})

test('dataDirFor nests the profile under <home>/data', () => {
  assert.equal(dataDirFor('abc'), path.join(home, 'data', 'abc'))
})

test('profileIdFor is deterministic, so re-login reuses the same keychain', () => {
  const a = profileIdFor('https://s.example', 'me@example.com')
  const b = profileIdFor('https://s.example', 'me@example.com')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)
})

test('profileIdFor ignores email case but not server URL', () => {
  assert.equal(profileIdFor('https://s.example', 'ME@Example.com'), profileIdFor('https://s.example', 'me@example.com'))
  assert.notEqual(profileIdFor('https://s.example', 'a@x.com'), profileIdFor('https://s.example', 'b@x.com'))
  assert.notEqual(profileIdFor('https://a.example', 'me@x.com'), profileIdFor('https://b.example', 'me@x.com'))
})

test('profileIdFor does not leak the email into the id', () => {
  const id = profileIdFor('https://s.example', 'secret-user@example.com')
  assert.ok(!id.includes('secret'), 'the profile id must be a digest, not the address')
})

test('loadConfig returns an empty config when nothing is stored', async () => {
  assert.deepEqual(await loadConfig(), { profiles: {} })
})

test('loadConfig tolerates a corrupt config.json instead of throwing', async () => {
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(path.join(home, 'config.json'), '{ not json')
  assert.deepEqual(await loadConfig(), { profiles: {} })
})

test('loadConfig backfills a missing profiles map', async () => {
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ activeProfile: 'x' }))
  const config = await loadConfig()
  assert.deepEqual(config.profiles, {})
  assert.equal(config.activeProfile, 'x')
})

test('saveConfig round-trips through loadConfig and creates $SRN_HOME', async () => {
  await saveConfig({ activeProfile: 'p1', profiles: { p1: { serverUrl: 'u', email: 'e', profileId: 'p1' } } })
  const config = await loadConfig()
  assert.equal(config.activeProfile, 'p1')
  assert.deepEqual(config.profiles.p1, { serverUrl: 'u', email: 'e', profileId: 'p1' })
})

test('setActiveProfile stores the profile, marks it active and creates its data dir', async () => {
  const profile = { serverUrl: 'https://s.example', email: 'me@example.com', profileId: 'pid1' }
  await setActiveProfile(profile)

  assert.deepEqual(await getActiveProfile(), profile)
  const stat = await fs.stat(dataDirFor('pid1'))
  assert.ok(stat.isDirectory(), 'the keychain data dir must exist before snjs writes keys')
})

test('setActiveProfile switches the active profile while retaining the previous one', async () => {
  const first = { serverUrl: 'https://a', email: 'a@x.com', profileId: 'p1' }
  const second = { serverUrl: 'https://b', email: 'b@x.com', profileId: 'p2' }
  await setActiveProfile(first)
  await setActiveProfile(second)

  const config = await loadConfig()
  assert.equal(config.activeProfile, 'p2')
  assert.deepEqual(Object.keys(config.profiles).sort(), ['p1', 'p2'])
})

test('getActiveProfile returns undefined when no profile is active', async () => {
  assert.equal(await getActiveProfile(), undefined)
  await saveConfig({ profiles: { p1: { serverUrl: 'u', email: 'e', profileId: 'p1' } } })
  assert.equal(await getActiveProfile(), undefined, 'a stored profile is not active until pointed at')
})

test('config.json is written 0600 and $SRN_HOME 0700 on POSIX', { skip: process.platform === 'win32' }, async () => {
  await setActiveProfile({ serverUrl: 'u', email: 'e', profileId: 'pid' })
  assert.equal((await fs.stat(path.join(home, 'config.json'))).mode & 0o777, 0o600)
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(dataDirFor('pid'))).mode & 0o777, 0o700)
})

test('clearActiveProfile deletes the session AND the keychain directory on disk', async () => {
  await setActiveProfile({ serverUrl: 'u', email: 'e', profileId: 'pid' })
  const dir = dataDirFor('pid')
  await fs.writeFile(path.join(dir, 'keychain.json'), '{"rootKey":"pretend-key-material"}')

  await clearActiveProfile()

  const config = await loadConfig()
  assert.equal(config.activeProfile, undefined)
  assert.deepEqual(config.profiles, {}, 'logout must forget the profile, not just deactivate it')
  await assert.rejects(fs.stat(dir), /ENOENT/, 'logout must remove the on-disk keychain')
})

test('clearActiveProfile leaves other profiles alone', async () => {
  await setActiveProfile({ serverUrl: 'https://a', email: 'a@x.com', profileId: 'p1' })
  await setActiveProfile({ serverUrl: 'https://b', email: 'b@x.com', profileId: 'p2' })

  await clearActiveProfile()

  const config = await loadConfig()
  assert.deepEqual(Object.keys(config.profiles), ['p1'])
  await fs.stat(dataDirFor('p1'))
})

test('clearActiveProfile is a no-op when nothing is active', async () => {
  await clearActiveProfile()
  assert.deepEqual(await loadConfig(), { profiles: {} })
})

test('a stored profile never contains the account password', async () => {
  await setActiveProfile({ serverUrl: 'https://s', email: 'e@x.com', profileId: 'pid', serverKey: 'gate-key' })
  const raw = await fs.readFile(path.join(home, 'config.json'), 'utf8')
  const parsed = JSON.parse(raw)
  assert.deepEqual(Object.keys(parsed.profiles.pid).sort(), ['email', 'profileId', 'serverKey', 'serverUrl'])
})
