import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}

const mockInviteDispatcher = { dispatch: jest.fn() }
const mockInviteGatewayAdapter = { ready: jest.fn(() => true) }
const mockCreateSharedInviteEventComposition = jest.fn(() => ({
  dispatcher: mockInviteDispatcher,
  gatewayAdapter: mockInviteGatewayAdapter,
}))
const mockInviteBridgeStart = jest.fn()
const mockInviteBridgeClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
const mockCreateInviteRealtimeDomainEventBridge = jest.fn(() => ({
  start: mockInviteBridgeStart,
  close: mockInviteBridgeClose,
}))
const mockAvailabilityClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
const mockAvailabilityInstances: Array<{ close: jest.Mock }> = []

const mockRedisInstances: RedisDouble[] = []
class RedisDouble {
  readonly on = jest.fn()
  readonly quit = jest.fn<Promise<string>, []>().mockResolvedValue('OK')
  readonly disconnect = jest.fn()
  readonly duplicate = jest.fn(() => new RedisDouble())

  constructor() {
    mockRedisInstances.push(this)
  }
}

/**
 * Test decoder seam: a "signed token" is the JSON `{ secret, claims }`, so the
 * spec can drive the real CanonicalHomeServerFileResourceAuthorizer without
 * pulling a JWT signer into the home-server package. A token minted under a
 * different secret still fails to decode, exactly as HS256 verification would.
 */
const mockCreateSyncFilesTokenDecoder = jest.fn((secret: string) => ({
  decodeToken: (token: string) => {
    try {
      const parsed = JSON.parse(token) as { secret?: string; claims?: unknown }
      return parsed.secret === secret ? parsed.claims : undefined
    } catch {
      return undefined
    }
  },
}))

const mockServiceContainerInstances: ServiceContainerDouble[] = []
class ServiceContainerDouble {
  private readonly services = new Map<string, unknown>()

  constructor() {
    mockServiceContainerInstances.push(this)
  }

  register = jest.fn((identifier: { value: string }, service: unknown) => {
    this.services.set(identifier.value, service)
  })

  get = jest.fn((identifier: { value: string }) => this.services.get(identifier.value))
}

const mockValidateSession = jest.fn()

const mockDirectCallPublisherInstances: Array<{ register: jest.Mock }> = []
class DirectCallDomainEventPublisherDouble {
  readonly register = jest.fn()

  constructor() {
    mockDirectCallPublisherInstances.push(this)
  }
}

const mockWebSocketRuntimeInstances: Array<{
  attach: jest.Mock
  stop: jest.Mock<Promise<void>, []>
}> = []
class SyncWebSocketRuntimeDouble {
  readonly attach = jest.fn()
  readonly stop = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)

  constructor() {
    mockWebSocketRuntimeInstances.push(this)
  }
}

type RuntimeStartOptions = {
  realtime?: { stop(): Promise<void> }
}
const mockHomeRuntimeInstances: HomeServerRuntimeDouble[] = []
class HomeServerRuntimeDouble {
  active = false
  options: RuntimeStartOptions | undefined

  constructor() {
    mockHomeRuntimeInstances.push(this)
  }

  isActive = jest.fn(() => this.active)
  isRunning = jest.fn(() => this.active)
  start = jest.fn(async (options: RuntimeStartOptions) => {
    this.options = options
    this.active = true
  })
  stop = jest.fn(async () => {
    await this.options?.realtime?.stop()
    this.active = false
  })
}

const mockWebSocketRedisBridgeInstances: Array<{ close: jest.Mock<Promise<void>, []> }> = []
class WebSocketRedisBridgeDouble {
  readonly close = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)

  constructor() {
    mockWebSocketRedisBridgeInstances.push(this)
  }
}

const mockHttpServers: Array<{
  keepAliveTimeout: number
  listen: jest.Mock
}> = []
const mockCreateHttpServer = jest.fn(() => {
  const server = {
    keepAliveTimeout: 0,
    listen: jest.fn().mockReturnThis(),
  }
  mockHttpServers.push(server)
  return server
})

const mockReadiness = { markReady: jest.fn(), markUnavailable: jest.fn() }
const mockTypes = {
  ApiGateway_AggregateReadinessService: Symbol('AggregateReadinessService'),
  ApiGateway_COLLABORATION_CAPABILITY_TTL: Symbol('CollaborationCapabilityTtl'),
  ApiGateway_EmailDeliveryRuntime: Symbol('EmailDeliveryRuntime'),
  ApiGateway_EndpointResolver: Symbol('EndpointResolver'),
  ApiGateway_IpAccessListStore: Symbol('IpAccessListStore'),
  ApiGateway_RateLimitMetricsStore: Symbol('RateLimitMetricsStore'),
  ApiGateway_ReadinessState: Symbol('ReadinessState'),
  ApiGateway_Redis: Symbol('Redis'),
  ApiGateway_ReminderDeliveryScheduler: Symbol('ReminderDeliveryScheduler'),
  ApiGateway_RequiredCrossServiceTokenMiddleware: Symbol('RequiredCrossServiceTokenMiddleware'),
  ApiGateway_ServerSettingsResolver: Symbol('ServerSettingsResolver'),
  ApiGateway_ServiceProxy: Symbol('ServiceProxy'),
  ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET: Symbol('ConnectionTokenSecret'),
}

class ServiceDouble {
  getContainer = jest.fn().mockResolvedValue(undefined)
  activatePremiumFeatures = jest.fn()
}

jest.mock('http', () => ({
  ...jest.requireActual<typeof import('http')>('http'),
  __esModule: true,
  createServer: (...args: unknown[]) => mockCreateHttpServer(...args),
}))

jest.mock('winston', () => ({
  loggers: {
    get: jest.fn(() => mockLogger),
    close: jest.fn(),
  },
}))

jest.mock('ioredis', () => ({
  __esModule: true,
  default: RedisDouble,
  Redis: RedisDouble,
}))

jest.mock('@standardnotes/domain-events-infra', () => ({
  DirectCallDomainEventPublisher: DirectCallDomainEventPublisherDouble,
}))

jest.mock('@standardnotes/api-gateway', () => ({
  Service: ServiceDouble,
  TYPES: mockTypes,
  CollaborationAuthorizationService: class {},
  DirectCallSyncCommandPort: class {},
  LoopbackSyncApiRpcAdapter: class {},
  SyncWebSocketCommandAdapter: class {},
  SyncWebSocketRuntime: SyncWebSocketRuntimeDouble,
  buildDefaultRateLimitRules: jest.fn(() => []),
  configureTrustProxy: jest.fn(),
  createAdminEmailDeliveryRouter: jest.fn(),
  createFallbackHandler: jest.fn(() => jest.fn()),
  createRateLimitMiddleware: jest.fn(() => jest.fn()),
  createSharedServerAccessKeyMiddleware: jest.fn(() => jest.fn()),
  decideCorsOrigin: jest.fn(() => ({ allow: true })),
  HOME_SERVER_WELCOME_HTML: '<p>home</p>',
  parseClientIpHeaderName: jest.fn(),
  parseOptionalPositiveInteger: jest.fn((_name: string, value: string | undefined, fallback: number) =>
    value === undefined ? fallback : Number(value),
  ),
  parseWebSocketSyncEnabled: jest.fn((value: string | undefined) => value === 'true'),
  registerCaldavRoutes: jest.fn(),
  RequiredCrossServiceTokenMiddleware: class {},
  resolveCorsStrictMode: jest.fn(() => true),
  resolveSharedServerAccessKeyConfig: jest.fn(() => ({})),
  resolveWebSocketSyncAllowedOrigins: jest.fn(() => []),
  startReminderDeliveryScheduler: jest.fn(() => false),
}))

jest.mock('@standard-red-notes/websocket-gateway', () => ({
  RedisInviteEventAvailabilityBus: class {
    readonly close = mockAvailabilityClose

    constructor(..._args: unknown[]) {
      mockAvailabilityInstances.push(this)
    }
  },
  RedisInviteEventStore: class {},
  createInviteRealtimeDomainEventBridge: (...args: unknown[]) => mockCreateInviteRealtimeDomainEventBridge(...args),
  createLoggerSyncCommandMetrics: jest.fn(() => ({})),
  createRedisSyncState: jest.fn(() => ({})),
  createSharedInviteEventComposition: (...args: unknown[]) => mockCreateSharedInviteEventComposition(...args),
  createSyncFilesTokenDecoder: (secret: string) => mockCreateSyncFilesTokenDecoder(secret),
}))

jest.mock('@standardnotes/domain-core', () => ({
  ...jest.requireActual<typeof import('@standardnotes/domain-core')>('@standardnotes/domain-core'),
  ServiceContainer: ServiceContainerDouble,
}))

jest.mock('@standardnotes/auth-server', () => ({ Service: ServiceDouble }))
jest.mock('@standardnotes/files-server', () => ({ Service: ServiceDouble }))
jest.mock('@standardnotes/revisions-server', () => ({ Service: ServiceDouble }))
jest.mock('@standardnotes/syncing-server', () => ({ Service: ServiceDouble }))

jest.mock('inversify', () => ({
  Container: class {
    isBound = jest.fn(() => false)
    get = jest.fn((token: symbol) => {
      if (token === mockTypes.ApiGateway_ReadinessState) {
        return mockReadiness
      }
      if (token === mockTypes.ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET) {
        return 'connection-secret'
      }
      if (token === mockTypes.ApiGateway_COLLABORATION_CAPABILITY_TTL) {
        return '30s'
      }
      if (token === mockTypes.ApiGateway_ServiceProxy) {
        return { validateSession: mockValidateSession }
      }
      return {}
    })
  },
}))

jest.mock('inversify-express-utils', () => ({
  InversifyExpressServer: class {
    setConfig = jest.fn()
    setErrorConfig = jest.fn()
    build = jest.fn(async () => ({ use: jest.fn() }))
  },
  sanitizeRequestUrlForLogging: jest.fn((url: string) => url),
}))

jest.mock('./HomeServerRuntime', () => ({ HomeServerRuntime: HomeServerRuntimeDouble }))
jest.mock('./WebSocketRedisBridge', () => ({ WebSocketRedisBridge: WebSocketRedisBridgeDouble }))

// Deliberately require after the dependency doubles are initialized. A static
// import is hoisted ahead of the captured class doubles by the Jest transform.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomeServer } = require('./HomeServer') as typeof import('./HomeServer')
type HomeServerInstance = InstanceType<typeof HomeServer>

const configuration = {
  dataDirectoryPath: 'test-data',
  environment: {
    AUTH_JWT_SECRET: 'auth-secret',
    REDIS_HOST: 'redis',
    REDIS_PORT: '6379',
    WEBSOCKET_GATEWAY_INTERNAL_SECRET: 'internal-secret',
    WEBSOCKET_SYNC_ENABLED: 'true',
    WEB_SOCKET_CONNECTION_TOKEN_SECRET: 'connection-secret',
  },
}

function latest<T>(values: T[]): T {
  const value = values.at(-1)
  if (value === undefined) {
    throw new Error('Expected a captured instance.')
  }
  return value
}

function createServer(): HomeServerInstance {
  const server = new HomeServer()
  ;(server as unknown as { configureLoggers: jest.Mock }).configureLoggers = jest.fn()
  return server
}

describe('HomeServer invite realtime composition', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAvailabilityInstances.length = 0
    mockDirectCallPublisherInstances.length = 0
    mockHomeRuntimeInstances.length = 0
    mockHttpServers.length = 0
    mockRedisInstances.length = 0
    mockServiceContainerInstances.length = 0
    mockWebSocketRedisBridgeInstances.length = 0
    mockWebSocketRuntimeInstances.length = 0
    mockInviteBridgeClose.mockResolvedValue(undefined)
    mockAvailabilityClose.mockResolvedValue(undefined)
    mockCreateHttpServer.mockImplementation(() => {
      const server = {
        keepAliveTimeout: 0,
        listen: jest.fn().mockReturnThis(),
      }
      mockHttpServers.push(server)
      return server
    })
  })

  it('registers the DirectCall bridge, wires its dispatcher, and closes bridge plus subscriber once on stop', async () => {
    const server = createServer()

    const result = await server.start(configuration)

    expect(result.isFailed()).toBe(false)
    const directCallPublisher = latest(mockDirectCallPublisherInstances)
    expect(mockCreateInviteRealtimeDomainEventBridge).toHaveBeenCalledWith({
      dispatcher: mockInviteDispatcher,
      directCallPublisher,
    })
    expect(mockInviteBridgeStart).toHaveBeenCalledTimes(1)

    const attachOptions = latest(mockWebSocketRuntimeInstances).attach.mock.calls[0][0]
    expect(attachOptions.sync.inviteEventDispatcher).toBe(mockInviteDispatcher)
    expect(attachOptions.sync.inviteEvents).toBe(mockInviteGatewayAdapter)

    const stopResult = await server.stop()
    expect(stopResult.isFailed()).toBe(false)
    expect(mockInviteBridgeClose).toHaveBeenCalledTimes(1)
    expect(mockAvailabilityClose).toHaveBeenCalledTimes(1)
    expect(mockRedisInstances).toHaveLength(2)
    expect(mockRedisInstances[1].quit).toHaveBeenCalledTimes(1)
    expect(mockRedisInstances[1].disconnect).not.toHaveBeenCalled()
  })

  it('closes the DirectCall bridge and dedicated Redis subscriber once when listener startup fails', async () => {
    mockCreateHttpServer.mockImplementationOnce(() => {
      const server = {
        keepAliveTimeout: 0,
        listen: jest.fn(() => {
          throw new Error('listen failed')
        }),
      }
      mockHttpServers.push(server)
      return server
    })
    const server = createServer()

    const result = await server.start(configuration)

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('listen failed')
    expect(mockInviteBridgeStart).toHaveBeenCalledTimes(1)
    expect(mockInviteBridgeClose).toHaveBeenCalledTimes(1)
    expect(mockAvailabilityClose).toHaveBeenCalledTimes(1)
    expect(mockRedisInstances).toHaveLength(2)
    expect(mockRedisInstances[1].quit).toHaveBeenCalledTimes(1)
    expect(mockRedisInstances[1].disconnect).not.toHaveBeenCalled()
    expect(latest(mockHomeRuntimeInstances).start).not.toHaveBeenCalled()
  })
})

describe('HomeServer FILES_V1 composition', () => {
  const uploadRoots: string[] = []

  const identity = {
    userUuid: 'user-1',
    sessionUuid: 'session-1',
    deviceId: 'device-1',
    authorization: 'Bearer live-session-credential',
  }
  const resource = { ownershipType: 'user' as const, remoteIdentifier: 'remote-1', fileUuid: 'file-1' }

  function crossServiceToken(): string {
    return JSON.stringify({
      secret: 'auth-secret',
      claims: {
        user: { uuid: identity.userUuid },
        session: { uuid: identity.sessionUuid },
        roles: [],
      },
    })
  }

  /** Canonical Auth valet-token use case double: echoes the requested grant. */
  function authServiceDouble() {
    return {
      handleRequest: jest.fn(async (request: unknown) => {
        const body = (
          request as {
            body: { operation: 'read' | 'write'; resources: Array<{ remoteIdentifier: string }> }
          }
        ).body
        return {
          statusCode: 200,
          json: {
            valetToken: JSON.stringify({
              secret: 'valet-secret',
              claims: {
                userUuid: identity.userUuid,
                permittedOperation: body.operation,
                permittedResources: body.resources,
                uploadBytesUsed: 0,
                uploadBytesLimit: -1,
              },
            }),
          },
        }
      }),
    }
  }

  async function startWithFiles(overrides: Record<string, string> = {}) {
    const uploadRoot = await fs.mkdtemp(join(tmpdir(), 'srn-home-files-'))
    uploadRoots.push(uploadRoot)
    mockValidateSession.mockResolvedValue({ status: 200, data: { authToken: crossServiceToken() } })
    const server = createServer()
    const result = await server.start({
      ...configuration,
      environment: {
        ...configuration.environment,
        FILE_UPLOAD_PATH: uploadRoot,
        VALET_TOKEN_SECRET: 'valet-secret',
        ...overrides,
      },
    })
    expect(result.isFailed()).toBe(false)
    const attachOptions = latest(mockWebSocketRuntimeInstances).attach.mock.calls[0][0]
    return { server, uploadRoot, files: attachOptions.sync?.files }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockHomeRuntimeInstances.length = 0
    mockHttpServers.length = 0
    mockRedisInstances.length = 0
    mockServiceContainerInstances.length = 0
    mockWebSocketRuntimeInstances.length = 0
    mockInviteBridgeClose.mockResolvedValue(undefined)
    mockAvailabilityClose.mockResolvedValue(undefined)
    mockCreateHttpServer.mockImplementation(() => {
      const httpServer = { keepAliveTimeout: 0, listen: jest.fn().mockReturnThis() }
      mockHttpServers.push(httpServer)
      return httpServer
    })
  })

  afterEach(async () => {
    await Promise.all(uploadRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('supplies a live adapter that completes an authorized upload/download round trip', async () => {
    const { server, files, uploadRoot } = await startWithFiles()

    expect(files).toBeDefined()
    expect(files.ready()).toBe(true)
    // The canonical authorizer resolves the Auth valet-token use case through
    // the same in-process service container the rest of the home server uses.
    latest(mockServiceContainerInstances).register({ value: 'Auth' }, authServiceDouble())

    const bytes = Uint8Array.from([9, 8, 7, 6, 5])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const signal = () => new AbortController().signal

    await expect(files.metadata({ identity, resources: [resource] }, signal())).resolves.toEqual([
      { resource, exists: false },
    ])

    const opened = await files.openUpload(
      {
        identity,
        descriptor: {
          ...resource,
          decryptedSize: bytes.byteLength,
          declaredSize: bytes.byteLength,
          mimeType: 'application/octet-stream',
        },
      },
      signal(),
    )
    await expect(
      files.uploadChunk(
        {
          identity,
          header: {
            kind: 'UPLOAD_CHUNK' as const,
            requestId: 'request-1',
            transferId: opened.transferId,
            generation: opened.generation,
            index: 0,
            offset: 0,
            declaredSize: bytes.byteLength,
            byteLength: bytes.byteLength,
            sha256,
            final: true,
          },
          bytes,
        },
        signal(),
      ),
    ).resolves.toMatchObject({ duplicate: false, nextOffset: bytes.byteLength })
    await expect(
      files.finishUpload(
        {
          identity,
          transferId: opened.transferId,
          generation: opened.generation,
          declaredSize: bytes.byteLength,
          sha256,
        },
        signal(),
      ),
    ).resolves.toEqual({ sha256 })

    const download = await files.openDownload({ identity, resource, offset: 0 }, signal())
    await expect(
      files.readDownloadChunk(
        {
          identity,
          transferId: download.transferId,
          generation: download.generation,
          index: 0,
          offset: 0,
          maxBytes: 64,
        },
        signal(),
      ),
    ).resolves.toMatchObject({ bytes, final: true })

    // Published under the canonical <root>/<ownerUuid>/<remoteIdentifier> layout
    // the files service reads from, not inside private transfer staging.
    await expect(fs.readFile(join(uploadRoot, identity.userUuid, resource.remoteIdentifier))).resolves.toEqual(
      Buffer.from(bytes),
    )

    await server.stop()
  })

  it('denies transfers whose valet grant is minted under a different secret', async () => {
    const { server, files } = await startWithFiles()
    latest(mockServiceContainerInstances).register({ value: 'Auth' }, {
      handleRequest: jest.fn(async () => ({
        statusCode: 200,
        json: { valetToken: JSON.stringify({ secret: 'wrong-secret', claims: {} }) },
      })),
    })

    await expect(
      files.openUpload(
        {
          identity,
          descriptor: {
            ...resource,
            decryptedSize: 5,
            declaredSize: 5,
            mimeType: 'application/octet-stream',
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' })

    await server.stop()
  })

  it('omits the adapter when the capability is switched off', async () => {
    const { server, files } = await startWithFiles({ WEBSOCKET_FILES_ENABLED: 'false' })

    expect(files).toBeUndefined()
    expect(mockLogger.info).toHaveBeenCalledWith('WebSocket FILES_V1 transport disabled by WEBSOCKET_FILES_ENABLED.')

    await server.stop()
  })

  it('omits the adapter, without failing sync startup, when the valet secret is missing', async () => {
    mockValidateSession.mockResolvedValue({ status: 200, data: { authToken: crossServiceToken() } })
    const server = createServer()

    const result = await server.start(configuration)

    expect(result.isFailed()).toBe(false)
    const attachOptions = latest(mockWebSocketRuntimeInstances).attach.mock.calls[0][0]
    expect(attachOptions.sync.files).toBeUndefined()
    expect(attachOptions.sync.inviteEvents).toBe(mockInviteGatewayAdapter)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'WebSocket FILES_V1 transport unavailable: FILE_UPLOAD_PATH, AUTH_JWT_SECRET and VALET_TOKEN_SECRET are required.',
    )

    await server.stop()
  })
})
