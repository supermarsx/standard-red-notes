import { promises as fs } from 'fs'
import * as path from 'path'

import { DavBridgeRefusal } from './DavBridgeRefusal'
import { DavAccountView, DavBridgeCaller } from './DavBridgeService'
import { DAV_RELAY_LIMITS } from './DavRelay'
import { DEFAULT_DAV_RELAY_LIMITS } from './DavRelayLimiter'
import { BridgeHarness, buildBridge, caller, newUserUuid } from './DavBridgeTestKit.spec'

const refusalFrom = async (action: Promise<unknown>): Promise<DavBridgeRefusal> => {
  try {
    await action
  } catch (error) {
    if (error instanceof DavBridgeRefusal) {
      return error
    }
    throw error
  }
  throw new Error('expected a refusal, and the call resolved')
}

const HOME = '/remote.php/dav/calendars/alice/'
const PRINCIPAL = '/remote.php/dav/principals/users/alice/'
const ORIGIN = 'https://cloud.example.org'

const accountInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'nextcloud',
  url: `${ORIGIN}/`,
  username: 'alice',
  secret: 'app-password',
  ...overrides,
})

describe('DavBridgeService', () => {
  let bridge: BridgeHarness
  let alice: DavBridgeCaller

  const start = async (options: Parameters<typeof buildBridge>[0] = {}): Promise<void> => {
    bridge = await buildBridge(options)
    alice = caller(newUserUuid())
  }

  const connect = async (
    as: DavBridgeCaller = alice,
    overrides: Record<string, unknown> = {},
  ): Promise<DavAccountView> => bridge.service.createAccount(as, accountInput(overrides))

  const connectAndPin = async (as: DavBridgeCaller = alice): Promise<DavAccountView> => {
    const account = await connect(as)
    return bridge.service.setPin(as, account.id, { principalPath: PRINCIPAL, calendarHomePath: HOME })
  }

  const propfind = (account: DavAccountView, as: DavBridgeCaller = alice, requestPath = HOME): Promise<unknown> =>
    bridge.service.relay(as, account.id, { method: 'PROPFIND', path: requestPath, headers: { depth: '1' } })

  afterEach(async () => {
    await bridge.close()
  })

  describe('gates', () => {
    it('is off by default: with nothing configured nobody can connect or relay, and no socket opens', async () => {
      await start({ env: { enabled: undefined } })

      expect(await bridge.service.config(alice)).toMatchObject({ enabled: false, allowed: true, available: false })
      expect((await refusalFrom(connect())).tag).toBe('dav-bridge-disabled')
      expect((await refusalFrom(bridge.service.relay(alice, newUserUuid(), {}))).tag).toBe('dav-bridge-disabled')
      expect(bridge.attempts).toHaveLength(0)
    })

    it('needs the per-user permission as well as the switch', async () => {
      await start()
      const unpermitted = caller(newUserUuid(), { permitted: false })

      expect(await bridge.service.config(unpermitted)).toMatchObject({
        enabled: true,
        allowed: false,
        available: false,
      })
      const refusal = await refusalFrom(connect(unpermitted))
      expect(refusal.tag).toBe('dav-bridge-not-allowed')
      expect(refusal.httpStatus).toBe(403)
    })

    it('lets the operator grant the permission to everyone', async () => {
      await start({ env: { enabled: true, allowAllUsers: true } })
      const unpermitted = caller(newUserUuid(), { permitted: false })

      expect(await bridge.service.config(unpermitted)).toMatchObject({ allowed: true, available: true })
      expect((await connect(unpermitted)).origin).toBe(ORIGIN)
    })

    it('reports the switch before the permission, so a disabled server says so to everyone', async () => {
      await start({ env: { enabled: false } })

      expect((await refusalFrom(connect(caller(newUserUuid(), { permitted: false })))).tag).toBe('dav-bridge-disabled')
    })

    it('works as a kill switch: an account that was relaying stops the moment the administrator switches off', async () => {
      await start()
      const account = await connectAndPin()
      await propfind(account)
      expect(bridge.attempts).toHaveLength(1)

      await bridge.service.adminUpdate({ enabled: false })

      expect((await refusalFrom(propfind(account))).tag).toBe('dav-bridge-disabled')
      expect(bridge.attempts).toHaveLength(1)
      // What the server holds is still visible and removable.
      expect(await bridge.service.listAccounts(alice)).toHaveLength(1)
      await bridge.service.deleteAccount(alice, account.id)
      expect(await bridge.service.listAccounts(alice)).toEqual([])
    })

    it('refuses to run in a mode this build does not implement', async () => {
      await start({ env: { enabled: true, mode: 'hub' } })

      const refusal = await refusalFrom(connect())
      expect(refusal.tag).toBe('dav-bridge-mode-unsupported')
      expect(refusal.httpStatus).toBe(503)
      expect(await bridge.service.config(alice)).toMatchObject({ enabled: true, mode: 'hub', available: false })
    })

    it('refuses, rather than guessing, when its settings cannot be read', async () => {
      await start()
      const account = await connectAndPin()
      await fs.writeFile(bridge.settingsPath, 'not json', 'utf8')

      expect((await refusalFrom(propfind(account))).tag).toBe('dav-settings-unavailable')
      expect((await refusalFrom(connect())).tag).toBe('dav-settings-unavailable')
      expect(await bridge.service.config(alice)).toMatchObject({ enabled: false, available: false })
      expect(bridge.attempts).toHaveLength(0)
    })

    it('reports its limits and that it does not write', async () => {
      await start()

      expect(await bridge.service.config(alice)).toEqual({
        enabled: true,
        allowed: true,
        available: true,
        mode: 'relay',
        writeEnabled: false,
        methods: ['OPTIONS', 'PROPFIND', 'REPORT', 'GET'],
        limits: {
          maxAccounts: 5,
          requestBodyBytes: 1048576,
          responseBodyBytes: 8388608,
          requestTimeoutMs: 30000,
          pathLength: 2048,
          discoveryWindowSeconds: 900,
          requestsPerTenMinutes: 600,
          writesPerMinute: 60,
          accountValidationsPerHour: 10,
        },
      })
    })
  })

  describe('sessions', () => {
    it('gives an automation token nothing: not the list, not the relay, not removal', async () => {
      await start()
      const account = await connectAndPin()
      const automation = { ...alice, mcpScoped: true }

      for (const action of [
        () => bridge.service.listAccounts(automation),
        () => bridge.service.createAccount(automation, accountInput()),
        () => bridge.service.replaceSecret(automation, account.id, { secret: 'x' }),
        () => bridge.service.setPin(automation, account.id, { principalPath: PRINCIPAL, calendarHomePath: HOME }),
        () => propfind(account, automation),
        () => bridge.service.deleteAccount(automation, account.id),
        () => bridge.service.deleteAllAccounts(automation),
      ]) {
        const refusal = await refusalFrom(action())
        expect(refusal.tag).toBe('dav-session-not-permitted')
        expect(refusal.logTag).toBe('mcp-scope')
      }
      expect(await bridge.service.config(automation)).toMatchObject({ allowed: false, available: false })
      expect(await bridge.service.listAccounts(alice)).toHaveLength(1)
      expect(bridge.attempts).toHaveLength(0)
    })

    it('lets a read-only session look and change nothing', async () => {
      await start()
      const account = await connectAndPin()
      const readOnly = { ...alice, readOnlySession: true }

      expect(await bridge.service.listAccounts(readOnly)).toHaveLength(1)
      for (const action of [
        () => bridge.service.createAccount(readOnly, accountInput()),
        () => bridge.service.replaceSecret(readOnly, account.id, { secret: 'x' }),
        () => bridge.service.setPin(readOnly, account.id, { principalPath: PRINCIPAL, calendarHomePath: HOME }),
        () => propfind(account, readOnly),
        () => bridge.service.deleteAccount(readOnly, account.id),
        () => bridge.service.deleteAllAccounts(readOnly),
      ]) {
        const refusal = await refusalFrom(action())
        expect(refusal.tag).toBe('dav-session-not-permitted')
        expect(refusal.logTag).toBe('read-only-session')
      }
      expect(await bridge.service.listAccounts(alice)).toHaveLength(1)
      expect(bridge.attempts).toHaveLength(0)
    })
  })

  describe('connecting an account', () => {
    it('returns a view with a fixed set of fields and makes no request to the remote', async () => {
      await start()

      const account = await connect(alice, { url: `${ORIGIN}/nextcloud/` })

      expect(Object.keys(account).sort()).toEqual(
        [
          'createdAt',
          'credentialKind',
          'discoveryOpenUntil',
          'entryPath',
          'id',
          'kind',
          'origin',
          'pin',
          'secretConfigured',
          'status',
          'updatedAt',
          'username',
        ].sort(),
      )
      expect(account).toMatchObject({
        kind: 'nextcloud',
        origin: ORIGIN,
        entryPath: '/nextcloud/',
        username: 'alice',
        credentialKind: 'basic',
        secretConfigured: true,
        status: 'unverified',
        pin: null,
        discoveryOpenUntil: new Date(bridge.clock.now + 900_000).toISOString(),
        createdAt: new Date(bridge.clock.now).toISOString(),
      })
      expect(bridge.attempts).toHaveLength(0)
      expect(bridge.remote.received).toHaveLength(0)
    })

    it('checks the address against the network policy at once', async () => {
      await start({ dns: { 'nextcloud.lan': ['192.168.1.20'] } })

      const refusal = await refusalFrom(connect(alice, { url: 'http://nextcloud.lan/' }))

      expect(refusal.tag).toBe('dav-address-not-allowed')
      expect(refusal.extra).toEqual({ origin: 'http://nextcloud.lan' })
      expect(await bridge.service.listAccounts(alice)).toEqual([])
    })

    it('connects a LAN host once the administrator has listed its origin, and not before', async () => {
      await start({ dns: { 'nextcloud.lan': ['192.168.1.20'] } })
      expect((await refusalFrom(connect(alice, { url: 'http://nextcloud.lan/' }))).tag).toBe('dav-address-not-allowed')

      await bridge.service.adminUpdate({ allowedPrivateOrigins: ['http://nextcloud.lan'] })
      const account = await connect(alice, { url: 'http://nextcloud.lan/' })
      await bridge.service.relay(alice, account.id, { method: 'PROPFIND', path: '/remote.php/dav/' })

      expect(bridge.attempts).toEqual([expect.objectContaining({ protocol: 'http:', address: '192.168.1.20' })])

      // And it stops again the moment the origin is taken off the list.
      await bridge.service.adminUpdate({ allowedPrivateOrigins: [] })
      expect(
        (await refusalFrom(bridge.service.relay(alice, account.id, { method: 'PROPFIND', path: '/remote.php/dav/' })))
          .tag,
      ).toBe('dav-address-not-allowed')
      expect(bridge.attempts).toHaveLength(1)
    })

    it.each([
      ['no body', undefined, 'body'],
      ['an unknown kind', accountInput({ kind: 'google' }), 'kind'],
      ['no url', accountInput({ url: undefined }), 'url'],
      ['a url that is not one', accountInput({ url: 'cloud.example.org' }), 'url'],
      ['another scheme', accountInput({ url: 'ftp://cloud.example.org/' }), 'url'],
      ['credentials in the url', accountInput({ url: 'https://alice:hunter2@cloud.example.org/' }), 'url'],
      ['a username in the url', accountInput({ url: 'https://alice@cloud.example.org/' }), 'url'],
      ['a query in the url', accountInput({ url: 'https://cloud.example.org/?token=abc' }), 'url'],
      ['a fragment in the url', accountInput({ url: 'https://cloud.example.org/#x' }), 'url'],
      ['a url past the length limit', accountInput({ url: `https://cloud.example.org/${'a'.repeat(2048)}` }), 'url'],
      ['a url whose path is not canonical', accountInput({ url: 'https://cloud.example.org/a//b' }), 'url'],
      ['no username for basic', accountInput({ username: '' }), 'username'],
      ['a colon in a basic username', accountInput({ username: 'alice:admin' }), 'username'],
      ['a control character in the username', accountInput({ username: 'alice\r\nX: 1' }), 'username'],
      ['a username past the length limit', accountInput({ username: 'a'.repeat(256) }), 'username'],
      ['a username that is not a string', accountInput({ username: { name: 'alice' } }), 'username'],
      ['an unknown credential kind', accountInput({ credentialKind: 'oauth' }), 'credentialKind'],
      ['no secret', accountInput({ secret: undefined }), 'secret'],
      ['an empty secret', accountInput({ secret: '' }), 'secret'],
      ['a secret that is a number', accountInput({ secret: 12345678 }), 'secret'],
      ['a secret that is an object', accountInput({ secret: { password: 'x' } }), 'secret'],
      ['a secret that is an array', accountInput({ secret: ['x'] }), 'secret'],
      ['a ten-megabyte secret', accountInput({ secret: 'x'.repeat(10 * 1024 * 1024) }), 'secret'],
      ['a bearer token with a space', accountInput({ credentialKind: 'bearer', secret: 'tok en' }), 'secret'],
      ['a bearer token with a line break', accountInput({ credentialKind: 'bearer', secret: 'tok\r\nX: 1' }), 'secret'],
    ])('refuses %s', async (_label, input, field) => {
      await start()

      const refusal = await refusalFrom(bridge.service.createAccount(alice, input))

      expect(refusal.tag).toBe('dav-invalid-input')
      expect(refusal.httpStatus).toBe(400)
      expect(refusal.extra).toEqual({ field })
      expect(await bridge.service.listAccounts(alice)).toEqual([])
      expect(bridge.dns.lookups).toEqual([])
    })

    it('accepts a bearer account with no username', async () => {
      await start()

      const account = await connect(alice, { credentialKind: 'bearer', username: undefined, secret: 'tok_abc.DEF-123' })
      await bridge.service.relay(alice, account.id, { method: 'PROPFIND', path: '/' })

      expect(account).toMatchObject({ credentialKind: 'bearer', username: '' })
      expect(bridge.attempts[0].authorization).toBe('Bearer tok_abc.DEF-123')
    })

    it('holds the account limit, and the administrator can raise it', async () => {
      await start({
        limits: { budgets: { ...DEFAULT_DAV_RELAY_LIMITS.budgets, validations: { max: 100, windowSeconds: 3600 } } },
      })
      for (let index = 0; index < 5; index++) {
        await connect()
      }

      const refusal = await refusalFrom(connect())
      expect(refusal.tag).toBe('dav-account-limit')
      expect(refusal.httpStatus).toBe(409)
      expect(refusal.extra).toEqual({ limit: 5 })

      await bridge.service.adminUpdate({ maxAccountsPerUser: 6 })
      await connect()
      expect(await bridge.service.listAccounts(alice)).toHaveLength(6)
      expect((await refusalFrom(connect())).extra).toEqual({ limit: 6 })
    })

    it('spends the validations budget, so the endpoint cannot be used to test passwords or probe names', async () => {
      await start()
      for (let attempt = 0; attempt < 10; attempt++) {
        await refusalFrom(connect(alice, { url: 'https://no-such-host.example/' }))
      }

      const refusal = await refusalFrom(connect())

      expect(refusal.tag).toBe('dav-rate-limited')
      expect(refusal.extra).toMatchObject({ budget: 'validations' })
      expect(bridge.dns.lookups.filter((host) => host === 'no-such-host.example')).toHaveLength(10)
    })

    it('says so when the server has no encryption key, and stores nothing', async () => {
      await start({ serverKey: undefined })

      const refusal = await refusalFrom(connect())

      expect(refusal.tag).toBe('dav-secret-store-unavailable')
      expect(refusal.httpStatus).toBe(503)
      expect(await fs.readdir(bridge.dataPath).catch(() => [])).toEqual([])
    })
  })

  describe('isolation between users', () => {
    it("gives the same answer for someone else's account as for one that does not exist", async () => {
      await start()
      const account = await connectAndPin()
      const bob = caller(newUserUuid())
      const missing = newUserUuid()

      for (const accountId of [account.id, missing]) {
        for (const action of [
          () => bridge.service.relay(bob, accountId, { method: 'PROPFIND', path: HOME }),
          () => bridge.service.replaceSecret(bob, accountId, { secret: 'x' }),
          () => bridge.service.setPin(bob, accountId, { principalPath: PRINCIPAL, calendarHomePath: HOME }),
          () => bridge.service.deleteAccount(bob, accountId),
        ]) {
          const refusal = await refusalFrom(action())
          expect(refusal.tag).toBe('dav-account-not-found')
          expect(refusal.httpStatus).toBe(404)
          expect(refusal.toBody()).toEqual({
            error: { tag: 'dav-account-not-found', message: 'Connected account not found.' },
          })
        }
      }
      expect(await bridge.service.listAccounts(bob)).toEqual([])
      expect(await bridge.service.listAccounts(alice)).toHaveLength(1)
      expect(bridge.attempts).toHaveLength(0)
    })

    it("does not let one user's delete-everything touch another's accounts", async () => {
      await start()
      await connect()
      const bob = caller(newUserUuid())
      await connect(bob, { username: 'bob' })

      expect(await bridge.service.deleteAllAccounts(bob)).toBe(1)

      expect(await bridge.service.listAccounts(bob)).toEqual([])
      expect((await bridge.service.listAccounts(alice)).map((account) => account.username)).toEqual(['alice'])
    })
  })

  describe('discovery window and pin', () => {
    it('lets discovery look anywhere with PROPFIND and OPTIONS, then narrows to the pin', async () => {
      await start()
      const account = await connect()

      await bridge.service.relay(alice, account.id, { method: 'PROPFIND', path: '/.well-known/caldav' })
      await bridge.service.relay(alice, account.id, { method: 'OPTIONS', path: '/remote.php/dav/' })
      expect(
        (
          await refusalFrom(
            bridge.service.relay(alice, account.id, { method: 'GET', path: '/remote.php/dav/files/alice/a.txt' }),
          )
        ).tag,
      ).toBe('dav-path-not-allowed')

      const pinned = await bridge.service.setPin(alice, account.id, {
        principalPath: PRINCIPAL,
        calendarHomePath: HOME,
      })
      expect(pinned.pin).toEqual({ principalPath: PRINCIPAL, calendarHomePath: HOME })
      expect(pinned.discoveryOpenUntil).toBeNull()

      await bridge.service.relay(alice, account.id, { method: 'REPORT', path: `${HOME}personal/` })
      await bridge.service.relay(alice, account.id, { method: 'GET', path: `${HOME}personal/1.ics` })
      for (const outside of ['/.well-known/caldav', '/remote.php/dav/files/alice/', '/remote.php/dav/calendars/bob/']) {
        expect(
          (await refusalFrom(bridge.service.relay(alice, account.id, { method: 'PROPFIND', path: outside }))).tag,
        ).toBe('dav-path-not-allowed')
      }

      expect(bridge.attempts.map((attempt) => `${attempt.method} ${attempt.path}`)).toEqual([
        'PROPFIND /.well-known/caldav',
        'OPTIONS /remote.php/dav/',
        `REPORT ${HOME}personal/`,
        `GET ${HOME}personal/1.ics`,
      ])
    })

    it('closes the window on its own after fifteen minutes when nothing was pinned', async () => {
      await start()
      const account = await connect()

      bridge.clock.now += DAV_RELAY_LIMITS.discoveryWindowSeconds * 1000 - 1
      await bridge.service.relay(alice, account.id, { method: 'PROPFIND', path: '/' })

      bridge.clock.now += 1
      expect((await refusalFrom(bridge.service.relay(alice, account.id, { method: 'PROPFIND', path: '/' }))).tag).toBe(
        'dav-discovery-closed',
      )
      expect((await bridge.service.listAccounts(alice))[0].discoveryOpenUntil).toBeNull()
      expect(bridge.attempts).toHaveLength(1)
    })

    it('does not let the pin be set or moved once the window is closed: that takes the password', async () => {
      await start()
      const account = await connectAndPin()
      const elsewhere = { principalPath: '/remote.php/dav/files/', calendarHomePath: '/remote.php/dav/files/alice/' }

      // A stolen session, a second after setup.
      const refusal = await refusalFrom(bridge.service.setPin(alice, account.id, elsewhere))
      expect(refusal.tag).toBe('dav-pin-locked')
      expect(refusal.httpStatus).toBe(409)
      expect((await bridge.service.listAccounts(alice))[0].pin).toEqual({
        principalPath: PRINCIPAL,
        calendarHomePath: HOME,
      })

      // The owner enters the password again: the window reopens and the pin can move.
      const reopened = await bridge.service.replaceSecret(alice, account.id, { secret: 'app-password' })
      expect(reopened.discoveryOpenUntil).not.toBeNull()
      expect(reopened.pin).toEqual({ principalPath: PRINCIPAL, calendarHomePath: HOME })
      const moved = await bridge.service.setPin(alice, account.id, {
        principalPath: '/dav/p/',
        calendarHomePath: '/dav/c/',
      })
      expect(moved.pin).toEqual({ principalPath: '/dav/p/', calendarHomePath: '/dav/c/' })

      // And that closed it again.
      expect((await refusalFrom(bridge.service.setPin(alice, account.id, elsewhere))).tag).toBe('dav-pin-locked')
    })

    it('does not let an account that was never pinned be pinned after the window closed', async () => {
      await start()
      const account = await connect()
      bridge.clock.now += DAV_RELAY_LIMITS.discoveryWindowSeconds * 1000

      expect(
        (
          await refusalFrom(
            bridge.service.setPin(alice, account.id, { principalPath: PRINCIPAL, calendarHomePath: HOME }),
          )
        ).tag,
      ).toBe('dav-pin-locked')
    })

    it('lets exactly one of two simultaneous pin requests through', async () => {
      await start()
      const account = await connect()

      const results = await Promise.allSettled([
        bridge.service.setPin(alice, account.id, { principalPath: PRINCIPAL, calendarHomePath: HOME }),
        bridge.service.setPin(alice, account.id, { principalPath: '/x/', calendarHomePath: '/y/' }),
      ])

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
      expect((rejected.reason as DavBridgeRefusal).tag).toBe('dav-pin-locked')
    })

    it.each([
      ['the whole server', { principalPath: PRINCIPAL, calendarHomePath: '/' }, 'calendarHomePath'],
      ['a principal that is the whole server', { principalPath: '/', calendarHomePath: HOME }, 'principalPath'],
      ['a home that is not a directory', { principalPath: PRINCIPAL, calendarHomePath: '/a/b' }, 'calendarHomePath'],
      ['a home with a parent segment', { principalPath: PRINCIPAL, calendarHomePath: '/a/../' }, 'calendarHomePath'],
      ['a missing principal', { calendarHomePath: HOME }, 'principalPath'],
      ['a full URL', { principalPath: PRINCIPAL, calendarHomePath: 'https://other.example/c/' }, 'calendarHomePath'],
    ])('refuses to pin %s', async (_label, input, field) => {
      await start()
      const account = await connect()

      const refusal = await refusalFrom(bridge.service.setPin(alice, account.id, input))

      expect(refusal.tag).toBe('dav-invalid-input')
      expect(refusal.extra).toEqual({ field })
      expect((await bridge.service.listAccounts(alice))[0].pin).toBeNull()
    })
  })

  describe('relaying', () => {
    it('hands back the remote answer under `remote` and marks the password as working, once', async () => {
      await start()
      const account = await connectAndPin()
      bridge.remote.respond(() => ({ status: 207, headers: { ETag: '"1"' }, body: '<d:multistatus/>' }))
      const file = path.join(bridge.dataPath, 'accounts', `${alice.userUuid}.json`)

      const first = await propfind(account)
      const afterFirst = await fs.stat(file)
      await new Promise((resolve) => setTimeout(resolve, 20))
      await propfind(account)
      await propfind(account)

      expect(first).toEqual({
        remote: {
          status: 207,
          headers: { etag: '"1"' },
          body: '<d:multistatus/>',
          bodyEncoding: 'utf8',
          path: HOME,
          redirects: 0,
        },
      })
      expect((await bridge.service.listAccounts(alice))[0].status).toBe('ok')
      // Nothing is written per relayed request: the file did not change after the first answer.
      expect((await fs.stat(file)).mtimeMs).toBe(afterFirst.mtimeMs)
      expect(bridge.attempts).toHaveLength(3)
    })

    it('does not mark the password as working on an answer that proves nothing', async () => {
      await start()
      const account = await connectAndPin()
      for (const status of [404, 403, 500]) {
        bridge.remote.respond(() => ({ status }))
        await propfind(account)
      }

      expect((await bridge.service.listAccounts(alice))[0].status).toBe('unverified')
    })

    it('passes a remote 403 through and keeps the account usable', async () => {
      await start()
      const account = await connectAndPin()
      bridge.remote.respond(() => ({ status: 403, body: 'read-only calendar' }))

      expect(await propfind(account)).toMatchObject({ remote: { status: 403, body: 'read-only calendar' } })

      bridge.remote.respond(() => ({ status: 207 }))
      expect(await propfind(account)).toMatchObject({ remote: { status: 207 } })
      expect((await bridge.service.listAccounts(alice))[0].status).toBe('ok')
    })

    describe('a rejected password', () => {
      it('stops everything after ONE 401: the remote is not asked again until the password is replaced', async () => {
        await start()
        const account = await connectAndPin()
        bridge.remote.respond(() => ({ status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Nextcloud"' } }))

        const first = await refusalFrom(propfind(account))
        expect(first.tag).toBe('dav-password-rejected')
        expect(first.httpStatus).toBe(409)
        expect(bridge.remote.received).toHaveLength(1)

        // Every later request is refused WITHOUT touching the remote, whatever it would now answer.
        bridge.remote.respond(() => ({ status: 207 }))
        for (let attempt = 0; attempt < 20; attempt++) {
          expect((await refusalFrom(propfind(account))).tag).toBe('dav-password-rejected')
        }
        expect(bridge.remote.received).toHaveLength(1)
        expect(bridge.attempts).toHaveLength(1)
        expect((await bridge.service.listAccounts(alice))[0].status).toBe('password-rejected')
      })

      it('is remembered across a restart, so a restart does not try the password again', async () => {
        await start()
        const account = await connectAndPin()
        bridge.remote.respond(() => ({ status: 401 }))
        await refusalFrom(propfind(account))

        const stored = JSON.parse(
          await fs.readFile(path.join(bridge.dataPath, 'accounts', `${alice.userUuid}.json`), 'utf8'),
        ) as { accounts: Array<{ secretState: string }> }

        expect(stored.accounts[0].secretState).toBe('rejected')
      })

      it('is cleared by replacing the password, and by nothing else', async () => {
        await start()
        const account = await connectAndPin()
        bridge.remote.respond(() => ({ status: 401 }))
        await refusalFrom(propfind(account))
        bridge.clock.now += 24 * 3600 * 1000

        expect((await refusalFrom(propfind(account))).tag).toBe('dav-password-rejected')

        const replaced = await bridge.service.replaceSecret(alice, account.id, { secret: 'new-app-password' })
        expect(replaced.status).toBe('unverified')
        bridge.remote.respond(() => ({ status: 207 }))
        await propfind(account)

        expect(bridge.remote.received[bridge.remote.received.length - 1].headers.authorization).toBe(
          `Basic ${Buffer.from('alice:new-app-password').toString('base64')}`,
        )
        expect((await bridge.service.listAccounts(alice))[0].status).toBe('ok')
      })

      it('is not undone by a slower request that succeeded with the old password', async () => {
        await start()
        const account = await connectAndPin()
        let call = 0
        bridge.remote.respond(() => (++call === 1 ? { status: 401 } : { status: 207 }))

        await Promise.allSettled([propfind(account), propfind(account)])

        expect((await bridge.service.listAccounts(alice))[0].status).toBe('password-rejected')
      })

      it("does not affect the same user's other accounts or another user's account at the same origin", async () => {
        await start()
        const rejected = await connectAndPin()
        const second = await connectAndPin()
        const bob = caller(newUserUuid())
        const bobs = await connectAndPin(bob)
        bridge.remote.respond(() => ({ status: 401 }))
        await refusalFrom(propfind(rejected))
        bridge.remote.respond(() => ({ status: 207 }))

        expect(await propfind(second)).toMatchObject({ remote: { status: 207 } })
        expect(await propfind(bobs, bob)).toMatchObject({ remote: { status: 207 } })
      })
    })

    it('reports a stored password that can no longer be read, as a state and without retrying', async () => {
      await start()
      const account = await connectAndPin()
      // The server key changed: the same files, opened by a server with another key.
      const rotated = await buildBridge({ serverKey: 'c3'.repeat(32) })
      try {
        await fs.cp(bridge.dataPath, rotated.dataPath, { recursive: true })

        expect((await rotated.service.listAccounts(alice))[0].status).toBe('secret-unreadable')
        const refusal = await refusalFrom(
          rotated.service.relay(alice, account.id, { method: 'PROPFIND', path: HOME, headers: { depth: '1' } }),
        )
        expect(refusal.tag).toBe('dav-secret-unreadable')
        expect(refusal.httpStatus).toBe(409)
        expect(rotated.attempts).toHaveLength(0)

        // Entering it again repairs it.
        const repaired = await rotated.service.replaceSecret(alice, account.id, { secret: 'app-password' })
        expect(repaired.status).toBe('unverified')
        await rotated.service.relay(alice, account.id, { method: 'PROPFIND', path: HOME })
        expect(rotated.attempts).toHaveLength(1)
      } finally {
        await rotated.close()
      }
    })

    it('validates the envelope before anything is sent', async () => {
      await start()
      const account = await connectAndPin()

      for (const [envelope, tag] of [
        [
          { method: 'PUT', path: `${HOME}a.ics`, headers: { 'content-type': 'text/calendar' }, body: 'x' },
          'dav-writes-disabled',
        ],
        [{ method: 'DELETE', path: `${HOME}a.ics` }, 'dav-writes-disabled'],
        [{ method: 'MKCALENDAR', path: `${HOME}new/` }, 'dav-writes-disabled'],
        [{ method: 'POST', path: HOME }, 'dav-method-not-allowed'],
        [{ method: 'GET', path: `${HOME}../files/` }, 'dav-invalid-path'],
        [{ method: 'GET', path: HOME, headers: { authorization: 'Basic x' } }, 'dav-header-not-allowed'],
        ['PROPFIND', 'dav-invalid-input'],
      ] as Array<[unknown, string]>) {
        expect((await refusalFrom(bridge.service.relay(alice, account.id, envelope))).tag).toBe(tag)
      }
      expect(bridge.attempts).toHaveLength(0)
      expect(bridge.remote.received).toHaveLength(0)
    })

    it('spends the request budget on every call and stops at it', async () => {
      await start({
        limits: { budgets: { ...DEFAULT_DAV_RELAY_LIMITS.budgets, requests: { max: 3, windowSeconds: 600 } } },
      })
      const account = await connectAndPin()
      await propfind(account)
      await propfind(account)
      await propfind(account)

      const refusal = await refusalFrom(propfind(account))

      expect(refusal.tag).toBe('dav-rate-limited')
      expect(refusal.extra).toEqual({ budget: 'requests', retryAfterSeconds: 600 })
      expect(bridge.attempts).toHaveLength(3)
      // Another user is not affected.
      const bob = caller(newUserUuid())
      expect(await propfind(await connectAndPin(bob), bob)).toMatchObject({ remote: { status: 207 } })
    })

    it('opens the breaker after five failures in a row and stops trying for five minutes', async () => {
      await start()
      const account = await connectAndPin()
      bridge.remote.respond(() => ({ status: 503 }))
      for (let failure = 0; failure < 5; failure++) {
        expect(await propfind(account)).toMatchObject({ remote: { status: 503 } })
      }

      const refusal = await refusalFrom(propfind(account))
      expect(refusal.tag).toBe('dav-remote-circuit-open')
      expect(refusal.extra).toEqual({ retryAfterSeconds: 300 })
      expect(bridge.attempts).toHaveLength(5)

      bridge.clock.now += 300_000
      bridge.remote.respond(() => ({ status: 207 }))
      expect(await propfind(account)).toMatchObject({ remote: { status: 207 } })
      expect(bridge.attempts).toHaveLength(6)
    })

    it('counts an unreachable remote toward the breaker and a refusal of its own against nothing', async () => {
      await start()
      const account = await connectAndPin()
      // Refusals that never reach the remote must not open the breaker.
      for (let attempt = 0; attempt < 20; attempt++) {
        await refusalFrom(propfind(account, alice, '/remote.php/dav/files/alice/'))
      }
      expect(await propfind(account)).toMatchObject({ remote: { status: 207 } })

      await bridge.remote.stop()
      for (let failure = 0; failure < 5; failure++) {
        expect((await refusalFrom(propfind(account))).tag).toBe('dav-remote-unreachable')
      }
      expect((await refusalFrom(propfind(account))).tag).toBe('dav-remote-circuit-open')
      await bridge.remote.start()
    })

    it('holds two requests per account at once and refuses a third', async () => {
      await start()
      const account = await connectAndPin()
      bridge.remote.respond(() => ({ hang: true }))
      const first = propfind(account)
      const second = propfind(account)
      await new Promise((resolve) => setTimeout(resolve, 100))

      const refusal = await refusalFrom(propfind(account))
      expect(refusal.tag).toBe('dav-busy')
      expect(refusal.extra).toEqual({ retryAfterSeconds: 1 })

      await bridge.service.deleteAccount(alice, account.id)
      await Promise.allSettled([first, second])
    })

    it('stops in-flight requests when the account is removed, and tells them it is gone', async () => {
      await start()
      const account = await connectAndPin()
      bridge.remote.respond(() => ({ hang: true }))
      const pending = propfind(account)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(bridge.limiter.activeRequests()).toBe(1)

      await bridge.service.deleteAccount(alice, account.id)

      expect((await refusalFrom(pending)).tag).toBe('dav-account-not-found')
      expect(bridge.limiter.activeRequests()).toBe(0)
    })

    it('gives its concurrency slot back after a failure as well as after a success', async () => {
      await start()
      const account = await connectAndPin()
      bridge.remote.respond(() => ({ status: 401 }))
      await refusalFrom(propfind(account))
      await refusalFrom(propfind(account, alice, '/outside/'))

      expect(bridge.limiter.activeRequests()).toBe(0)
    })
  })

  describe('removing', () => {
    it('removes the account, its secret and its file', async () => {
      await start()
      const account = await connectAndPin()
      const directory = path.join(bridge.dataPath, 'accounts')
      // The positive control: there is a file with this user's name before.
      expect((await fs.readdir(directory)).some((name) => name.includes(alice.userUuid))).toBe(true)

      await bridge.service.deleteAccount(alice, account.id)

      expect(await bridge.service.listAccounts(alice)).toEqual([])
      expect((await fs.readdir(directory)).filter((name) => name.includes(alice.userUuid))).toEqual([])
      expect((await refusalFrom(propfind(account))).tag).toBe('dav-account-not-found')
      expect((await refusalFrom(bridge.service.deleteAccount(alice, account.id))).tag).toBe('dav-account-not-found')
    })

    it('forgets a user entirely, which is what deleting their Standard Red Notes account calls', async () => {
      await start()
      await connect()
      await connect()
      const bob = caller(newUserUuid())
      await connect(bob)
      const directory = path.join(bridge.dataPath, 'accounts')

      expect(await bridge.service.forgetUser(alice.userUuid)).toBe(2)

      expect((await fs.readdir(directory)).filter((name) => name.includes(alice.userUuid))).toEqual([])
      expect(await bridge.service.listAccounts(bob)).toHaveLength(1)
      expect(await bridge.service.forgetUser(alice.userUuid)).toBe(0)
    })
  })

  describe('administrator', () => {
    it('sees origins, kinds, states and counts, and never a username, a path or content', async () => {
      await start()
      const account = await connectAndPin()
      bridge.remote.respond(() => ({
        status: 207,
        body: '<d:response><d:href>/secret-calendar-name/</d:href></d:response>',
      }))
      await propfind(account)
      await refusalFrom(propfind(account, alice, '/remote.php/dav/files/alice/'))

      const view = await bridge.service.adminView()

      expect(view.users).toEqual([
        {
          userUuid: alice.userUuid,
          accounts: [
            {
              id: account.id,
              kind: 'nextcloud',
              origin: ORIGIN,
              status: 'ok',
              lastResult: 'dav-path-not-allowed',
              requests: 2,
            },
          ],
        },
      ])
      const rendered = JSON.stringify(view)
      expect(rendered).not.toContain('alice"')
      expect(rendered).not.toContain('"username"')
      expect(rendered).not.toContain(HOME)
      expect(rendered).not.toContain('secret-calendar-name')
      expect(view).toMatchObject({
        secretStoreReady: true,
        writeEnabled: false,
        modes: ['relay'],
        modeImplemented: true,
        allowlistEditable: true,
        usersTruncated: false,
        activeRequests: 0,
      })
    })

    it('says when the server could not seal a password at all', async () => {
      await start({ serverKey: undefined })

      expect((await bridge.service.adminView()).secretStoreReady).toBe(false)
    })

    it('saves settings and reports which names changed', async () => {
      await start({ env: { enabled: false } })

      const changed = await bridge.service.adminUpdate({
        enabled: true,
        mode: 'relay',
        allowAllUsers: true,
        allowedPrivateOrigins: ['http://nextcloud', 'https://cloud.home.lan:8443'],
        maxAccountsPerUser: 8,
      })

      expect(changed.sort()).toEqual(
        [
          'davBridge.enabled',
          'davBridge.mode',
          'davBridge.allowAllUsers',
          'davBridge.allowedPrivateOrigins',
          'davBridge.maxAccountsPerUser',
        ].sort(),
      )
      expect((await bridge.service.adminView()).settings).toEqual({
        enabled: true,
        mode: 'relay',
        allowAllUsers: true,
        allowedPrivateOrigins: ['http://nextcloud', 'https://cloud.home.lan:8443'],
        maxAccountsPerUser: 8,
      })
    })

    it.each([
      ['nothing recognised', { somethingElse: true }, 'body'],
      ['a body that is not an object', 'enabled', 'body'],
      ['enabled as a string', { enabled: 'true' }, 'enabled'],
      ['allowAllUsers as a number', { allowAllUsers: 1 }, 'allowAllUsers'],
      ['a mode this build does not implement', { mode: 'hub' }, 'mode'],
      ['a mode that is not a string', { mode: 1 }, 'mode'],
      ['too many accounts', { maxAccountsPerUser: 21 }, 'maxAccountsPerUser'],
      ['zero accounts', { maxAccountsPerUser: 0 }, 'maxAccountsPerUser'],
      ['a fractional account limit', { maxAccountsPerUser: 2.5 }, 'maxAccountsPerUser'],
      ['origins that are not a list', { allowedPrivateOrigins: 'http://nextcloud' }, 'allowedPrivateOrigins'],
      ['an origin with a path', { allowedPrivateOrigins: ['http://nextcloud/dav'] }, 'allowedPrivateOrigins'],
      ['an origin with a trailing slash', { allowedPrivateOrigins: ['http://nextcloud/'] }, 'allowedPrivateOrigins'],
      ['a bare host', { allowedPrivateOrigins: ['nextcloud'] }, 'allowedPrivateOrigins'],
      ['a wildcard', { allowedPrivateOrigins: ['http://*.home.lan'] }, 'allowedPrivateOrigins'],
      ['the same origin twice', { allowedPrivateOrigins: ['http://a', 'http://a'] }, 'allowedPrivateOrigins'],
      [
        'more than sixty-four origins',
        { allowedPrivateOrigins: Array.from({ length: 65 }, (_u, i) => `http://h${i}`) },
        'allowedPrivateOrigins',
      ],
      ['loopback', { allowedPrivateOrigins: ['http://127.0.0.1:3000'] }, 'allowedPrivateOrigins'],
      ['IPv6 loopback', { allowedPrivateOrigins: ['http://[::1]'] }, 'allowedPrivateOrigins'],
      ['localhost', { allowedPrivateOrigins: ['http://localhost:8080'] }, 'allowedPrivateOrigins'],
      ['the metadata address', { allowedPrivateOrigins: ['http://169.254.169.254'] }, 'allowedPrivateOrigins'],
      ['the database by name', { allowedPrivateOrigins: ['http://db:3306'] }, 'allowedPrivateOrigins'],
      ['the server by name', { allowedPrivateOrigins: ['http://server:3000'] }, 'allowedPrivateOrigins'],
      [
        'the cache by name',
        { allowedPrivateOrigins: ['http://nextcloud', 'http://cache:6379'] },
        'allowedPrivateOrigins',
      ],
    ])('refuses %s and saves nothing', async (_label, input, field) => {
      await start()

      const refusal = await refusalFrom(bridge.service.adminUpdate(input))

      expect(refusal.tag).toBe('dav-invalid-input')
      expect(refusal.extra).toEqual({ field })
      expect((await bridge.service.adminView()).sources).toEqual({
        enabled: 'env',
        mode: 'default',
        allowAllUsers: 'default',
        allowedPrivateOrigins: 'default',
        maxAccountsPerUser: 'default',
      })
    })

    it('saves nothing at all when one key of several is bad', async () => {
      await start({ env: { enabled: false } })

      await refusalFrom(bridge.service.adminUpdate({ enabled: true, allowedPrivateOrigins: ['http://db:3306'] }))

      expect((await bridge.service.adminView()).settings.enabled).toBe(false)
    })

    it('refuses to change an origin list that the operator pinned to the environment', async () => {
      await start({ env: { enabled: true, allowlistEnvOnly: true, allowedPrivateOrigins: ['http://nextcloud'] } })

      const refusal = await refusalFrom(bridge.service.adminUpdate({ allowedPrivateOrigins: ['http://attacker.lan'] }))

      expect(refusal.tag).toBe('dav-allowlist-env-only')
      expect(await bridge.service.adminView()).toMatchObject({
        allowlistEditable: false,
        settings: { allowedPrivateOrigins: ['http://nextcloud'] },
      })
    })

    it('purges one user or everyone and reports how much', async () => {
      await start()
      await connect()
      await connect()
      const bob = caller(newUserUuid())
      await connect(bob)
      const carol = caller(newUserUuid())
      await connect(carol)

      expect(await bridge.service.purgeUser(alice.userUuid)).toEqual({ purgedUsers: 1, purgedAccounts: 2 })
      expect(await bridge.service.purgeUser(alice.userUuid)).toEqual({ purgedUsers: 0, purgedAccounts: 0 })
      expect(await bridge.service.listAccounts(bob)).toHaveLength(1)

      expect(await bridge.service.purgeAll()).toEqual({ purgedUsers: 2, purgedAccounts: 2 })
      expect(await bridge.service.listAccounts(bob)).toEqual([])
      expect(await bridge.service.listAccounts(carol)).toEqual([])
      expect((await bridge.service.adminView()).users).toEqual([])
      expect(
        (await fs.readdir(path.join(bridge.dataPath, 'accounts'))).filter((name) => name.endsWith('.json')),
      ).toEqual([])
    })
  })

  it('pins at the type level that an account view has no secret', async () => {
    await start()
    const view = await connect()

    const withSecret: DavAccountView = {
      ...view,
      // @ts-expect-error -- an account view cannot carry a secret. If this line stops being an error, the view type grew a field that could hold one.
      secret: 'app-password',
    }

    expect(Object.keys(view)).not.toContain('secret')
    expect(withSecret).toBeDefined()
  })
})
