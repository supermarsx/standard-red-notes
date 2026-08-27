import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import WebSocket from 'ws'

vi.mock('ioredis', () => ({
  Redis: class {
    on(): this {
      return this
    }
    subscribe(_channel: string, callback: (error: null, count: number) => void): void {
      callback(null, 1)
    }
    async quit(): Promise<void> {}
    disconnect(): void {}
  },
}))

import {
  attachWebSocketGateway,
  type GatewayConfig,
  type SyncGatewayOptions,
  type SyncUnavailabilityReason,
} from '../src/gateway.js'

// Distinctive values on purpose: a fixture whose text also appears in a header
// NAME (e.g. 'internal-secret' inside 'x-internal-secret') would make the
// no-secrets-in-logs assertions fail for a reason that is not a leak.
const CONNECTION_SECRET = 'fixture-connection-Zq7'
const INTERNAL_SECRET = 'fixture-internal-Kp2'
const AUTH_SECRET = 'fixture-auth-Vw9'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function baseConfig(): GatewayConfig {
  return {
    connectionTokenSecret: CONNECTION_SECRET,
    connectionTokenTtl: '60s',
    internalSecret: INTERNAL_SECRET,
    authJwtSecret: AUTH_SECRET,
    redisHost: '127.0.0.1',
    redisPort: 6379,
  }
}

function syncOptions(overrides: Partial<SyncGatewayOptions> = {}): SyncGatewayOptions {
  return {
    isEnabled: () => true,
    allowedOrigins: ['https://app.example.test'],
    authorization: { ready: () => true, authorize: vi.fn(async () => ({ authorized: true as const })) },
    backend: {
      ready: () => true,
      execute: vi.fn(async (input: { digest: string }) => ({ digest: input.digest, payload: { ok: true } })),
      status: vi.fn(async (input: { digest: string }) => ({ status: 'UNKNOWN' as const, digest: input.digest })),
    },
    ...overrides,
  } as SyncGatewayOptions
}

function fakeResponse(): { res: ServerResponse; status: () => number; body: () => unknown } {
  const captured: { statusCode?: number; chunks: string[] } = { chunks: [] }
  const res = {
    writeHead(statusCode: number) {
      captured.statusCode = statusCode
      return this
    },
    end(chunk?: string) {
      if (chunk !== undefined) {
        captured.chunks.push(chunk)
      }
    },
  } as unknown as ServerResponse

  return { res, status: () => captured.statusCode as number, body: () => JSON.parse(captured.chunks.join('')) }
}

function fakeRequest(headers: Record<string, unknown>, rawBody?: string): IncomingMessage {
  const stream = rawBody === undefined ? new Readable({ read() {} }) : Readable.from([rawBody])
  return Object.assign(stream, { headers, destroy: vi.fn(stream.destroy.bind(stream)) }) as unknown as IncomingMessage
}

let httpServer: Server | undefined
let attached: ReturnType<typeof attachWebSocketGateway> | undefined
let port: number

async function attach(sync?: SyncGatewayOptions, logger = makeLogger()): Promise<typeof logger> {
  httpServer = createServer()
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
  port = (httpServer.address() as AddressInfo).port
  attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger, sync })
  return logger
}

afterEach(async () => {
  await attached?.stop()
  attached = undefined
  await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()))
  httpServer = undefined
})

/** Every warn call flattened, so an assertion cannot miss a leak in an argument. */
function emitted(logger: ReturnType<typeof makeLogger>): string {
  return JSON.stringify(logger.warn.mock.calls)
}

describe('sync unavailability reasons', () => {
  it('reports sync-not-configured when the lane was never composed', async () => {
    await attach(undefined)

    expect(attached!.sync.unavailabilityReasons?.()).toEqual(['sync-not-configured'])
    expect(attached!.sync.capabilities()).toEqual({ capabilities: [] })
  })

  it('names EVERY unmet clause rather than the first', async () => {
    await attach(
      syncOptions({
        isEnabled: () => false,
        allowedOrigins: [],
      }),
    )

    expect(attached!.sync.unavailabilityReasons?.()).toEqual<SyncUnavailabilityReason[]>([
      'disabled-by-configuration',
      'no-allowed-origins',
    ])
  })

  it('does NOT close the lane for an unready durable backend', async () => {
    // The durable backend is a dependency of SYNC_ITEMS alone. Treating it as a
    // lane precondition is what let one unmet server-to-server dependency shut
    // the socket and take AUTHORIZE_COLLABORATION, API_RPC, STREAM_ASSISTANT,
    // INVITE_EVENTS and FILES_V1 -- none of which touch it -- down with it.
    await attach(
      syncOptions({
        backend: {
          ready: () => false,
          execute: vi.fn(),
          status: vi.fn(),
        } as unknown as SyncGatewayOptions['backend'],
      }),
    )

    expect(attached!.sync.unavailabilityReasons?.()).toEqual([])
    expect(attached!.sync.capabilities()).toEqual({
      capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }],
    })
  })

  it('uses an authorization adapter’s narrower session readiness when it has one', async () => {
    // The api-gateway adapter implements both the authorization and the backend
    // role on one object. Before it could report them separately, an unset
    // SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET made the SESSION plane look dead
    // and closed the socket even with the gRPC proxy bound -- a second,
    // independent way to lose every lane.
    const authorization = {
      ready: () => false,
      sessionAuthorizationReady: () => true,
      authorize: vi.fn(),
    } as unknown as SyncGatewayOptions['authorization']
    await attach(syncOptions({ authorization }))

    expect(attached!.sync.unavailabilityReasons?.()).toEqual([])
  })

  it('falls back to ready() for an authorization adapter that does not distinguish the two', async () => {
    const authorization = {
      ready: () => false,
      authorize: vi.fn(),
    } as unknown as SyncGatewayOptions['authorization']
    await attach(syncOptions({ authorization }))

    expect(attached!.sync.unavailabilityReasons?.()).toEqual<SyncUnavailabilityReason[]>([
      'authorization-adapter-unavailable',
    ])
  })

  it('reports availability as an empty reason list', async () => {
    await attach(syncOptions())

    expect(attached!.sync.unavailabilityReasons?.()).toEqual([])
    expect(attached!.sync.capabilities().capabilities).toHaveLength(1)
  })
})

describe('sync refusal logging', () => {
  // The regression guard: a 503 that does not say WHICH precondition failed is
  // the thing that made this undiagnosable from the server side.
  it('names the unmet precondition when a sync ticket is refused', async () => {
    const logger = await attach(syncOptions({ isEnabled: () => false }))
    const { res, status } = fakeResponse()

    attached!.handleSyncTicket(fakeRequest({}, JSON.stringify({ deviceId: 'device-1' })), res)
    await new Promise((resolve) => setImmediate(resolve))

    expect(status()).toBe(503)
    expect(logger.warn).toHaveBeenCalled()
    expect(emitted(logger)).toContain('disabled-by-configuration')
  })

  // Three completely different fixes used to share one log line reading only
  // "[ws-sync] connection rejected".
  it.each([
    ['/sockets/sync?token=leaked', { origin: 'https://app.example.test' }, 'query-string-not-permitted'],
    ['/sockets/sync', { origin: 'https://evil.example.test' }, 'origin-not-allowed'],
  ])('names why a sync upgrade was rejected (%s)', async (path, headers, expectedRejection) => {
    const logger = await attach(syncOptions())
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })

    await new Promise<void>((resolve) => socket.once('close', () => resolve()))

    expect(emitted(logger)).toContain(expectedRejection)
    // The attacker-controlled Origin itself is never echoed into the log.
    expect(emitted(logger)).not.toContain('evil.example.test')
    expect(emitted(logger)).not.toContain('leaked')
  })

  it('throttles a refusal storm to one line and reports the suppressed count', async () => {
    const logger = await attach(syncOptions({ isEnabled: () => false }))

    for (let attempt = 0; attempt < 40; attempt += 1) {
      attached!.sync.capabilities()
    }

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(emitted(logger)).toContain('suppressedSinceLastLog')
  })

  it('never emits a secret, token or user identifier in a refusal line', async () => {
    const logger = await attach(syncOptions({ isEnabled: () => false }))
    const { res } = fakeResponse()

    attached!.handleSyncTicket(
      fakeRequest(
        { 'x-auth-token': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', 'x-internal-secret': INTERNAL_SECRET },
        JSON.stringify({ deviceId: 'device-1', userUuid: 'user-uuid-1' }),
      ),
      res,
    )
    await new Promise((resolve) => setImmediate(resolve))

    const lines = emitted(logger)
    for (const secret of [CONNECTION_SECRET, INTERNAL_SECRET, AUTH_SECRET, 'eyJhbGciOiJIUzI1NiJ9', 'user-uuid-1']) {
      expect(lines).not.toContain(secret)
    }
  })
})

describe('token mint refusal logging', () => {
  it('distinguishes an unconfigured internal secret from a mismatched one', async () => {
    const logger = makeLogger()
    httpServer = createServer()
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
    attached = attachWebSocketGateway({
      httpServer,
      config: { ...baseConfig(), internalSecret: '' },
      logger,
    })

    const { res, status } = fakeResponse()
    attached.handleMintToken(fakeRequest({}), res)

    expect(status()).toBe(503)
    expect(logger.warn.mock.calls[0][0]).toContain('WEBSOCKET_GATEWAY_INTERNAL_SECRET is not configured')
  })

  it('logs a mismatched internal secret without echoing either value', async () => {
    const logger = await attach()
    const { res, status } = fakeResponse()

    attached!.handleMintToken(fakeRequest({ 'x-internal-secret': 'wrong-secret-value' }), res)

    expect(status()).toBe(403)
    expect(logger.warn.mock.calls[0][0]).toContain('did not match WEBSOCKET_GATEWAY_INTERNAL_SECRET')
    expect(emitted(logger)).not.toContain('wrong-secret-value')
    expect(emitted(logger)).not.toContain(INTERNAL_SECRET)
  })

  it('says the auth secret is missing rather than blaming the presented token', async () => {
    const logger = makeLogger()
    httpServer = createServer()
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
    attached = attachWebSocketGateway({ httpServer, config: { ...baseConfig(), authJwtSecret: '' }, logger })

    const { res, status } = fakeResponse()
    attached.handleMintToken(fakeRequest({ 'x-auth-token': 'anything' }), res)

    expect(status()).toBe(401)
    expect(logger.warn.mock.calls[0][0]).toContain('AUTH_JWT_SECRET is not configured')
  })

  it('logs an unparseable mint body', async () => {
    const logger = await attach()
    const { res } = fakeResponse()
    const req = fakeRequest({ 'x-internal-secret': INTERNAL_SECRET }, '{ nope')

    attached!.handleMintToken(req, res)
    await new Promise((resolve) => req.once('end', () => setImmediate(resolve)))

    expect(logger.warn.mock.calls[0][0]).toContain('not valid JSON')
  })
})
