import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { CaldavTokenStore } from './CaldavTokenStore'

describe('CaldavTokenStore', () => {
  let dir: string
  let store: CaldavTokenStore

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caldav-tokens-'))
    store = new CaldavTokenStore(path.join(dir, 'tokens.json'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  describe('create', () => {
    it('returns a uuid-prefixed plaintext token and read-only calendar scope', async () => {
      const created = await store.create(userA, 'Apple Calendar')
      expect(created.scope).toBe('calendar-read')
      expect(created.label).toBe('Apple Calendar')
      expect(created.token).toContain('.')
      expect(created.token.startsWith(`${created.uuid}.`)).toBe(true)
    })

    it('rejects an empty label', async () => {
      await expect(store.create(userA, '   ')).rejects.toThrow(/label is required/i)
    })

    it('does not persist the plaintext secret', async () => {
      const created = await store.create(userA, 'Thunderbird')
      const raw = await fs.readFile(path.join(dir, 'tokens.json'), 'utf8')
      const secret = created.token.split('.')[1]
      expect(raw).not.toContain(secret)
    })
  })

  describe('verify', () => {
    it('verifies a correct token and returns its metadata', async () => {
      const created = await store.create(userA, 'DAVx5')
      const verified = await store.verify(created.token)
      expect(verified).not.toBeNull()
      expect(verified?.userUuid).toBe(userA)
      expect(verified?.uuid).toBe(created.uuid)
      expect(verified?.scope).toBe('calendar-read')
    })

    it('updates lastUsedAt on a successful verify', async () => {
      const created = await store.create(userA, 'DAVx5')
      await store.verify(created.token)
      const [meta] = await store.listForUser(userA)
      expect(meta.lastUsedAt).not.toBeNull()
    })

    it('fails closed for a wrong secret', async () => {
      const created = await store.create(userA, 'DAVx5')
      const tampered = `${created.uuid}.not-the-real-secret`
      expect(await store.verify(tampered)).toBeNull()
    })

    it('fails closed for an unknown uuid', async () => {
      expect(await store.verify('00000000-0000-0000-0000-000000000000.whatever')).toBeNull()
    })

    it.each(['', 'no-separator', '.leading', 'trailing.', 'x'])(
      'fails closed for malformed token %p',
      async (malformed) => {
        expect(await store.verify(malformed)).toBeNull()
      },
    )

    it('rejects a token after it has been revoked', async () => {
      const created = await store.create(userA, 'DAVx5')
      await store.revoke(userA, created.uuid)
      expect(await store.verify(created.token)).toBeNull()
    })
  })

  describe('listForUser', () => {
    it('returns only the requesting user tokens, newest first', async () => {
      const a1 = await store.create(userA, 'a1')
      const a2 = await store.create(userA, 'a2')
      await store.create(userB, 'b1')

      const list = await store.listForUser(userA)
      expect(list.map((t) => t.uuid).sort()).toEqual([a1.uuid, a2.uuid].sort())
      // No secret material is exposed in metadata.
      expect(JSON.stringify(list)).not.toContain(a1.token.split('.')[1])
    })
  })

  describe('revoke', () => {
    it('only revokes a token that belongs to the user', async () => {
      const created = await store.create(userA, 'a1')
      expect(await store.revoke(userB, created.uuid)).toBe(false)
      expect(await store.revoke(userA, created.uuid)).toBe(true)
      expect(await store.revoke(userA, created.uuid)).toBe(false)
    })
  })
})
