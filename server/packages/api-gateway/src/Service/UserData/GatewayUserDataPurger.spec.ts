import { promises as fs } from 'fs'
import * as path from 'path'

import { CaldavService } from '../Caldav/CaldavService'
import { CaldavTokenStore } from '../Caldav/CaldavTokenStore'
import { CalendarProjectionStore } from '../Caldav/CalendarProjectionStore'
import { PublishedCalendarStore } from '../Caldav/PublishedCalendarStore'
import { createDavBridgeService } from '../DavBridge/DavBridgeFactory'
import { DavBridgeService } from '../DavBridge/DavBridgeService'
import {
  caller,
  capturingLogger,
  newUserUuid,
  removeDirectory,
  resolver,
  temporaryDirectory,
  TEST_SERVER_KEY,
} from '../DavBridge/DavBridgeTestKit.spec'
import { DeliveryConfigStore } from '../ReminderDelivery/DeliveryConfigStore'
import { ProviderRegistry } from '../ReminderDelivery/Providers/ProviderRegistry'
import { PublishedRemindersStore } from '../ReminderDelivery/PublishedRemindersStore'
import { ReminderDeliveryService } from '../ReminderDelivery/ReminderDeliveryService'
import { ServerSettingsStore } from '../ServerSettings/ServerSettingsStore'
import { DeletedAccountMarkers, deletedAccountMarkersDirectory } from '@standardnotes/domain-core'
import {
  GatewayUserDataPurger,
  GatewayUserDataStore,
  purgeGatewayUserDataAfterDeletion,
  startGatewayUserDataPurger,
} from './GatewayUserDataPurger'

const USER = '11111111-1111-4111-8111-111111111111'

/** Every file under a directory, with its text. Lock and temporary artifacts included. */
async function everyFile(directory: string): Promise<Array<{ file: string; text: string }>> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true })
  const files: Array<{ file: string; text: string }> = []
  for (const entry of entries) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name)
      files.push({ file: path.relative(directory, file), text: await fs.readFile(file, 'utf8') })
    }
  }
  return files
}

/** Where a user's id still appears: in a file's name or in a file's content. */
async function tracesOf(directory: string, userUuid: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true })
  const named = entries
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .filter((name) => name.includes(userUuid))
    .map((name) => `name: ${name}`)
  const containing = (await everyFile(directory))
    .filter(({ text }) => text.includes(userUuid))
    .map(({ file }) => `content: ${file}`)
  return [...named, ...containing].sort()
}

describe('GatewayUserDataPurger', () => {
  describe('against the real stores', () => {
    let directory: string
    let davBridge: DavBridgeService
    let caldav: CaldavService
    let reminders: ReminderDeliveryService
    let purger: GatewayUserDataPurger
    let logger: ReturnType<typeof capturingLogger>

    const fill = async (userUuid: string): Promise<void> => {
      await davBridge.createAccount(caller(userUuid), {
        kind: 'caldav',
        url: 'https://cloud.example.org/',
        username: 'someone',
        secret: 'an-app-password',
      })
      await caldav.createToken(userUuid, 'Thunderbird')
      await caldav.publishTodo(userUuid, { uid: 'todo-1', summary: 'Buy milk' })
      await caldav.publishTodo(userUuid, { uid: 'todo-2', summary: 'Call the bank' })
      await caldav.setProjection(userUuid, { enabled: true })
      await reminders.setConfig(userUuid, { channel: 'email', destination: 'someone@example.org', enabled: true })
      await reminders.publish(userUuid, {
        id: 'reminder-1',
        message: 'Dentist',
        dueAtUtc: '2030-01-01T09:00:00.000Z',
      })
    }

    beforeEach(async () => {
      directory = await temporaryDirectory('purger')
      logger = capturingLogger()
      davBridge = createDavBridgeService({
        env: (name) => ({ DAV_BRIDGE_ENABLED: 'true', DAV_BRIDGE_DATA_PATH: path.join(directory, 'dav-bridge') })[name],
        workingDirectory: directory,
        serverSettingsStore: new ServerSettingsStore(path.join(directory, 'server-settings.json'), TEST_SERVER_KEY),
        encryptionKey: TEST_SERVER_KEY,
        logger: capturingLogger(),
        network: {
          resolveHost: resolver({ 'cloud.example.org': ['93.184.216.34'] }),
          resolveOwnServiceName: async () => [],
          ownInterfaceAddresses: () => [],
        },
      })
      caldav = new CaldavService(
        true,
        new CaldavTokenStore(path.join(directory, 'caldav', 'tokens.json')),
        new PublishedCalendarStore(path.join(directory, 'caldav', 'published.json')),
        new CalendarProjectionStore(path.join(directory, 'caldav', 'projection.json')),
      )
      reminders = new ReminderDeliveryService(
        true,
        new PublishedRemindersStore(path.join(directory, 'reminder-delivery', 'published-reminders.json')),
        new DeliveryConfigStore(path.join(directory, 'reminder-delivery', 'delivery-config.json')),
        new ProviderRegistry([]),
      )
      // The same three entries, in the same order, as the gateway's container.
      purger = new GatewayUserDataPurger(
        [
          { name: 'dav-bridge-accounts', purge: (userUuid) => davBridge.forgetUser(userUuid) },
          { name: 'caldav', purge: (userUuid) => caldav.forgetUser(userUuid) },
          {
            name: 'reminder-delivery',
            purge: async (userUuid) => {
              await reminders.optOut(userUuid)
              return 0
            },
          },
        ],
        logger,
      )
    })

    afterEach(async () => {
      await removeDirectory(directory)
    })

    it('leaves nothing on disk that names the deleted user, and leaves every other user alone', async () => {
      const alice = newUserUuid()
      const bob = newUserUuid()
      await fill(alice)
      await fill(bob)

      // The positive control: before the purge the user IS in every store, so
      // "no trace afterwards" below is a statement about the purge.
      const before = await tracesOf(directory, alice)
      expect(before).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^name: dav-bridge.accounts.[0-9a-f-]+\.json$/),
          expect.stringMatching(/^content: caldav.tokens\.json$/),
          expect.stringMatching(/^content: caldav.published\.json$/),
          expect.stringMatching(/^content: caldav.projection\.json$/),
          expect.stringMatching(/^content: reminder-delivery.published-reminders\.json$/),
          expect.stringMatching(/^content: reminder-delivery.delivery-config\.json$/),
        ]),
      )
      const bobBefore = await tracesOf(directory, bob)

      const result = await purger.purge(alice)

      expect(await tracesOf(directory, alice)).toEqual([])
      expect(await tracesOf(directory, bob)).toEqual(bobBefore)
      expect(result).toEqual({
        // one DAV account; one token + two published items + projection settings
        stores: { 'dav-bridge-accounts': 1, caldav: 4, 'reminder-delivery': 0 },
        removed: 5,
        failed: 0,
      })

      // And through the services, which is how a client would see it.
      expect(await davBridge.listAccounts(caller(alice))).toEqual([])
      expect(await caldav.listTokens(alice)).toEqual([])
      expect(await caldav.listTodos(alice)).toEqual([])
      expect((await caldav.getProjection(alice)).enabled).toBe(false)
      expect(await reminders.getConfig(alice)).toBeNull()
      expect(await reminders.listReminders(alice)).toEqual([])
      expect(await davBridge.listAccounts(caller(bob))).toHaveLength(1)
      expect(await caldav.listTokens(bob)).toHaveLength(1)
      expect(await caldav.listTodos(bob)).toHaveLength(2)
    })

    it('when the token store cannot be purged: the deletion stays on record, the live token is KNOWN, and the next sweep kills it', async () => {
      const alice = newUserUuid()
      const bob = newUserUuid()
      await fill(alice)
      await fill(bob)
      const token = await caldav.createToken(alice, 'Phone')
      const bobBefore = await tracesOf(directory, bob)
      // Beside the settings file, where a deployment keeps it.
      const markers = new DeletedAccountMarkers(path.join(directory, 'deleted-accounts'))
      let tokenStoreBroken = true
      const withRecord = new GatewayUserDataPurger(
        [
          { name: 'dav-bridge-accounts', purge: (userUuid) => davBridge.forgetUser(userUuid) },
          {
            name: 'caldav',
            // The real store, behind a delete that fails the way a locked file does.
            purge: async (userUuid) => {
              if (tokenStoreBroken) {
                throw new Error(`EBUSY: resource busy or locked, tokens.json (${userUuid})`)
              }
              return caldav.forgetUser(userUuid)
            },
          },
          {
            name: 'reminder-delivery',
            purge: async (userUuid) => {
              await reminders.optOut(userUuid)
              return 0
            },
          },
        ],
        logger,
        markers,
      )

      const result = await withRecord.purgeDeletedAccount(alice)

      // The stored password went although the token store failed...
      expect(result.stores).toEqual({ 'dav-bridge-accounts': 1, caldav: 'failed', 'reminder-delivery': 0 })
      expect(await davBridge.listAccounts(caller(alice))).toEqual([])
      // ...the token of the deleted account still works, which is the hole...
      expect((await caldav.verifyToken(token.token))?.userUuid).toBe(alice)
      // ...and it is not a quiet one: on record, counted, and logged by store name.
      expect(await markers.list()).toEqual([alice])
      expect(await withRecord.pendingCount()).toBe(1)
      expect(logger.lines).toEqual([
        {
          level: 'warn',
          message: 'gateway user data purge incomplete after account deletion',
          meta: { userId: alice, removed: 1, failedStores: ['caldav'] },
        },
      ])

      tokenStoreBroken = false
      expect(await withRecord.sweep()).toEqual({ found: 1, completed: 1, stillPending: 0 })

      expect(await caldav.verifyToken(token.token)).toBeNull()
      // Nothing names the deleted user any more, the record included.
      expect(await tracesOf(directory, alice)).toEqual([])
      expect(await tracesOf(directory, bob)).toEqual(bobBefore)
      expect(await withRecord.pendingCount()).toBe(0)
    })

    it("stops a deleted user's CalDAV token from working", async () => {
      const alice = newUserUuid()
      const created = await caldav.createToken(alice, 'Phone')
      expect((await caldav.verifyToken(created.token))?.userUuid).toBe(alice)

      await purger.purge(alice)

      expect(await caldav.verifyToken(created.token)).toBeNull()
    })

    it('treats an upper-case spelling of the id as the same user', async () => {
      const alice = newUserUuid()
      await fill(alice)

      await purger.purge(alice.toUpperCase())

      expect(await tracesOf(directory, alice)).toEqual([])
    })

    it('is harmless for a user who has nothing, and for one purged twice', async () => {
      const nobody = newUserUuid()

      expect(await purger.purge(nobody)).toEqual({
        stores: { 'dav-bridge-accounts': 0, caldav: 0, 'reminder-delivery': 0 },
        removed: 0,
        failed: 0,
      })
      expect(await tracesOf(directory, nobody)).toEqual([])
      expect(logger.lines).toEqual([])

      const alice = newUserUuid()
      await fill(alice)
      await purger.purge(alice)
      expect((await purger.purge(alice)).removed).toBe(0)
    })

    it('logs the id and a count, and nothing the user stored', async () => {
      const alice = newUserUuid()
      await fill(alice)

      await purger.purge(alice)

      expect(logger.lines).toEqual([
        {
          level: 'info',
          message: 'gateway user data purged after account deletion',
          meta: { userId: alice, removed: 5 },
        },
      ])
      expect(logger.text()).not.toMatch(/someone|example\.org|Buy milk|Dentist|Thunderbird/)
    })
  })

  describe('one store failing', () => {
    const store = (name: string, purge: GatewayUserDataStore['purge']): GatewayUserDataStore => ({ name, purge })

    it('does not stop the stores after it, and is reported by name only', async () => {
      const logger = capturingLogger()
      const calls: string[] = []
      const purger = new GatewayUserDataPurger(
        [
          store('first', async () => {
            calls.push('first')
            return 2
          }),
          store('locked', async () => {
            calls.push('locked')
            throw new Error(`could not lock /data/reminder-delivery/${USER}.json for someone@example.org`)
          }),
          store('last', async () => {
            calls.push('last')
            return 3
          }),
        ],
        logger,
      )

      const result = await purger.purge(USER)

      expect(calls).toEqual(['first', 'locked', 'last'])
      expect(result).toEqual({ stores: { first: 2, locked: 'failed', last: 3 }, removed: 5, failed: 1 })
      expect(logger.lines).toEqual([
        {
          level: 'warn',
          message: 'gateway user data purge incomplete after account deletion',
          meta: { userId: USER, removed: 5, failedStores: ['locked'] },
        },
      ])
      // The failure's text names a file and an address. Neither is logged.
      expect(logger.text()).not.toMatch(/someone@example\.org|could not lock|\/data\//)
    })

    it('works without a logger', async () => {
      const purger = new GatewayUserDataPurger([
        store('broken', async () => {
          throw new Error('x')
        }),
      ])

      await expect(purger.purge(USER)).resolves.toEqual({ stores: { broken: 'failed' }, removed: 0, failed: 1 })
    })
  })

  describe('what counts as a user id', () => {
    it.each([
      '',
      'not-a-uuid',
      '../../etc/passwd',
      `${USER}/../x`,
      `${USER}.json`,
      ' 11111111-1111-4111-8111-111111111111',
      'gggggggg-gggg-4ggg-8ggg-gggggggggggg',
      undefined,
      null,
      42,
      { uuid: USER },
    ])('touches no store for %p', async (value) => {
      const purge = jest.fn().mockResolvedValue(1)
      const purger = new GatewayUserDataPurger([{ name: 'any', purge }])

      expect(await purger.purge(value as string)).toEqual({ stores: {}, removed: 0, failed: 0 })
      expect(purge).not.toHaveBeenCalled()
    })

    it('passes the lower-case spelling to every store', async () => {
      const purge = jest.fn().mockResolvedValue(0)

      await new GatewayUserDataPurger([{ name: 'any', purge }]).purge(USER.toUpperCase())

      expect(purge).toHaveBeenCalledWith(USER)
    })
  })
})

describe('purgeGatewayUserDataAfterDeletion', () => {
  const purgerSpy = (): { purger: GatewayUserDataPurger; purge: jest.Mock } => {
    const purge = jest.fn().mockResolvedValue({ stores: {}, removed: 0, failed: 0 })
    return { purger: { purgeDeletedAccount: purge } as unknown as GatewayUserDataPurger, purge }
  }

  it.each([200, 201, 204])('purges after the deletion was answered with %i', async (statusCode) => {
    const { purger, purge } = purgerSpy()

    await purgeGatewayUserDataAfterDeletion(purger, { statusCode, headersSent: true }, USER)

    expect(purge).toHaveBeenCalledWith(USER)
  })

  it.each([400, 401, 403, 404, 409, 429, 500, 502, 301, 199])(
    'does not purge when the deletion was refused or failed with %i',
    async (statusCode) => {
      const { purger, purge } = purgerSpy()

      await purgeGatewayUserDataAfterDeletion(purger, { statusCode, headersSent: true }, USER)

      expect(purge).not.toHaveBeenCalled()
    },
  )

  it('does not read the default 200 of a response nothing was written to as a success', async () => {
    const { purger, purge } = purgerSpy()

    await purgeGatewayUserDataAfterDeletion(purger, { statusCode: 200, headersSent: false }, USER)

    expect(purge).not.toHaveBeenCalled()
  })

  it('does nothing without a purger or without a user id', async () => {
    const { purger, purge } = purgerSpy()

    await purgeGatewayUserDataAfterDeletion(undefined, { statusCode: 200, headersSent: true }, USER)
    await purgeGatewayUserDataAfterDeletion(purger, { statusCode: 200, headersSent: true }, undefined)
    await purgeGatewayUserDataAfterDeletion(purger, { statusCode: 200, headersSent: true }, ['x'])

    expect(purge).not.toHaveBeenCalled()
  })

  it('never throws into a route whose answer has already gone out', async () => {
    const purger = {
      purgeDeletedAccount: jest.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as GatewayUserDataPurger

    await expect(
      purgeGatewayUserDataAfterDeletion(purger, { statusCode: 200, headersSent: true }, USER),
    ).resolves.toBeUndefined()
  })
})

describe('a deletion is recorded until every store has been purged', () => {
  let root: string
  let markers: DeletedAccountMarkers
  let logger: ReturnType<typeof capturingLogger>

  /** A store that fails until it is told to recover, and remembers what it removed. */
  const flakyStore = (name: string): GatewayUserDataStore & { broken: boolean; purged: string[] } => {
    const store = {
      name,
      broken: false,
      purged: [] as string[],
      purge: async (userUuid: string): Promise<number> => {
        if (store.broken) {
          throw new Error(`cannot lock the ${name} file for ${userUuid}`)
        }
        store.purged.push(userUuid)
        return 1
      },
    }
    return store
  }

  beforeEach(async () => {
    root = await temporaryDirectory('purge-markers')
    markers = new DeletedAccountMarkers(path.join(root, 'deleted-accounts'))
    logger = capturingLogger()
  })

  afterEach(async () => {
    await removeDirectory(root)
  })

  it('leaves no record behind when every store was purged', async () => {
    const purger = new GatewayUserDataPurger([flakyStore('a'), flakyStore('b')], logger, markers)

    const result = await purger.purgeDeletedAccount(USER)

    expect(result).toEqual({ stores: { a: 1, b: 1 }, removed: 2, failed: 0 })
    expect(await markers.list()).toEqual([])
    expect(await purger.pendingCount()).toBe(0)
  })

  it('writes the record BEFORE it purges, so a process that dies mid-purge is not a silent leftover', async () => {
    const seen: string[][] = []
    const purger = new GatewayUserDataPurger(
      [
        {
          name: 'watches',
          purge: async () => {
            seen.push(await markers.list())
            return 0
          },
        },
      ],
      logger,
      markers,
    )

    await purger.purgeDeletedAccount(USER)

    expect(seen).toEqual([[USER]])
  })

  it('keeps the record when ONE store fails, purges the others, and tells the administrator how many are waiting', async () => {
    const tokens = flakyStore('tokens')
    const passwords = flakyStore('passwords')
    tokens.broken = true
    const purger = new GatewayUserDataPurger([tokens, passwords], logger, markers)

    const result = await purger.purgeDeletedAccount(USER)

    // The account is deleted and one store still holds its data. That is not
    // left unsaid: the other store WAS purged, the deletion stays on record,
    // the count is visible, and the log names the store.
    expect(result).toEqual({ stores: { tokens: 'failed', passwords: 1 }, removed: 1, failed: 1 })
    expect(passwords.purged).toEqual([USER])
    expect(await markers.list()).toEqual([USER])
    expect(await purger.pendingCount()).toBe(1)
    expect(logger.lines).toEqual([
      {
        level: 'warn',
        message: 'gateway user data purge incomplete after account deletion',
        meta: { userId: USER, removed: 1, failedStores: ['tokens'] },
      },
    ])
  })

  it('retries on the next sweep and clears the record once the failing store works again', async () => {
    const tokens = flakyStore('tokens')
    const passwords = flakyStore('passwords')
    tokens.broken = true
    const purger = new GatewayUserDataPurger([tokens, passwords], logger, markers)
    await purger.purgeDeletedAccount(USER)

    // Still broken: the sweep tries, fails, keeps the record and says so again.
    expect(await purger.sweep()).toEqual({ found: 1, completed: 0, stillPending: 1 })
    expect(await purger.pendingCount()).toBe(1)
    expect(logger.lines[logger.lines.length - 1]).toEqual({
      level: 'warn',
      message: 'gateway user data of deleted accounts is still waiting to be removed',
      meta: { waiting: 1, completed: 0 },
    })

    tokens.broken = false

    expect(await purger.sweep()).toEqual({ found: 1, completed: 1, stillPending: 0 })
    expect(tokens.purged).toEqual([USER])
    expect(await purger.pendingCount()).toBe(0)
    expect(await purger.sweep()).toEqual({ found: 0, completed: 0, stillPending: 0 })
  })

  it('counts a deletion as still waiting when its record could not be cleared, and says so', async () => {
    class StuckMarkers extends DeletedAccountMarkers {
      override async remove(): Promise<boolean> {
        return false
      }
    }
    const store = flakyStore('tokens')
    const stuck = new StuckMarkers(path.join(root, 'deleted-accounts'))
    const purger = new GatewayUserDataPurger([store], logger, stuck)
    await stuck.add(USER)

    expect(await purger.sweep()).toEqual({ found: 1, completed: 0, stillPending: 1 })

    // The data did go; what is left is the record, and that is reported, not hidden.
    expect(store.purged).toEqual([USER])
    expect(await purger.pendingCount()).toBe(1)
    expect(logger.lines[logger.lines.length - 1]).toEqual({
      level: 'warn',
      message: 'gateway user data of deleted accounts is still waiting to be removed',
      meta: { waiting: 1, completed: 0 },
    })
  })

  it('purges an account whose deletion never passed through the gateway, from the record auth wrote', async () => {
    const store = flakyStore('tokens')
    const purger = new GatewayUserDataPurger([store], logger, markers)
    const deletedOnTheCommandLine = '33333333-3333-4333-8333-333333333333'
    // What auth's deletion handler does, in another process.
    await new DeletedAccountMarkers(path.join(root, 'deleted-accounts')).add(deletedOnTheCommandLine)

    expect(await purger.sweep()).toEqual({ found: 1, completed: 1, stillPending: 0 })

    expect(store.purged).toEqual([deletedOnTheCommandLine])
    expect(await markers.list()).toEqual([])
  })

  it('does not purge an id that has no record', async () => {
    const store = flakyStore('tokens')
    const purger = new GatewayUserDataPurger([store], logger, markers)
    await fs.mkdir(path.join(root, 'deleted-accounts'), { recursive: true })
    await fs.writeFile(path.join(root, 'deleted-accounts', 'not-an-account-id'), '')
    await fs.writeFile(path.join(root, 'deleted-accounts', `${USER}.tmp`), '')

    expect(await purger.sweep()).toEqual({ found: 0, completed: 0, stillPending: 0 })
    expect(store.purged).toEqual([])
  })

  it('runs one sweep at a time', async () => {
    let running = 0
    let overlapped = false
    const slow: GatewayUserDataStore = {
      name: 'slow',
      purge: async () => {
        running += 1
        overlapped = overlapped || running > 1
        await new Promise((resolve) => setTimeout(resolve, 30))
        running -= 1
        return 0
      },
    }
    const purger = new GatewayUserDataPurger([slow], logger, markers)
    await markers.add(USER)

    const results = await Promise.all([purger.sweep(), purger.sweep(), purger.sweep()])

    expect(overlapped).toBe(false)
    expect(results).toEqual([
      { found: 1, completed: 1, stillPending: 0 },
      { found: 1, completed: 1, stillPending: 0 },
      { found: 1, completed: 1, stillPending: 0 },
    ])
  })

  describe('on a timer', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('sweeps shortly after start and then on the interval, until stopped', async () => {
      const purger = new GatewayUserDataPurger([], logger, markers)
      const sweep = jest.spyOn(purger, 'sweep').mockResolvedValue({ found: 0, completed: 0, stillPending: 0 })

      const stop = purger.startSweeping(60_000, 5_000)
      expect(sweep).toHaveBeenCalledTimes(0)
      jest.advanceTimersByTime(5_000)
      expect(sweep).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(60_000)
      expect(sweep).toHaveBeenCalledTimes(2)
      jest.advanceTimersByTime(120_000)
      expect(sweep).toHaveBeenCalledTimes(4)

      stop()
      jest.advanceTimersByTime(600_000)
      expect(sweep).toHaveBeenCalledTimes(4)
    })

    it('starts no timer where no record location is configured, or with no interval', () => {
      const unconfigured = new GatewayUserDataPurger([], logger)
      const sweepUnconfigured = jest.spyOn(unconfigured, 'sweep')
      const noInterval = new GatewayUserDataPurger([], logger, markers)
      const sweepNoInterval = jest.spyOn(noInterval, 'sweep')

      unconfigured.startSweeping(60_000, 0)()
      noInterval.startSweeping(0, 0)()
      jest.advanceTimersByTime(600_000)

      expect(sweepUnconfigured).not.toHaveBeenCalled()
      expect(sweepNoInterval).not.toHaveBeenCalled()
      expect(jest.getTimerCount()).toBe(0)
    })
  })

  describe('when the record itself cannot be used', () => {
    let blocked: DeletedAccountMarkers

    beforeEach(async () => {
      // A file sits where the directory should be: nothing can be recorded and
      // nothing can be listed. A directory owned by another user answers the same.
      const inTheWay = path.join(root, 'in-the-way')
      await fs.writeFile(inTheWay, 'x')
      blocked = new DeletedAccountMarkers(inTheWay)
    })

    it('says a failed purge will NOT be retried, instead of leaving it to look like the others', async () => {
      const tokens = flakyStore('tokens')
      tokens.broken = true
      const purger = new GatewayUserDataPurger([tokens], logger, blocked)

      const result = await purger.purgeDeletedAccount(USER)

      expect(result.failed).toBe(1)
      expect(logger.lines.map((line) => [line.level, line.message, line.meta])).toEqual([
        [
          'warn',
          'gateway user data purge incomplete after account deletion',
          { userId: USER, removed: 0, failedStores: ['tokens'] },
        ],
        ['warn', 'gateway user data purge will NOT be retried: the deletion could not be recorded', { userId: USER }],
      ])
    })

    it('says nothing of the kind when the purge succeeded, or when it failed and IS on record', async () => {
      const working = new GatewayUserDataPurger([flakyStore('tokens')], logger, blocked)
      await working.purgeDeletedAccount(USER)
      const tokens = flakyStore('tokens')
      tokens.broken = true
      await new GatewayUserDataPurger([tokens], logger, markers).purgeDeletedAccount(USER)

      expect(logger.lines.map((line) => line.message).filter((message) => message.includes('NOT be retried'))).toEqual(
        [],
      )
    })

    it('reports the number waiting as unknown, never as zero, and says so on every sweep', async () => {
      const purger = new GatewayUserDataPurger([flakyStore('tokens')], logger, blocked)

      expect(await purger.pendingCount()).toBeNull()
      expect(await purger.sweep()).toEqual({ found: 0, completed: 0, stillPending: 0 })
      expect(await purger.sweep()).toEqual({ found: 0, completed: 0, stillPending: 0 })

      expect(logger.lines).toEqual([
        {
          level: 'warn',
          message:
            'the record of deleted accounts cannot be read: gateway user data of deleted accounts is not being removed',
          meta: undefined,
        },
        {
          level: 'warn',
          message:
            'the record of deleted accounts cannot be read: gateway user data of deleted accounts is not being removed',
          meta: undefined,
        },
      ])
    })
  })

  describe('the purger a running gateway uses', () => {
    const deletedOnTheCommandLine = '44444444-4444-4444-8444-444444444444'

    it('reads the record auth writes beside the shared settings file', async () => {
      const settingsPath = path.join(root, 'server-settings.json')
      const store = flakyStore('tokens')
      // What auth does, given nothing but the same settings path.
      await new DeletedAccountMarkers(deletedAccountMarkersDirectory(settingsPath)).add(deletedOnTheCommandLine)

      const purger = startGatewayUserDataPurger({ stores: [store], logger, serverSettingsPath: settingsPath })

      expect(await purger.pendingCount()).toBe(1)
      expect(await purger.sweep()).toEqual({ found: 1, completed: 1, stillPending: 0 })
      expect(store.purged).toEqual([deletedOnTheCommandLine])
      expect(await fs.readdir(path.join(root, 'deleted-accounts'))).toEqual([])
    })

    it('is already sweeping: thirty seconds after start, then every minute', () => {
      jest.useFakeTimers()
      try {
        const purger = startGatewayUserDataPurger({
          stores: [],
          logger,
          serverSettingsPath: path.join(root, 'server-settings.json'),
        })
        const sweep = jest.spyOn(purger, 'sweep').mockResolvedValue({ found: 0, completed: 0, stillPending: 0 })

        jest.advanceTimersByTime(29_999)
        expect(sweep).toHaveBeenCalledTimes(0)
        jest.advanceTimersByTime(1)
        expect(sweep).toHaveBeenCalledTimes(1)
        jest.advanceTimersByTime(60_000 - 30_000 - 1)
        expect(sweep).toHaveBeenCalledTimes(1)
        jest.advanceTimersByTime(1)
        expect(sweep).toHaveBeenCalledTimes(2)
        jest.advanceTimersByTime(60_000)
        expect(sweep).toHaveBeenCalledTimes(3)
        jest.advanceTimersByTime(10 * 60_000)
        expect(sweep).toHaveBeenCalledTimes(13)
      } finally {
        jest.clearAllTimers()
        jest.useRealTimers()
      }
    })

    it('holds no timer where the deployment has no shared settings path', () => {
      jest.useFakeTimers()
      try {
        const purger = startGatewayUserDataPurger({ stores: [], logger, serverSettingsPath: undefined })
        const sweep = jest.spyOn(purger, 'sweep')

        jest.advanceTimersByTime(60 * 60 * 1000)

        expect(sweep).not.toHaveBeenCalled()
        expect(jest.getTimerCount()).toBe(0)
      } finally {
        jest.useRealTimers()
      }
    })
  })

  it('still purges, without a record, where no record location is configured', async () => {
    const store = flakyStore('tokens')
    const purger = new GatewayUserDataPurger([store], logger)

    expect((await purger.purgeDeletedAccount(USER)).removed).toBe(1)
    expect(await purger.pendingCount()).toBe(0)
    expect(await purger.sweep()).toEqual({ found: 0, completed: 0, stillPending: 0 })
  })
})
