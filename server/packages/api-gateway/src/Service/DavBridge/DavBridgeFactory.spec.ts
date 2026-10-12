import { promises as fs } from 'fs'
import * as path from 'path'

import { ServerSettingsStore } from '../ServerSettings/ServerSettingsStore'
import { createDavBridgeService } from './DavBridgeFactory'
import { DavBridgeRefusal } from './DavBridgeRefusal'
import { DavBridgeService } from './DavBridgeService'
import {
  AttemptedConnection,
  caller,
  capturingLogger,
  FakeRemote,
  newUserUuid,
  recordingFactory,
  removeDirectory,
  resolver,
  temporaryDirectory,
  TEST_SERVER_KEY,
} from './DavBridgeTestKit.spec'

/**
 * The bridge as the gateway's container builds it: from environment variables.
 * Everything below the two network seams is the production wiring.
 */
describe('createDavBridgeService', () => {
  let directory: string
  let remote: FakeRemote
  let attempts: AttemptedConnection[]
  let logger: ReturnType<typeof capturingLogger>

  const build = (
    environment: Record<string, string>,
    serverKey: 'configured' | 'missing' = 'configured',
  ): DavBridgeService => {
    const recording = recordingFactory(remote)
    attempts = recording.attempts
    logger = capturingLogger()
    return createDavBridgeService({
      env: (name) => environment[name],
      workingDirectory: directory,
      serverSettingsStore: new ServerSettingsStore(path.join(directory, 'server-settings.json'), TEST_SERVER_KEY),
      encryptionKey: serverKey === 'configured' ? TEST_SERVER_KEY : undefined,
      logger,
      network: {
        resolveHost: resolver({
          'cloud.example.org': ['93.184.216.34'],
          'nextcloud.lan': ['192.168.1.20'],
          'self.lan': ['192.168.1.99'],
        }),
        requestFactory: recording.factory,
        resolveOwnServiceName: async () => [],
        ownInterfaceAddresses: () => ['192.168.1.99'],
      },
    })
  }

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

  const account = (url: string): Record<string, unknown> => ({ kind: 'caldav', url, username: 'alice', secret: 'pw' })

  beforeEach(async () => {
    directory = await temporaryDirectory('factory')
    remote = new FakeRemote()
    await remote.start()
  })

  afterEach(async () => {
    await remote.stop()
    await removeDirectory(directory)
  })

  it('is off with an empty environment', async () => {
    const service = build({})
    const user = caller(newUserUuid())

    expect(await service.config(user)).toMatchObject({ enabled: false, available: false, mode: 'relay' })
    expect((await refusalFrom(service.createAccount(user, account('https://cloud.example.org/')))).tag).toBe(
      'dav-bridge-disabled',
    )
  })

  it('is on with DAV_BRIDGE_ENABLED=true, for permitted users, and stores under the working directory by default', async () => {
    const service = build({ DAV_BRIDGE_ENABLED: 'true' })
    const user = caller(newUserUuid())

    const created = await service.createAccount(user, account('https://cloud.example.org/'))
    await service.relay(user, created.id, { method: 'PROPFIND', path: '/' })

    expect(attempts).toEqual([expect.objectContaining({ address: '93.184.216.34', method: 'PROPFIND' })])
    expect(await fs.readdir(path.join(directory, 'data', 'dav-bridge', 'accounts'))).toContain(`${user.userUuid}.json`)
    expect(
      (
        await refusalFrom(
          service.createAccount(caller(newUserUuid(), { permitted: false }), account('https://cloud.example.org/')),
        )
      ).tag,
    ).toBe('dav-bridge-not-allowed')
  })

  it('stores where DAV_BRIDGE_DATA_PATH says', async () => {
    const dataPath = path.join(directory, 'volume', 'dav')
    const service = build({ DAV_BRIDGE_ENABLED: 'true', DAV_BRIDGE_DATA_PATH: dataPath })
    const user = caller(newUserUuid())

    await service.createAccount(user, account('https://cloud.example.org/'))

    expect(await fs.readdir(path.join(dataPath, 'accounts'))).toContain(`${user.userUuid}.json`)
    await expect(fs.readdir(path.join(directory, 'data'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads the allow-all, origin list and account limit from the environment', async () => {
    const service = build({
      DAV_BRIDGE_ENABLED: 'true',
      DAV_BRIDGE_ALLOW_ALL_USERS: 'true',
      DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS: 'http://nextcloud.lan',
      DAV_BRIDGE_MAX_ACCOUNTS_PER_USER: '1',
    })
    const user = caller(newUserUuid(), { permitted: false })

    const created = await service.createAccount(user, account('http://nextcloud.lan/'))
    await service.relay(user, created.id, { method: 'PROPFIND', path: '/' })

    expect(attempts).toEqual([expect.objectContaining({ protocol: 'http:', address: '192.168.1.20' })])
    expect((await refusalFrom(service.createAccount(user, account('http://nextcloud.lan/')))).extra).toEqual({
      limit: 1,
    })
    expect((await service.adminView()).sources).toEqual({
      enabled: 'env',
      mode: 'default',
      allowAllUsers: 'env',
      allowedPrivateOrigins: 'env',
      maxAccountsPerUser: 'env',
    })
  })

  it('refuses to run in a mode it does not implement instead of running as relay', async () => {
    const service = build({ DAV_BRIDGE_ENABLED: 'true', DAV_BRIDGE_MODE: 'hub' })

    expect(
      (await refusalFrom(service.createAccount(caller(newUserUuid()), account('https://cloud.example.org/')))).tag,
    ).toBe('dav-bridge-mode-unsupported')
  })

  it('warns once at boot about malformed origins, saying how many and not what they were', () => {
    build({ DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS: 'http://ok.lan,http://Internal-Host/secret-path,db-prod:5432' })

    expect(logger.lines).toEqual([
      {
        level: 'warn',
        message: 'dav bridge ignored malformed allowed origins from the environment',
        meta: { ignored: 2 },
      },
    ])
    expect(logger.text()).not.toMatch(/Internal-Host|secret-path|db-prod/)
  })

  it('warns about a DAV_BRIDGE_MODE that is not a mode name, without echoing it', () => {
    build({ DAV_BRIDGE_MODE: 'relay && curl evil' })

    expect(logger.lines).toEqual([
      { level: 'warn', message: 'dav bridge ignored a malformed DAV_BRIDGE_MODE', meta: { reason: 'not-a-mode-name' } },
    ])
  })

  it('logs nothing at boot when the environment is well formed', () => {
    build({ DAV_BRIDGE_ENABLED: 'true', DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS: 'http://ok.lan', DAV_BRIDGE_MODE: 'relay' })

    expect(logger.lines).toEqual([])
  })

  it("adds the gateway's own PORT to the ports it will not connect to on this machine", async () => {
    const environment = {
      DAV_BRIDGE_ENABLED: 'true',
      DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS: 'http://self.lan:4321,http://self.lan:8080',
    }
    const user = caller(newUserUuid())

    // With PORT=4321 that port on this machine's own address is the gateway itself.
    const guarded = build({ ...environment, PORT: '4321' })
    expect((await refusalFrom(guarded.createAccount(user, account('http://self.lan:4321/')))).tag).toBe(
      'dav-address-not-allowed',
    )
    // The control: the same address on another port is something else on this machine.
    await guarded.createAccount(user, account('http://self.lan:8080/'))

    // And without that PORT, 4321 is just a port.
    const other = build(environment)
    await other.createAccount(caller(newUserUuid()), account('http://self.lan:4321/'))
  })

  it('reports that it cannot seal passwords when the server has no usable key', async () => {
    const service = build({ DAV_BRIDGE_ENABLED: 'true' }, 'missing')

    expect((await service.adminView()).secretStoreReady).toBe(false)
    expect(
      (await refusalFrom(service.createAccount(caller(newUserUuid()), account('https://cloud.example.org/')))).tag,
    ).toBe('dav-secret-store-unavailable')
  })
})
