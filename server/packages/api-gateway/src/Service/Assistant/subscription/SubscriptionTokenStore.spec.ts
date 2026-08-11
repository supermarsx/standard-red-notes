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

async function writeHistoricalRecordMap(
  filePath: string,
  key: string,
  records: Record<string, SubscriptionTokenRecord>,
): Promise<void> {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
  const plaintext = Buffer.from(
    JSON.stringify({ records, pendingPairings: Object.create(null), pairingClaims: Object.create(null) }),
    'utf8',
  )
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  await fs.writeFile(
    filePath,
    JSON.stringify({
      v: 1,
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: data.toString('hex'),
    }),
    'utf8',
  )
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
    expect(() => new SubscriptionTokenStore(filePath, 'too-short')).toThrow(/32 bytes/)
    await expect(fs.readFile(filePath, 'utf8')).rejects.toThrow(/ENOENT/)
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
      expect(await wrongKeyStore.getStatus()).toEqual({
        paired: false,
        needsRepair: true,
        storeUnreadable: true,
      })
      await expect(wrongKeyStore.listStatuses()).rejects.toThrow(/Could not decrypt/)
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

    it('fails closed when targeted removal sees a wrong key and preserves every byte', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      await store.saveRecord('one', sampleRecord({ accessToken: 'one-secret' }))
      await store.saveRecord('two', sampleRecord({ accessToken: 'two-secret' }))
      const before = await fs.readFile(filePath)

      await expect(new SubscriptionTokenStore(filePath, keyHex()).removeRecord('one')).rejects.toThrow(
        /Could not decrypt/,
      )
      expect(await fs.readFile(filePath)).toEqual(before)
      expect(Object.keys(await store.loadAll()).sort()).toEqual(['one', 'two'])
    })

    it('fails closed when targeted removal sees authenticated-data tampering and preserves the file', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      await store.saveRecord('one', sampleRecord())
      const envelope = JSON.parse(await fs.readFile(filePath, 'utf8')) as { data: string }
      envelope.data = `${envelope.data[0] === '0' ? '1' : '0'}${envelope.data.slice(1)}`
      await fs.writeFile(filePath, JSON.stringify(envelope), 'utf8')
      const before = await fs.readFile(filePath)

      await expect(store.removeRecord('one')).rejects.toThrow(/Could not decrypt/)
      expect(await fs.readFile(filePath)).toEqual(before)
    })

    it('compare-and-swaps every persisted field and rejects a stale metadata version', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      const original = sampleRecord({ accountLabel: 'first@example.test' })
      await store.saveRecord('one', original)
      const changed = { ...original, accountLabel: 'new@example.test', refreshFailureCode: 'network' as const }
      expect(await store.replaceRecordIfUnchanged('one', original, changed)).toBe(true)

      expect(
        await store.replaceRecordIfUnchanged(
          'one',
          { ...original, accountLabel: 'stale@example.test' },
          { ...original, accessToken: 'should-not-win' },
        ),
      ).toBe(false)
      expect(await store.loadRecord('one')).toEqual(changed)
    })

    it('lists a historical invalid id as unusable and supports only its explicit legacy-removal path', async () => {
      const store = new SubscriptionTokenStore(filePath, key)
      await writeHistoricalRecordMap(filePath, key, {
        'legacy/team': sampleRecord({ accessToken: 'legacy-inaccessible-secret' }),
      })

      expect(await store.listStatuses()).toEqual([
        expect.objectContaining({ id: 'legacy/team', paired: true, legacyInvalidId: true }),
      ])
      expect(await store.loadRecord('legacy/team')).toBeNull()
      await expect(store.removeRecord('legacy/team')).rejects.toThrow(/invalid id/)
      await expect(store.removeLegacyRecord('default')).rejects.toThrow(/legacy-invalid/)

      await store.removeLegacyRecord('legacy/team')
      expect(await store.listStatuses()).toEqual([])
      await expect(store.removeLegacyRecord('legacy/team')).rejects.toThrow(/no longer exists/)
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

  it('rejects control-bearing token and account-id fields before persistence', async () => {
    const store = new SubscriptionTokenStore(filePath, key)
    await expect(store.save(sampleRecord({ accessToken: 'token\r\nInjected: yes' }))).rejects.toThrow(/invalid/)
    await expect(store.save(sampleRecord({ accountId: 'acct\nInjected' }))).rejects.toThrow(/invalid/)
    await expect(fs.readFile(filePath, 'utf8')).rejects.toThrow(/ENOENT/)
  })
})
