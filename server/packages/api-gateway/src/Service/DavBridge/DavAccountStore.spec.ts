import { promises as fs } from 'fs'
import * as path from 'path'

import {
  DAV_ACCOUNT_LIMITS,
  DavAccountLimitError,
  DavAccountStore,
  DavAccountStoreError,
  PersistedDavAccount,
} from './DavAccountStore'
import { DavSecretCipher } from './DavSecretCipher'
import { SecretString } from './SecretString'
import { newUserUuid, removeDirectory, temporaryDirectory, TEST_SERVER_KEY } from './DavBridgeTestKit.spec'

/**
 * Against the REAL file store, in a temporary directory. An in-memory stand-in
 * would upsert where this inserts and would have no file to leave behind, which
 * are the two things worth testing here.
 */
describe('DavAccountStore', () => {
  const cipher = new DavSecretCipher(TEST_SERVER_KEY)
  let dataPath: string
  let store: DavAccountStore

  const account = (
    userUuid: string,
    id: string,
    overrides: Partial<PersistedDavAccount> = {},
  ): PersistedDavAccount => ({
    id,
    kind: 'nextcloud',
    origin: 'https://cloud.example.org',
    entryPath: '/',
    username: 'alice',
    credentialKind: 'basic',
    secret: cipher.seal(new SecretString('app-password'), userUuid, id),
    secretSetAt: 1_000,
    secretState: 'unverified',
    pin: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  })

  const id = (n: number): string => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`

  const accountsDirectory = (): string => path.join(dataPath, 'accounts')
  const entries = async (): Promise<string[]> => {
    try {
      return (await fs.readdir(accountsDirectory())).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  beforeEach(async () => {
    dataPath = await temporaryDirectory('store')
    store = new DavAccountStore(dataPath)
  })

  afterEach(async () => {
    await removeDirectory(dataPath)
  })

  it('creates nothing on disk until there is something to store', async () => {
    const user = newUserUuid()

    expect(await store.list(user)).toEqual([])
    expect(await store.get(user, id(1))).toBeNull()
    expect(await entries()).toEqual([])
  })

  it('keeps one file per user, named by the user and holding only that user', async () => {
    const alice = newUserUuid()
    const bob = newUserUuid()
    await store.create(alice, 5, () => account(alice, id(1)))
    await store.create(bob, 5, () => account(bob, id(2), { username: 'bob' }))

    expect((await entries()).filter((name) => name.endsWith('.json'))).toEqual([`${alice}.json`, `${bob}.json`].sort())
    expect((await store.list(alice)).map((entry) => entry.username)).toEqual(['alice'])
    expect((await store.list(bob)).map((entry) => entry.username)).toEqual(['bob'])

    const aliceFile = await fs.readFile(path.join(accountsDirectory(), `${alice}.json`), 'utf8')
    expect(aliceFile).toContain(alice)
    expect(aliceFile).not.toContain(bob)
    expect(aliceFile).not.toContain('"bob"')
  })

  it("never returns one user's account for another user's id lookup", async () => {
    const alice = newUserUuid()
    const bob = newUserUuid()
    await store.create(alice, 5, () => account(alice, id(1)))

    expect(await store.get(bob, id(1))).toBeNull()
    expect(await store.update(bob, id(1), (existing) => ({ ...existing, username: 'stolen' }))).toBeNull()
    expect(await store.remove(bob, id(1))).toBe(false)
    expect((await store.get(alice, id(1)))?.username).toBe('alice')
  })

  it('writes the file owner-only on a platform that has modes', async () => {
    const user = newUserUuid()
    await store.create(user, 5, () => account(user, id(1)))
    const stats = await fs.stat(path.join(accountsDirectory(), `${user}.json`))

    if (process.platform !== 'win32') {
      expect(stats.mode & 0o777).toBe(0o600)
    }
    expect(stats.isFile()).toBe(true)
  })

  it('refuses to pass the account limit, deciding inside the lock', async () => {
    const user = newUserUuid()
    const attempts = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6, 7].map((n) => store.create(user, 3, () => account(user, id(n)))),
    )

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(3)
    const refused = attempts.filter((attempt) => attempt.status === 'rejected') as PromiseRejectedResult[]
    expect(refused).toHaveLength(4)
    for (const attempt of refused) {
      expect(attempt.reason).toBeInstanceOf(DavAccountLimitError)
      expect((attempt.reason as DavAccountLimitError).limit).toBe(3)
    }
    expect(await store.list(user)).toHaveLength(3)
  })

  it('never stores more than the hard ceiling, whatever limit it is handed', async () => {
    const user = newUserUuid()
    for (let n = 1; n <= DAV_ACCOUNT_LIMITS.accountsPerUserMaximum; n++) {
      await store.create(user, 1_000, () => account(user, id(n)))
    }

    await expect(store.create(user, 1_000, () => account(user, id(99)))).rejects.toBeInstanceOf(DavAccountLimitError)
    expect(await store.list(user)).toHaveLength(DAV_ACCOUNT_LIMITS.accountsPerUserMaximum)
  })

  it('updates one account and leaves the others byte-identical', async () => {
    const user = newUserUuid()
    await store.create(user, 5, () => account(user, id(1)))
    await store.create(user, 5, () => account(user, id(2), { username: 'second' }))
    const before = await store.get(user, id(2))

    const updated = await store.update(user, id(1), (existing) => ({ ...existing, secretState: 'rejected' }))

    expect(updated?.secretState).toBe('rejected')
    expect((await store.get(user, id(1)))?.secretState).toBe('rejected')
    expect(await store.get(user, id(2))).toEqual(before)
  })

  it('does not write when a change returns the account it was given', async () => {
    const user = newUserUuid()
    await store.create(user, 5, () => account(user, id(1)))
    const file = path.join(accountsDirectory(), `${user}.json`)
    const before = await fs.stat(file)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const result = await store.update(user, id(1), (existing) => existing)

    expect(result?.id).toBe(id(1))
    const after = await fs.stat(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
  })

  it('removes one account, and the whole file with its lock directory when it was the last', async () => {
    const user = newUserUuid()
    await store.create(user, 5, () => account(user, id(1)))
    await store.create(user, 5, () => account(user, id(2)))

    expect(await store.remove(user, id(1))).toBe(true)
    expect((await store.list(user)).map((entry) => entry.id)).toEqual([id(2)])
    expect(await entries()).toContain(`${user}.json`)

    expect(await store.remove(user, id(2))).toBe(true)
    // Nothing that names the user is left behind.
    expect((await entries()).filter((name) => name.includes(user))).toEqual([])
    expect(await store.remove(user, id(2))).toBe(false)
  })

  it('removes everything for a user and reports how much there was', async () => {
    const alice = newUserUuid()
    const bob = newUserUuid()
    await store.create(alice, 5, () => account(alice, id(1)))
    await store.create(alice, 5, () => account(alice, id(2)))
    await store.create(bob, 5, () => account(bob, id(3)))
    // The positive control: the file is there before, so its absence after means something.
    expect(await entries()).toContain(`${alice}.json`)

    expect(await store.removeAllForUser(alice)).toBe(2)

    expect((await entries()).filter((name) => name.includes(alice))).toEqual([])
    expect(await store.list(alice)).toEqual([])
    expect(await store.list(bob)).toHaveLength(1)
    expect(await store.removeAllForUser(alice)).toBe(0)
    expect((await entries()).filter((name) => name.includes(alice))).toEqual([])
  })

  it('can still remove a file it can no longer read', async () => {
    const user = newUserUuid()
    await store.create(user, 5, () => account(user, id(1)))
    await fs.writeFile(path.join(accountsDirectory(), `${user}.json`), '{ not json', 'utf8')

    await expect(store.list(user)).rejects.toBeInstanceOf(DavAccountStoreError)
    expect(await store.removeAllForUser(user)).toBe(1)
    expect((await entries()).filter((name) => name.includes(user))).toEqual([])
  })

  it('lists the users that have a file, and only things that are user files', async () => {
    const alice = newUserUuid()
    const bob = newUserUuid()
    await store.create(alice, 5, () => account(alice, id(1)))
    await store.create(bob, 5, () => account(bob, id(2)))
    await fs.writeFile(path.join(accountsDirectory(), 'notes.txt'), 'x')
    await fs.writeFile(path.join(accountsDirectory(), 'not-a-uuid.json'), '{}')

    expect(await store.listUserUuids()).toEqual([alice, bob].sort())
    expect(await new DavAccountStore(path.join(dataPath, 'nowhere')).listUserUuids()).toEqual([])
  })

  describe('what it refuses to read', () => {
    it.each([
      ['malformed JSON', '{'],
      ['a different version', JSON.stringify({ v: 2, userUuid: 'x', accounts: [] })],
      ['an unknown top-level key', JSON.stringify({ v: 1, userUuid: 'USER', accounts: [], extra: true })],
      ['accounts that are not a list', JSON.stringify({ v: 1, userUuid: 'USER', accounts: {} })],
    ])('%s', async (_label, content) => {
      const user = newUserUuid()
      await fs.mkdir(accountsDirectory(), { recursive: true })
      await fs.writeFile(path.join(accountsDirectory(), `${user}.json`), content.replace('USER', user), 'utf8')

      await expect(store.list(user)).rejects.toMatchObject({ name: 'DavAccountStoreError', reason: 'unreadable' })
    })

    it('an account with a field it does not know, such as a plaintext password', async () => {
      const user = newUserUuid()
      await fs.mkdir(accountsDirectory(), { recursive: true })
      await fs.writeFile(
        path.join(accountsDirectory(), `${user}.json`),
        JSON.stringify({ v: 1, userUuid: user, accounts: [{ ...account(user, id(1)), password: 'in the clear' }] }),
        'utf8',
      )

      await expect(store.list(user)).rejects.toBeInstanceOf(DavAccountStoreError)
    })

    it('an account whose secret is not an envelope', async () => {
      const user = newUserUuid()
      await fs.mkdir(accountsDirectory(), { recursive: true })
      await fs.writeFile(
        path.join(accountsDirectory(), `${user}.json`),
        JSON.stringify({ v: 1, userUuid: user, accounts: [{ ...account(user, id(1)), secret: 'in the clear' }] }),
        'utf8',
      )

      await expect(store.list(user)).rejects.toBeInstanceOf(DavAccountStoreError)
    })

    it("a file that names another user inside: copying a file onto someone else's path hands nothing over", async () => {
      const alice = newUserUuid()
      const bob = newUserUuid()
      await store.create(alice, 5, () => account(alice, id(1)))
      await fs.copyFile(path.join(accountsDirectory(), `${alice}.json`), path.join(accountsDirectory(), `${bob}.json`))

      await expect(store.list(bob)).rejects.toMatchObject({ reason: 'unreadable' })
      await expect(store.get(bob, id(1))).rejects.toBeInstanceOf(DavAccountStoreError)
      await expect(store.create(bob, 5, () => account(bob, id(2)))).rejects.toBeInstanceOf(DavAccountStoreError)
      expect(await store.list(alice)).toHaveLength(1)
    })

    it('a file larger than the per-user ceiling', async () => {
      const user = newUserUuid()
      await fs.mkdir(accountsDirectory(), { recursive: true })
      await fs.writeFile(
        path.join(accountsDirectory(), `${user}.json`),
        JSON.stringify({ v: 1, userUuid: user, accounts: [], pad: 'x'.repeat(DAV_ACCOUNT_LIMITS.fileBytes) }),
        'utf8',
      )

      await expect(store.list(user)).rejects.toBeInstanceOf(DavAccountStoreError)
    })
  })

  describe('the user id becomes a file name, so only one shape of id is accepted', () => {
    it.each([
      '',
      '..',
      '../../etc/passwd',
      '..\\..\\windows\\win.ini',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../x',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa',
      'gggggggg-gggg-4ggg-8ggg-gggggggggggg',
      'aaaaaaaa_aaaa_4aaa_8aaa_aaaaaaaaaaaa',
      ' aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\u0000',
    ])('refuses %p everywhere and touches no file', async (userUuid) => {
      for (const action of [
        () => store.list(userUuid),
        () => store.get(userUuid, id(1)),
        () => store.create(userUuid, 5, () => account('11111111-1111-4111-8111-111111111111', id(1))),
        () => store.update(userUuid, id(1), (existing) => existing),
        () => store.remove(userUuid, id(1)),
        () => store.removeAllForUser(userUuid),
      ]) {
        await expect(action()).rejects.toMatchObject({ name: 'DavAccountStoreError', reason: 'invalid-user' })
      }
      expect(await entries()).toEqual([])
      expect(await fs.readdir(dataPath)).toEqual([])
    })

    it('treats an upper-case spelling of a user id as the same user', async () => {
      const user = newUserUuid()
      await store.create(user.toUpperCase(), 5, () => account(user, id(1)))

      expect(await store.list(user)).toHaveLength(1)
      expect((await entries()).filter((name) => name.endsWith('.json'))).toEqual([`${user}.json`])
    })
  })

  it('treats an account id that is not an id as not found, without reading', async () => {
    const user = newUserUuid()
    await store.create(user, 5, () => account(user, id(1)))

    for (const accountId of ['', '../x', 'not-an-id', `${id(1)} `]) {
      expect(await store.get(user, accountId)).toBeNull()
      expect(await store.update(user, accountId, (existing) => existing)).toBeNull()
      expect(await store.remove(user, accountId)).toBe(false)
    }
    expect(await store.list(user)).toHaveLength(1)
  })

  it('does not name the user or the path in its errors', async () => {
    const user = newUserUuid()
    await fs.mkdir(accountsDirectory(), { recursive: true })
    await fs.writeFile(path.join(accountsDirectory(), `${user}.json`), '{', 'utf8')
    let caught: unknown
    try {
      await store.list(user)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DavAccountStoreError)
    const rendered = `${String(caught)} ${JSON.stringify(caught)}`
    expect(rendered).not.toContain(user)
    expect(rendered).not.toContain(dataPath)
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined()
  })
})
