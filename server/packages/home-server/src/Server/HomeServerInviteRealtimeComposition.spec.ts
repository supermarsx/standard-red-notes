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
// C16: the single-container composition. Same three seams as the shared one,
// so a boot with no REDIS_HOST can be asserted without a real Redis double.
const mockInProcessDispatcher = { dispatch: jest.fn() }
const mockInProcessGatewayAdapter = { distribution: 'process', ready: jest.fn(() => true) }
const mockCreateInProcessInviteEventComposition = jest.fn(() => ({
  dispatcher: mockInProcessDispatcher,
  gatewayAdapter: mockInProcessGatewayAdapter,
}))
const mockInProcessAvailabilityClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
const mockInProcessAvailabilityInstances: Array<{ close: jest.Mock }> = []
const mockInviteBridgeStart = jest.fn()
const mockInviteBridgeClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
const mockCreateInviteRealtimeDomainEventBridge = jest.fn(() => ({
  start: mockInviteBridgeStart,
  close: mockInviteBridgeClose,
}))
const mockAvailabilityClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
const mockAvailabilityInstances: Array<{ close: jest.Mock; options: unknown }> = []
const mockInviteStoreInstances: Array<{ options: unknown }> = []

/**
 * The boot log's precondition diagnosis. Stubbed like every other collaborator
 * in this partial mock, but faithfully enough to pin the R28 seam: the gate
 * hands it `connectionTokenSecretPresent` computed from the USABLE length, and
 * this reflects that one bit back as the named code the log and the panel
 * carry. The resolution itself is covered where it lives, in api-gateway's
 * SyncWebSocketPreconditions spec.
 */
const mockResolveUnmetSyncPreconditions = jest.fn((state: { connectionTokenSecretPresent: boolean }) => {
  if (state.connectionTokenSecretPresent) {
    return []
  }
  return [{ code: 'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING', remedy: 'set it to at least 32 bytes' }]
})

const mockRedisInstances: RedisDouble[] = []
class RedisDouble {
  // ioredis reports 'ready' once connected; HomeServer waits (bounded) for it
  // before listening (C15), so the double is born ready.
  status = 'ready'
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

const mockWebSocketRedisBridgeInstances: Array<{
  close: jest.Mock<Promise<void>, []>
  connect: jest.Mock
  options: unknown
}> = []
class WebSocketRedisBridgeDouble {
  readonly close = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
  // Opened eagerly by HomeServer before listen (R10: no offline queue).
  readonly connect = jest.fn()
  readonly options: unknown

  constructor(_logger: unknown, _host: unknown, _port: unknown, options: unknown) {
    this.options = options
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
/**
 * The gate recorder the admin Diagnostics endpoint reads. Home server is a
 * SEPARATE boot path from the distributed gateway's bin/server.ts, so a recorder
 * wired only there would leave the single-container topology reporting "the gate
 * has not been recorded" forever — the useless non-answer that panel exists to
 * replace. Hoisted so the tests below can assert it was actually driven.
 */
const mockSyncGateDiagnostics = {
  record: jest.fn(),
  clear: jest.fn(),
  report: jest.fn(() => ({ recorded: false })),
}

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
  // The boot log's precondition diagnosis. Stubbed like every other collaborator
  // in this partial mock; the resolution itself is covered where it lives, in
  // api-gateway's SyncWebSocketPreconditions spec.
  describeUnmetSyncPreconditions: jest.fn(() => 'none'),
  resolveUnmetSyncPreconditions: (state: { connectionTokenSecretPresent: boolean }) =>
    mockResolveUnmetSyncPreconditions(state),
  syncGateDiagnostics: mockSyncGateDiagnostics,
  // The host-condition remedy table the gate copies its remedy from; the
  // report's own rendering of it is covered in SyncGateDiagnostics.spec.
  SYNC_HOST_REMEDIES: { WEBSOCKET_REDIS_NAMESPACE_INVALID: 'fix or unset WEBSOCKET_REDIS_NAMESPACE' },
  HOME_SERVER_WELCOME_HTML: '<p>home</p>',
  parseClientIpHeaderName: jest.fn(),
  parseOptionalPositiveInteger: jest.fn((_name: string, value: string | undefined, fallback: number) => {
    return value === undefined ? fallback : Number(value)
  }),
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
    readonly options: unknown

    constructor(_publisher: unknown, _subscriber: unknown, options: unknown) {
      this.options = options
      mockAvailabilityInstances.push(this)
    }
  },
  RedisInviteEventStore: class {
    readonly options: unknown

    constructor(_redis: unknown, options: unknown) {
      this.options = options
      mockInviteStoreInstances.push(this)
    }
  },
  InMemoryInviteEventStore: class {
    readonly options: unknown

    constructor(options: unknown) {
      this.options = options
      mockInviteStoreInstances.push(this)
    }
  },
  InProcessInviteEventAvailabilityBus: class {
    readonly close = mockInProcessAvailabilityClose

    constructor() {
      mockInProcessAvailabilityInstances.push(this)
    }
  },
  createInviteRealtimeDomainEventBridge: (...args: unknown[]) => mockCreateInviteRealtimeDomainEventBridge(...args),
  createInProcessInviteEventComposition: (...args: unknown[]) => mockCreateInProcessInviteEventComposition(...args),
  createLoggerSyncCommandMetrics: jest.fn(() => ({})),
  createRedisSyncState: jest.fn(() => ({})),
  createSharedInviteEventComposition: (...args: unknown[]) => mockCreateSharedInviteEventComposition(...args),
  // Used by WebSocketInProcessBridge, which this composition constructs when
  // there is no Redis; both are covered for real in their own specs.
  createLogThrottle: jest.fn(() => ({ consider: () => ({ emit: true, suppressed: 0 }) })),
  domainEventToDispatch: jest.fn(() => null),
  createSyncFilesTokenDecoder: (secret: string) => mockCreateSyncFilesTokenDecoder(secret),
  // C8 parsers, stubbed as pass-throughs; their rules are covered in the gateway.
  parseConnectionTokenTtl: jest.fn((value: string | undefined) => value ?? '60s'),
  parseMaxConnectionsPerUser: jest.fn((value: string | undefined) => (value === undefined ? undefined : Number(value))),
  // C10 rule double (the real one is exercised by the integration spec's
  // parser tests): same accept set as the gateway, throws otherwise.
  WEBSOCKET_MESSAGES_CHANNEL: 'websocket-messages',
  applyRedisNamespace: jest.fn((namespace: string | undefined, original: string) => {
    if (namespace === undefined || namespace === '') {
      return original
    }
    if (!/^[a-z0-9:_-]{1,64}$/u.test(namespace) || namespace.startsWith(':') || namespace.endsWith(':')) {
      throw new Error('WEBSOCKET_REDIS_NAMESPACE must match ^[a-z0-9:_-]{1,64}$ with no leading or trailing colon.')
    }
    return `${namespace}:${original}`
  }),
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
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
    // >= 32 bytes: the USABLE length the sync lane's invite-cursor codec
    // requires (R28). The short-secret case has its own test below.
    WEB_SOCKET_CONNECTION_TOKEN_SECRET: 'connection-secret-with-at-least-32-bytes',
  },
}
const SHORT_CONNECTION_TOKEN_SECRET = 'sixteen-byte-key'

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
    mockInviteStoreInstances.length = 0
    mockInProcessAvailabilityInstances.length = 0
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
    // C7: same-origin browser upgrades are always admitted; the explicit
    // origin list (empty here) stays additive.
    expect(attachOptions.sync.allowSameOrigin).toBe(true)
    // N22: the panel's `gatewayAttached` comes from the ATTACH OUTCOME. The
    // gate records `false` first (nothing attached yet) and re-records `true`
    // only after attach() returned.
    const recordCalls = mockSyncGateDiagnostics.record.mock.calls.map(([observation]) => observation)
    expect(recordCalls[0]).toMatchObject({ gatewayAttached: false })
    expect(recordCalls.at(-1)).toMatchObject({ gatewayAttached: true, connectionTokenSecretPresent: true })
    // R10: the push bridge is opened before the listener, not on the first push.
    const bridge = latest(mockWebSocketRedisBridgeInstances)
    expect(bridge.connect).toHaveBeenCalledTimes(1)
    const listenOrder = latest(mockHttpServers).listen.mock.invocationCallOrder[0]
    expect(bridge.connect.mock.invocationCallOrder[0]).toBeLessThan(listenOrder)
    // C10 without a namespace: byte-identical names everywhere.
    expect(bridge.options).toEqual({ namespace: undefined })
    expect(attachOptions.config.redisNamespace).toBeUndefined()
    expect(latest(mockInviteStoreInstances).options).toEqual({
      cursorSecret: configuration.environment.WEB_SOCKET_CONNECTION_TOKEN_SECRET,
      namespace: undefined,
    })
    expect(latest(mockAvailabilityInstances).options).toEqual({ namespace: undefined })

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

  /**
   * R28, pinned on the boot path. A secret under 32 bytes used to pass the
   * presence-only gate, log "preconditions are satisfied", and then take the
   * whole process down inside RedisInviteEventStore with a message the
   * redacting logger strips. Now: the boot succeeds, the legacy lane attaches
   * (token minting, `/sockets?authToken=`), the sync lane is not built, no
   * invite store is constructed, and the log + the gate record NAME the cause.
   */
  it('boots on a short secret with the legacy lane only and names WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING', async () => {
    const server = createServer()

    const result = await server.start({
      ...configuration,
      environment: { ...configuration.environment, WEB_SOCKET_CONNECTION_TOKEN_SECRET: SHORT_CONNECTION_TOKEN_SECRET },
    })

    expect(result.isFailed()).toBe(false)
    expect(mockResolveUnmetSyncPreconditions).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTokenSecretPresent: false, redisBound: true, webSocketSyncEnabled: true }),
    )
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('WebSocket sync is UNAVAILABLE'), {
      unmetPreconditions: ['WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING'],
    })
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'WebSocket sync preconditions are satisfied; the realtime transport will be advertised.',
    )
    // Legacy lane attached with the secret it was given; no sync lane.
    const attachOptions = latest(mockWebSocketRuntimeInstances).attach.mock.calls[0][0]
    expect(attachOptions.sync).toBeUndefined()
    expect(attachOptions.config.connectionTokenSecret).toBe(SHORT_CONNECTION_TOKEN_SECRET)
    expect(mockInviteStoreInstances).toHaveLength(0)
    expect(mockAvailabilityInstances).toHaveLength(0)
    expect(mockCreateInviteRealtimeDomainEventBridge).not.toHaveBeenCalled()
    // Only the gateway's own Redis client is created by the (doubled) runtime;
    // HomeServer itself opens no sync-state client for a lane it did not build.
    expect(mockRedisInstances).toHaveLength(0)
    const recorded = mockSyncGateDiagnostics.record.mock.calls.at(-1)?.[0]
    expect(recorded).toMatchObject({ connectionTokenSecretPresent: false, gatewayAttached: true })
    expect(latest(mockHomeRuntimeInstances).start).toHaveBeenCalledTimes(1)

    await server.stop()
  })

  it('threads WEBSOCKET_REDIS_NAMESPACE to the push bridge, the gateway, the invite store and the availability bus', async () => {
    const server = createServer()

    const result = await server.start({
      ...configuration,
      environment: { ...configuration.environment, WEBSOCKET_REDIS_NAMESPACE: '  tenant-a  ' },
    })

    expect(result.isFailed()).toBe(false)
    expect(latest(mockWebSocketRedisBridgeInstances).options).toEqual({ namespace: 'tenant-a' })
    const attachOptions = latest(mockWebSocketRuntimeInstances).attach.mock.calls[0][0]
    expect(attachOptions.config.redisNamespace).toBe('tenant-a')
    expect(latest(mockInviteStoreInstances).options).toEqual({
      cursorSecret: configuration.environment.WEB_SOCKET_CONNECTION_TOKEN_SECRET,
      namespace: 'tenant-a',
    })
    expect(latest(mockAvailabilityInstances).options).toEqual({ namespace: 'tenant-a' })

    await server.stop()
  })

  it('boots without realtime on an invalid WEBSOCKET_REDIS_NAMESPACE and names it, touching no shared Redis name', async () => {
    const server = createServer()

    const result = await server.start({
      ...configuration,
      environment: { ...configuration.environment, WEBSOCKET_REDIS_NAMESPACE: 'Tenant A' },
    })

    expect(result.isFailed()).toBe(false)
    expect(latest(mockHomeRuntimeInstances).start).toHaveBeenCalledTimes(1)
    // Nothing attached, nothing built: the invalid value must not fall back to
    // the un-namespaced channels of a sibling stack.
    expect(latest(mockWebSocketRuntimeInstances).attach).not.toHaveBeenCalled()
    expect(mockInviteStoreInstances).toHaveLength(0)
    expect(mockAvailabilityInstances).toHaveLength(0)
    expect(mockRedisInstances).toHaveLength(0)
    const bridgeOptions = latest(mockWebSocketRedisBridgeInstances).options as { namespace?: string; disabledReason?: string }
    expect(bridgeOptions.namespace).toBeUndefined()
    expect(bridgeOptions.disabledReason).toContain('WEBSOCKET_REDIS_NAMESPACE_INVALID')
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('WEBSOCKET_REDIS_NAMESPACE_INVALID'), {
      unmetPreconditions: ['WEBSOCKET_REDIS_NAMESPACE_INVALID'],
    })
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('Tenant A')
    // The verdict reaches the diagnostics record as a literal key, so the
    // admin panel names it (the report closes the lane on it and lists it).
    const recorded = mockSyncGateDiagnostics.record.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(recorded).toMatchObject({
      gatewayAttached: false,
      redisBound: true,
      connectionTokenSecretPresent: true,
      hostUnmetCondition: 'WEBSOCKET_REDIS_NAMESPACE_INVALID',
    })
    expect(JSON.stringify(recorded)).not.toContain('Tenant A')

    await server.stop()
  })

  it('records no host condition when the namespace is valid or unset', async () => {
    for (const environment of [configuration.environment, { ...configuration.environment, WEBSOCKET_REDIS_NAMESPACE: 'ok' }]) {
      mockSyncGateDiagnostics.record.mockClear()
      const server = createServer()

      const result = await server.start({ ...configuration, environment })

      expect(result.isFailed()).toBe(false)
      for (const [observation] of mockSyncGateDiagnostics.record.mock.calls) {
        expect(Object.keys(observation as Record<string, unknown>)).not.toContain('hostUnmetCondition')
      }
      await server.stop()
    }
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
    mockAvailabilityInstances.length = 0
    mockHomeRuntimeInstances.length = 0
    mockHttpServers.length = 0
    mockInviteStoreInstances.length = 0
    mockInProcessAvailabilityInstances.length = 0
    mockRedisInstances.length = 0
    mockServiceContainerInstances.length = 0
    mockWebSocketRedisBridgeInstances.length = 0
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
    latest(mockServiceContainerInstances).register(
      { value: 'Auth' },
      {
        handleRequest: jest.fn(async () => ({
          statusCode: 200,
          json: { valetToken: JSON.stringify({ secret: 'wrong-secret', claims: {} }) },
        })),
      },
    )

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

  /**
   * The single-container topology, pinned. The admin Diagnostics panel reads the
   * gate verdict out of this recorder; if HomeServer never drives it, the panel
   * reports "the gate has not been recorded" on every home-server deployment
   * while the build, the endpoint and every api-gateway test stay green. The
   * assertion is on the OBSERVATION, not the render, because that is the seam
   * that differs between the two boot paths.
   */
  it('records the gate verdict, so the admin diagnostics panel works on a single-container deployment', async () => {
    mockSyncGateDiagnostics.record.mockClear()
    const { server } = await startWithFiles({})

    expect(mockSyncGateDiagnostics.record).toHaveBeenCalled()
    const recorded = mockSyncGateDiagnostics.record.mock.calls.at(-1)?.[0] as Record<string, unknown>
    // The durable backend is in-process here, so that condition is satisfied by
    // construction rather than by configuration. `gatewayAttached` is the
    // attach OUTCOME (N22), re-recorded after attach() returned.
    expect(recorded).toMatchObject({
      syncingServerGrpcBound: true,
      connectionTokenSecretPresent: true,
      gatewayAttached: true,
    })
    // Presence only: every recorded field is a boolean or a literal key, never a
    // configured value. This is the structural guarantee the endpoint relies on.
    // Two literal shapes exist: the SCREAMING_CASE condition codes, and C16's
    // lower-case plane names (`redis` / `in-process` / `none`), which are the
    // same spellings `GatewayHealth.pushBridge` uses on the wire. Both are
    // compile-time constants; neither can carry a host, URL or secret.
    for (const [key, value] of Object.entries(recorded)) {
      expect({ key, safe: typeof value === 'boolean' || typeof value === 'string' }).toEqual({ key, safe: true })
      if (typeof value === 'string') {
        expect(value).toMatch(/^([A-Z0-9_]+|redis|in-process|none)$/)
      }
    }
    // C16: which plane the attach used is recorded too, so the panel can say
    // whether this deployment needs a Redis at all. This fixture configures
    // one; the no-Redis verdict is pinned in HomeServerWebSocketRuntime.
    expect(recorded.sharedState).toBe('redis')

    await server.stop()
  })

  /**
   * D1/C16, pinned at the composition root. Without a REDIS_HOST this boot
   * attached NO gateway at all, so the single container and the LXC image
   * shipped with no push, no live collaboration, no realtime invites and no
   * push-MFA. It now attaches the in-process plane, and the assertions below
   * are the seams that must not quietly revert to the Redis ones.
   */
  it('attaches the in-process realtime plane when no Redis is configured', async () => {
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
        REDIS_HOST: '',
      },
    })

    expect(result.isFailed()).toBe(false)
    const attachOptions = latest(mockWebSocketRuntimeInstances).attach.mock.calls[0][0]
    expect(attachOptions.sharedState).toBe('in-process')
    expect(attachOptions.config.redisHost).toBeUndefined()
    // The lane is BUILT, not merely attached: tickets, collaboration, API RPC
    // and invite events all negotiate on a deployment with no Redis.
    expect(attachOptions.sync).toBeDefined()
    expect(attachOptions.sync.requireSharedState).toBe(false)
    expect(attachOptions.sync.inviteEvents).toBe(mockInProcessGatewayAdapter)
    expect(mockCreateInProcessInviteEventComposition).toHaveBeenCalledTimes(1)
    expect(mockCreateSharedInviteEventComposition).not.toHaveBeenCalled()
    expect(mockInProcessAvailabilityInstances).toHaveLength(1)
    // Not one ioredis client is constructed for the realtime path.
    expect(mockRedisInstances).toHaveLength(0)
    // The push domain event now has a listener again: the in-process bridge is
    // registered alongside the (self-disabling) Redis one.
    expect(latest(mockDirectCallPublisherInstances).register).toHaveBeenCalledTimes(2)
    // And the gate the admin panel reads says so, with no REDIS_UNBOUND.
    const recorded = mockSyncGateDiagnostics.record.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(recorded).toMatchObject({ sharedState: 'in-process', redisBound: false, gatewayAttached: true })

    await server.stop()
    expect(mockInProcessAvailabilityClose).toHaveBeenCalled()
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
