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
import { GatewayUserDataPurger, GatewayUserDataStore, purgeGatewayUserDataAfterDeletion } from './GatewayUserDataPurger'

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
    return { purger: { purge } as unknown as GatewayUserDataPurger, purge }
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
    const purger = { purge: jest.fn().mockRejectedValue(new Error('disk full')) } as unknown as GatewayUserDataPurger

    await expect(
      purgeGatewayUserDataAfterDeletion(purger, { statusCode: 200, headersSent: true }, USER),
    ).resolves.toBeUndefined()
  })
})
