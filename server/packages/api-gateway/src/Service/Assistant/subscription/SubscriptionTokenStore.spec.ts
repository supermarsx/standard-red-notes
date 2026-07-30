import * as crypto from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { SubscriptionTokenRecord, SubscriptionTokenStore } from './SubscriptionTokenStore'

function keyHex(): string {
  return crypto.randomBytes(32).toString('hex')
}

function sampleRecord(overrides: Partial<SubscriptionTokenRecord> = {}): SubscriptionTokenRecord {
  return {
    accessToken: 'access-secret-token',
    refreshToken: 'refresh-secret-token',
    idToken: 'id.token.jwt',
    expiresAt: Date.now() + 3600 * 1000,
    accountId: 'acct-123',
    accountLabel: 'user@example.test',
    pairedAt: Date.now(),
    ...overrides,
  }
}

describe('SubscriptionTokenStore', () => {
  let dir: string
  let filePath: string
  const key = keyHex()

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subscription-store-'))
    filePath = path.join(dir, 'assistant-subscription.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trips a record through encrypt + decrypt', async () => {
    const store = new SubscriptionTokenStore(filePath, key)
    const record = sampleRecord()
    await store.save(record)

    const loaded = await store.load()
    expect(loaded).toEqual(record)
  })

  it('returns null when nothing is stored', async () => {
    const store = new SubscriptionTokenStore(filePath, key)
    expect(await store.load()).toBeNull()
  })

  it('never writes the token material in plaintext', async () => {
    const store = new SubscriptionTokenStore(filePath, key)
    await store.save(sampleRecord())

    const raw = await fs.readFile(filePath, 'utf8')
    expect(raw).not.toContain('access-secret-token')
    expect(raw).not.toContain('refresh-secret-token')
    // Only the encrypted envelope fields are on disk.
    const parsed = JSON.parse(raw)
    expect(parsed).toMatchObject({ v: 1, iv: expect.any(String), tag: expect.any(String), data: expect.any(String) })
  })

  it('fails closed when saving without an encryption key (nothing persisted)', async () => {
    const store = new SubscriptionTokenStore(filePath, undefined)
    await expect(store.save(sampleRecord())).rejects.toThrow(/ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY/)
    await expect(fs.readFile(filePath, 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('rejects a malformed (non 32-byte hex) key', async () => {
    const store = new SubscriptionTokenStore(filePath, 'too-short')
    await expect(store.save(sampleRecord())).rejects.toThrow(/32 bytes/)
  })

  it('fails closed on load with the wrong key (does not return the record)', async () => {
    await new SubscriptionTokenStore(filePath, key).save(sampleRecord())

    const wrongKeyStore = new SubscriptionTokenStore(filePath, keyHex())
    await expect(wrongKeyStore.load()).rejects.toThrow(/Could not decrypt/)
  })

  it('clears the stored credential', async () => {
    const store = new SubscriptionTokenStore(filePath, key)
    await store.save(sampleRecord())
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('clear is a no-op when nothing is stored', async () => {
    const store = new SubscriptionTokenStore(filePath, key)
    await expect(store.clear()).resolves.toBeUndefined()
  })

  describe('getStatus', () => {
    it('reports unpaired when empty', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      expect(await store.getStatus()).toEqual({ paired: false })
    })

    it('reports paired metadata without any token', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      const record = sampleRecord()
      await store.save(record)

      const status = await store.getStatus()
      expect(status.paired).toBe(true)
      expect(status.accountId).toBe('acct-123')
      expect(status.accountLabel).toBe('user@example.test')
      expect(status.expiresAt).toBe(record.expiresAt)
      expect(JSON.stringify(status)).not.toContain('access-secret-token')
    })

    it('reports needsRepair when the store cannot be decrypted', async () => {
      await new SubscriptionTokenStore(filePath, key).save(sampleRecord())
      const wrongKeyStore = new SubscriptionTokenStore(filePath, keyHex())
      expect(await wrongKeyStore.getStatus()).toEqual({ paired: true, needsRepair: true })
    })

    it('surfaces a persisted needsRepair flag', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      await store.save(sampleRecord({ needsRepair: true }))
      expect((await store.getStatus()).needsRepair).toBe(true)
    })
  })

  // Standard Red Notes: MULTIPLE paired subscriptions keyed by id.
  describe('multiple subscriptions (id-keyed)', () => {
    it('stores, lists, and removes independent pairings', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      await store.saveRecord('team-a', sampleRecord({ accountLabel: 'a@team.test' }))
      await store.saveRecord('team-b', sampleRecord({ accountLabel: 'b@team.test' }))

      const statuses = await store.listStatuses()
      expect(statuses.map((s) => s.id).sort()).toEqual(['team-a', 'team-b'])
      expect(statuses.every((s) => s.paired)).toBe(true)

      expect((await store.loadRecord('team-a'))?.accountLabel).toBe('a@team.test')
      expect((await store.loadRecord('team-b'))?.accountLabel).toBe('b@team.test')

      // Removing one leaves the other intact.
      await store.removeRecord('team-a')
      expect(await store.loadRecord('team-a')).toBeNull()
      expect((await store.loadRecord('team-b'))?.accountLabel).toBe('b@team.test')
      expect((await store.listStatuses()).map((s) => s.id)).toEqual(['team-b'])

      // Removing the last deletes the store entirely.
      await store.removeRecord('team-b')
      expect(await store.listStatuses()).toEqual([])
    })

    it('adding a second pairing never drops the first (no plaintext on disk)', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      await store.saveRecord('one', sampleRecord())
      await store.saveRecord('two', sampleRecord())
      const raw = await fs.readFile(filePath, 'utf8')
      expect(raw).not.toContain('access-secret-token')
      expect(Object.keys(await store.loadAll()).sort()).toEqual(['one', 'two'])
    })

    it('does not lose encrypted records saved by separate store instances', async () => {
      const first = new SubscriptionTokenStore(filePath, key)
      const second = new SubscriptionTokenStore(filePath, key)

      await Promise.all([
        first.saveRecord('one', sampleRecord({ accountLabel: 'one@team.test' })),
        second.saveRecord('two', sampleRecord({ accountLabel: 'two@team.test' })),
      ])

      const all = await first.loadAll()
      expect(Object.keys(all).sort()).toEqual(['one', 'two'])
      expect(all.one.accountLabel).toBe('one@team.test')
      expect(all.two.accountLabel).toBe('two@team.test')
    })

    it('migrates a legacy bare-record file into the default id', async () => {
      // A legacy single-record store written via save().
      const legacy = new SubscriptionTokenStore(filePath, key)
      await legacy.save(sampleRecord({ accountLabel: 'legacy@team.test' }))

      const store = new SubscriptionTokenStore(filePath, key)
      const all = await store.loadAll()
      expect(Object.keys(all)).toEqual(['default'])
      expect((await store.loadRecord('default'))?.accountLabel).toBe('legacy@team.test')
      // And it is listed with the default id.
      expect((await store.listStatuses())[0].id).toBe('default')
    })
  })
})
