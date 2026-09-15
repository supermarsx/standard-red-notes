import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'

const redis = vi.hoisted(() => {
  const state = {
    quitCalls: 0,
    disconnectCalls: 0,
    quitRejects: false,
    evalCalls: 0,
    evalGate: undefined as Promise<void> | undefined,
    status: undefined as string | undefined,
    /** How many ioredis clients the attach constructed (0 proves no Redis). */
    constructed: 0,
  }

  class FakeRedisClient {
    constructor(readonly options: Record<string, unknown>) {
      state.constructed += 1
    }
    get status(): string | undefined {
      return state.status
    }
    on(): this {
      return this
    }
    subscribe(_channel: string, callback: (error: null, count: number) => void): void {
      callback(null, 1)
    }
    async eval(): Promise<number> {
      state.evalCalls += 1
      if (state.evalGate) {
        await state.evalGate
      }
      return 1
    }
    async pexpire(): Promise<number> {
      return 1
    }
    async publish(): Promise<number> {
      return 1
    }
    async quit(): Promise<void> {
      state.quitCalls += 1
      if (state.quitRejects) {
        throw new Error('connection already closed')
      }
    }
    disconnect(): void {
      state.disconnectCalls += 1
    }
  }

  return { state, FakeRedisClient }
})

vi.mock('ioredis', () => ({ Redis: redis.FakeRedisClient }))

import {
  attachWebSocketGateway,
  createLoggerSyncCommandMetrics,
  defaultRoomJoinAuthorizer,
  DEFAULT_WEBSOCKET_INGRESS_LIMITS,
  DEFAULT_WEBSOCKET_RELAY_BACKLOG_LIMITS,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  SyncUnavailableError,
  WebSocketIngressLimiter,
  WebSocketRelayBacklog,
  type GatewayConfig,
  type GatewayHealth,
  type SyncFilesAdapter,
  type SyncGatewayOptions,
} from '../src/gateway.js'
import { decodeFileBinaryFrame, encodeFileBinaryFrame, sha256Hex } from '../src/filesProtocol.js'
import { InMemorySyncAuthTicketStore, mintConnectionToken } from '../src/auth.js'
import { digestSyncCommandBody } from '../src/syncProtocol.js'
import { InMemorySyncCommandLeaseRegistry, InMemorySyncSocketBudget } from '../src/registry.js'
import { COLLABORATION_PROTOCOL_VERSION, type RoomJoinAuthorization } from '../src/rooms.js'

const CONNECTION_SECRET = 'connection-secret'
const AUTH_SECRET = 'auth-jwt-secret'
const INTERNAL_SECRET = 'internal-secret'
const ROOM_EPOCH = 'room_epoch_00000001'
const SECURITY_EPOCH = 'security_epoch_0001'

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    connectionTokenSecret: CONNECTION_SECRET,
    connectionTokenTtl: '60s',
    internalSecret: INTERNAL_SECRET,
    authJwtSecret: AUTH_SECRET,
    redisHost: '127.0.0.1',
    redisPort: 6379,
    ...overrides,
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Minimal ServerResponse double capturing what the mint handler writes. */
function fakeResponse(): { res: ServerResponse; status: () => number; body: () => unknown } {
  const captured: { statusCode?: number; headers?: unknown; chunks: string[] } = { chunks: [] }
  const res = {
    writeHead(statusCode: number, headers?: unknown) {
      captured.statusCode = statusCode
      captured.headers = headers

      return this
    },
    end(chunk?: string) {
      if (chunk !== undefined) {
        captured.chunks.push(chunk)
      }
    },
  } as unknown as ServerResponse

  return {
    res,
    status: () => captured.statusCode as number,
    body: () => JSON.parse(captured.chunks.join('')),
  }
}

/**
 * A request double: headers plus an optional raw body streamed on 'data'/'end'.
 * The peer defaults to a direct loopback caller, which is what the
 * internal-secret mint path requires; pass `remoteAddress` to model another.
 */
function fakeRequest(
  headers: Record<string, unknown>,
  rawBody?: string,
  peer: { remoteAddress?: string } = { remoteAddress: '127.0.0.1' },
): IncomingMessage {
  const stream = rawBody === undefined ? new Readable({ read() {} }) : Readable.from([rawBody])

  return Object.assign(stream, {
    headers,
    socket: peer,
    destroy: vi.fn(stream.destroy.bind(stream)),
  }) as unknown as IncomingMessage
}

/** Runs the mint handler against a request whose body arrives as a stream. */
async function mintWithStreamedBody(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  headers: Record<string, unknown>,
  rawBody: string,
): Promise<{ status: number; body: unknown }> {
  const { res, status, body } = fakeResponse()
  const req = fakeRequest(headers, rawBody)
  handler(req, res)
  await new Promise((resolve) => req.once('end', () => setImmediate(resolve)))

  return { status: status(), body: body() }
}

let httpServer: Server
let attached: ReturnType<typeof attachWebSocketGateway> | undefined

async function listen(): Promise<number> {
  httpServer = createServer()
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))

  return (httpServer.address() as AddressInfo).port
}

beforeEach(() => {
  redis.state.quitCalls = 0
  redis.state.disconnectCalls = 0
  redis.state.quitRejects = false
  redis.state.evalCalls = 0
  redis.state.evalGate = undefined
  redis.state.status = undefined
  redis.state.constructed = 0
})

afterEach(async () => {
  await attached?.stop()
  attached = undefined
  if (httpServer?.listening) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  }
  vi.clearAllMocks()
})

describe('attachWebSocketGateway configuration', () => {
  it('refuses to attach when the connection token secret is empty', async () => {
    await listen()

    expect(() =>
      attachWebSocketGateway({
        httpServer,
        config: baseConfig({ connectionTokenSecret: '' }),
        logger: makeLogger(),
      }),
    ).toThrow(/WEB_SOCKET_CONNECTION_TOKEN_SECRET is required/)
  })

  it('registers the mint endpoint on a supplied app in attached mode', async () => {
    await listen()
    const post = vi.fn()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      app: { post },
    })

    expect(post).toHaveBeenCalledWith('/sockets/tokens', attached.handleMintToken)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an invalid per-user connection ceiling (%s)',
    async (maxConnectionsPerUser) => {
      await listen()

      expect(() =>
        attachWebSocketGateway({
          httpServer,
          config: baseConfig(),
          logger: makeLogger(),
          maxConnectionsPerUser,
        }),
      ).toThrow(/positive safe integer/)
    },
  )

  it('does not register any route in standalone mode', async () => {
    await listen()
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger() })

    expect(typeof attached.handleMintToken).toBe('function')
    expect(attached.registry.size()).toBe(0)
  })

  it('starts the SQS consumer only when a queue url is configured', async () => {
    await listen()
    const logger = makeLogger()
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger })
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('[sqs] consuming'))

    await attached.stop()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig({ sqs: { queueUrl: 'https://sqs/q', endpoint: 'http://localstack:4566' } }),
      logger,
    })
    expect(logger.info).toHaveBeenCalledWith('[sqs] consuming https://sqs/q')
  })

  it('quits the redis client on stop, falling back to disconnect when quit rejects', async () => {
    await listen()
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger() })
    await attached.stop()
    expect(redis.state.quitCalls).toBe(3)
    expect(redis.state.disconnectCalls).toBe(0)

    redis.state.quitRejects = true
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger() })
    await attached.stop()
    expect(redis.state.quitCalls).toBe(6)
    expect(redis.state.disconnectCalls).toBe(3)
    attached = undefined
  })
})

describe('WebSocketIngressLimiter', () => {
  it('refills frame and byte budgets deterministically and caps accumulated credit', () => {
    let now = 0
    const limiter = new WebSocketIngressLimiter(
      {
        frameCapacity: 2,
        frameRefillPerSecond: 1,
        byteCapacity: 10,
        byteRefillPerSecond: 5,
      },
      () => now,
    )

    expect(limiter.tryConsume(6)).toBe(true)
    expect(limiter.tryConsume(4)).toBe(true)
    expect(limiter.tryConsume(1)).toBe(false)

    now = 1_000
    expect(limiter.tryConsume(5)).toBe(true)
    expect(limiter.tryConsume(1)).toBe(false)

    // A long idle period replenishes only to capacity, never beyond it.
    now = 100_000
    expect(limiter.tryConsume(6)).toBe(true)
    expect(limiter.tryConsume(4)).toBe(true)
    expect(limiter.tryConsume(1)).toBe(false)
  })
})

describe('WebSocketRelayBacklog', () => {
  it('tracks retained frames and bytes exactly, rejects either ceiling, and clears safely on close', () => {
    const backlog = new WebSocketRelayBacklog({ frameCapacity: 2, byteCapacity: 10 })

    expect(backlog.tryEnqueue(6)).toBe(true)
    expect(backlog.pending()).toEqual({ frames: 1, bytes: 6 })
    expect(backlog.tryEnqueue(5)).toBe(false)
    expect(backlog.pending()).toEqual({ frames: 1, bytes: 6 })
    expect(backlog.tryEnqueue(4)).toBe(true)
    expect(backlog.tryEnqueue(0)).toBe(false)
    expect(backlog.pending()).toEqual({ frames: 2, bytes: 10 })

    backlog.settle(6)
    expect(backlog.pending()).toEqual({ frames: 1, bytes: 4 })
    backlog.clear()
    expect(backlog.pending()).toEqual({ frames: 0, bytes: 0 })
    // A queued promise may settle after socket-close cleanup; accounting must
    // remain at zero rather than underflowing.
    backlog.settle(4)
    expect(backlog.pending()).toEqual({ frames: 0, bytes: 0 })
    expect(backlog.tryEnqueue(Number.NaN)).toBe(false)
  })
})

describe('defaultRoomJoinAuthorizer', () => {
  const authorizer = defaultRoomJoinAuthorizer(CONNECTION_SECRET)

  function capability(claims: Record<string, unknown>): string {
    return jwt.sign(claims, CONNECTION_SECRET, { algorithm: 'HS256', expiresIn: '60s' })
  }

  it('admits a capability minted for exactly this user and room', () => {
    const cap = capability({
      purpose: 'collab-room',
      userUuid: 'user-1',
      room: 'note-1',
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      collaborationAuthorizationIssuedAt: 1,
      serverUpdatedAtTimestamp: 1,
      roomEpoch: ROOM_EPOCH,
      collaborationSecurityEpoch: SECURITY_EPOCH,
    })
    expect(authorizer('user-1', 'note-1', cap)).toMatchObject({
      authorized: true,
      expiresAt: expect.any(Number),
      collaborationAuthorizationIssuedAt: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: ROOM_EPOCH,
      collaborationSecurityEpoch: SECURITY_EPOCH,
    })
  })

  it('denies a join with no capability at all', () => {
    expect(authorizer('user-1', 'note-1', undefined)).toEqual({ authorized: false })
  })

  it('denies a capability issued for a different room', () => {
    const cap = capability({ purpose: 'collab-room', userUuid: 'user-1', room: 'note-OTHER' })
    expect(authorizer('user-1', 'note-1', cap)).toEqual({ authorized: false })
  })

  it('denies a capability issued for a different user', () => {
    const cap = capability({ purpose: 'collab-room', userUuid: 'user-OTHER', room: 'note-1' })
    expect(authorizer('user-1', 'note-1', cap)).toEqual({ authorized: false })
  })

  it('denies a capability signed with the wrong secret', () => {
    const cap = jwt.sign({ purpose: 'collab-room', userUuid: 'user-1', room: 'note-1' }, 'other-secret', {
      algorithm: 'HS256',
    })
    expect(authorizer('user-1', 'note-1', cap)).toEqual({ authorized: false })
  })
})

describe('POST /sockets/tokens', () => {
  let handleMintToken: (req: IncomingMessage, res: ServerResponse) => void
  let logger: ReturnType<typeof makeLogger>

  async function attachWith(config: GatewayConfig): Promise<void> {
    await listen()
    logger = makeLogger()
    attached = attachWebSocketGateway({ httpServer, config, logger })
    handleMintToken = attached.handleMintToken
  }

  it('mints a token for a valid forwarded x-auth-token', async () => {
    await attachWith(baseConfig())
    const authToken = jwt.sign({ user: { uuid: 'user-1' }, session: { uuid: 'session-1' } }, AUTH_SECRET, {
      algorithm: 'HS256',
      expiresIn: '60s',
    })

    const { res, status, body } = fakeResponse()
    handleMintToken(fakeRequest({ 'x-auth-token': authToken }), res)

    expect(status()).toBe(200)
    const minted = (body() as { token: string }).token
    expect(jwt.verify(minted, CONNECTION_SECRET)).toMatchObject({ userUuid: 'user-1', sessionUuid: 'session-1' })
    expect(logger.info).toHaveBeenCalledWith('[token] minted (x-auth)')
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('user-1')
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('session-1')
  })

  it('rejects an x-auth-token that does not verify', async () => {
    await attachWith(baseConfig())
    const forged = jwt.sign({ user: { uuid: 'user-1' }, session: { uuid: 'session-1' } }, 'wrong-secret', {
      algorithm: 'HS256',
    })

    const { res, status, body } = fakeResponse()
    handleMintToken(fakeRequest({ 'x-auth-token': forged }), res)

    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'invalid auth token' })
  })

  it('rejects an x-auth-token when no auth jwt secret is configured', async () => {
    await attachWith(baseConfig({ authJwtSecret: '' }))
    const authToken = jwt.sign({ user: { uuid: 'user-1' }, session: { uuid: 'session-1' } }, AUTH_SECRET, {
      algorithm: 'HS256',
    })

    const { res, status, body } = fakeResponse()
    handleMintToken(fakeRequest({ 'x-auth-token': authToken }), res)

    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'invalid auth token' })
  })

  it('reports 503 on the internal path when no internal secret is configured', async () => {
    await attachWith(baseConfig({ internalSecret: '' }))

    const { res, status, body } = fakeResponse()
    handleMintToken(fakeRequest({ 'x-internal-secret': 'anything' }), res)

    expect(status()).toBe(503)
    expect(body()).toEqual({ error: 'internal token minting is disabled (no internal secret configured)' })
  })

  it('rejects a wrong, missing or array-valued internal secret', async () => {
    await attachWith(baseConfig())

    for (const headers of [
      { 'x-internal-secret': 'wrong-secret' },
      {},
      { 'x-internal-secret': [INTERNAL_SECRET] },
      { 'x-internal-secret': '' },
    ]) {
      const { res, status, body } = fakeResponse()
      handleMintToken(fakeRequest(headers), res)
      expect(status()).toBe(403)
      expect(body()).toEqual({ error: 'forbidden' })
    }
  })

  it('refuses the internal-secret path for a proxied or remote caller before comparing the secret', async () => {
    await attachWith(baseConfig())
    const body = { userUuid: 'user-1', sessionUuid: 'session-1' }

    for (const [headers, peer] of [
      [{ 'x-internal-secret': INTERNAL_SECRET, 'x-forwarded-for': '203.0.113.9' }, { remoteAddress: '127.0.0.1' }],
      [{ 'x-internal-secret': INTERNAL_SECRET, 'x-forwarded-for': '' }, { remoteAddress: '127.0.0.1' }],
      [{ 'x-internal-secret': INTERNAL_SECRET }, { remoteAddress: '203.0.113.9' }],
      [{ 'x-internal-secret': INTERNAL_SECRET }, { remoteAddress: '::ffff:10.0.0.7' }],
      [{ 'x-internal-secret': INTERNAL_SECRET }, {}],
    ] as const) {
      const { res, status, body: responseBody } = fakeResponse()
      handleMintToken(Object.assign(fakeRequest(headers, undefined, peer), { body }), res)
      expect(status()).toBe(403)
      expect(responseBody()).toEqual({ error: 'forbidden' })
    }
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('proxied or remote')

    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.8.8.8']) {
      const { res, status } = fakeResponse()
      handleMintToken(
        Object.assign(fakeRequest({ 'x-internal-secret': INTERNAL_SECRET }, undefined, { remoteAddress }), { body }),
        res,
      )
      expect(status()).toBe(200)
    }
  })

  it('still honours the forwarded x-auth-token path for a proxied caller', async () => {
    await attachWith(baseConfig())
    const crossServiceToken = jwt.sign({ user: { uuid: 'user-1' }, session: { uuid: 'session-1' } }, AUTH_SECRET, {
      algorithm: 'HS256',
    })
    const { res, status } = fakeResponse()
    handleMintToken(
      fakeRequest({ 'x-auth-token': crossServiceToken, 'x-forwarded-for': '203.0.113.9' }, undefined, {
        remoteAddress: '10.0.0.2',
      }),
      res,
    )

    expect(status()).toBe(200)
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('user-1')
  })

  it('mints from an already-parsed body (attached mode, express has parsed json)', async () => {
    await attachWith(baseConfig())

    const { res, status, body } = fakeResponse()
    const req = Object.assign(fakeRequest({ 'x-internal-secret': INTERNAL_SECRET }), {
      body: { userUuid: 'user-9', sessionUuid: 'session-9' },
    })
    handleMintToken(req, res)

    expect(status()).toBe(200)
    const minted = (body() as { token: string }).token
    expect(jwt.verify(minted, CONNECTION_SECRET)).toMatchObject({ userUuid: 'user-9', sessionUuid: 'session-9' })
    expect(logger.info).toHaveBeenCalledWith('[token] minted (internal)')
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('user-9')
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('session-9')
  })

  it('mints from a streamed raw body (standalone mode)', async () => {
    await attachWith(baseConfig())

    const result = await mintWithStreamedBody(
      handleMintToken,
      { 'x-internal-secret': INTERNAL_SECRET },
      JSON.stringify({ userUuid: 'user-7', sessionUuid: 'session-7' }),
    )

    expect(result.status).toBe(200)
    expect(jwt.verify((result.body as { token: string }).token, CONNECTION_SECRET)).toMatchObject({
      userUuid: 'user-7',
      sessionUuid: 'session-7',
    })
  })

  it('rejects a streamed body that is not valid json', async () => {
    await attachWith(baseConfig())

    const result = await mintWithStreamedBody(handleMintToken, { 'x-internal-secret': INTERNAL_SECRET }, '{ nope')

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'invalid json body' })
  })

  it('rejects an empty streamed body as missing identifiers', async () => {
    await attachWith(baseConfig())

    const result = await mintWithStreamedBody(handleMintToken, { 'x-internal-secret': INTERNAL_SECRET }, '')

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'userUuid and sessionUuid are required' })
  })

  it('rejects a body missing or mistyping userUuid/sessionUuid', async () => {
    await attachWith(baseConfig())

    for (const payload of [
      { sessionUuid: 'session-1' },
      { userUuid: 'user-1' },
      { userUuid: '', sessionUuid: 'session-1' },
      { userUuid: 'user-1', sessionUuid: '' },
      { userUuid: 42, sessionUuid: 'session-1' },
    ]) {
      const result = await mintWithStreamedBody(
        handleMintToken,
        { 'x-internal-secret': INTERNAL_SECRET },
        JSON.stringify(payload),
      )
      expect(result.status).toBe(400)
      expect(result.body).toEqual({ error: 'userUuid and sessionUuid are required' })
    }
  })

  it('destroys a request whose streamed body exceeds the 16KiB cap', async () => {
    await attachWith(baseConfig())

    const { res } = fakeResponse()
    const req = fakeRequest({ 'x-internal-secret': INTERNAL_SECRET })
    handleMintToken(req, res)
    req.emit('data', 'x'.repeat(16_385))

    expect(req.destroy).toHaveBeenCalled()
  })
})

describe('websocket connection lifecycle', () => {
  let port: number
  let logger: ReturnType<typeof makeLogger>

  async function attachGateway(overrides: Partial<Parameters<typeof attachWebSocketGateway>[0]> = {}): Promise<void> {
    port = await listen()
    logger = makeLogger()
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger, ...overrides })
  }

  function connect(query: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}/sockets${query}`)
  }

  function closedWith(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => socket.once('close', (code) => resolve(code)))
  }

  function closedWithReason(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    )
  }

  function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  }

  function nextMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())))
  }

  it('closes a connection that presents no authToken with policy code 1008', async () => {
    await attachGateway()
    const socket = connect('')

    expect(await closedWithReason(socket)).toEqual({ code: 1008, reason: 'missing authToken' })
    expect(attached!.registry.size()).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      '[ws] connection rejected: missing authToken',
      JSON.stringify({ suppressedSinceLastLog: 0 }),
    )
  })

  it('closes a connection whose authToken does not verify and names the jwt failure class', async () => {
    await attachGateway()
    const forged = jwt.sign({ userUuid: 'user-1', sessionUuid: 'session-1' }, 'wrong-secret', { algorithm: 'HS256' })
    const socket = connect(`?authToken=${forged}`)

    expect(await closedWith(socket)).toBe(1008)
    expect(attached!.registry.size()).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      '[ws] connection rejected: bad token',
      JSON.stringify({ errorType: 'Error', jwtError: 'invalid-signature', suppressedSinceLastLog: 0 }),
    )
  })

  it.each([
    ['expired', () => mintConnectionToken({ userUuid: 'user-1', sessionUuid: 'session-1' }, CONNECTION_SECRET, -60)],
    ['malformed', () => 'not-a-jwt'],
    ['other', () => jwt.sign({ userUuid: 'user-1' }, CONNECTION_SECRET, { algorithm: 'HS256', expiresIn: '60s' })],
  ])('classifies a rejected legacy token as %s without echoing it', async (jwtError, token) => {
    await attachGateway()
    const socket = connect(`?authToken=${token()}`)

    expect(await closedWith(socket)).toBe(1008)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [message, metadata] = logger.warn.mock.calls[0] as [string, string]
    expect(message).toBe('[ws] connection rejected: bad token')
    expect(JSON.parse(metadata)).toMatchObject({ jwtError })
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token().slice(0, 12))
  })

  it('throttles a storm of legacy refusals to one line per cause', async () => {
    await attachGateway()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await closedWith(connect(''))
    }

    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('upgrades the legacy lane only on /sockets', async () => {
    await attachGateway()
    const token = mintConnectionToken({ userUuid: 'user-1', sessionUuid: 'session-1' }, CONNECTION_SECRET, '60s')

    for (const path of ['/', '/sockets/', '/sockets/legacy', '/anything']) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?authToken=${token}`)
      expect(await closedWithReason(socket)).toEqual({ code: 1008, reason: 'unknown path' })
    }
    expect(attached!.registry.size()).toBe(0)
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('/sockets/legacy')

    const pinned = connect(`?authToken=${token}`)
    await opened(pinned)
    expect(attached!.registry.size()).toBe(1)
    pinned.close()
  })

  it('logs connect and disconnect without the user identifier', async () => {
    await attachGateway()
    const token = mintConnectionToken(
      { userUuid: 'user-uuid-sentinel', sessionUuid: 'session-1' },
      CONNECTION_SECRET,
      '60s',
    )
    const socket = connect(`?authToken=${token}`)
    await opened(socket)
    socket.close()
    await closedWith(socket)
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))

    const emitted = JSON.stringify(logger.info.mock.calls)
    expect(emitted).toContain('[ws] connect conn=')
    expect(emitted).toContain('[ws] disconnect conn=')
    expect(emitted).not.toContain('user-uuid-sentinel')
  })

  it('registers a connection presenting a valid token and deregisters it on close', async () => {
    await attachGateway()
    const token = mintConnectionToken({ userUuid: 'user-1', sessionUuid: 'session-1' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    await opened(socket)
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(1))
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('session-1')

    socket.close()
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))
  })

  it('rejects the N+1 socket at the per-user ceiling without logging the user, and reclaims the bucket on close', async () => {
    await attachGateway({ maxConnectionsPerUser: 2 })
    const token = mintConnectionToken({ userUuid: 'user-tabs', sessionUuid: 'session-tabs' }, CONNECTION_SECRET, '60s')
    const first = connect(`?authToken=${token}`)
    const second = connect(`?authToken=${token}`)
    await Promise.all([opened(first), opened(second)])
    await vi.waitFor(() => expect(attached!.registry.get('user-tabs')).toHaveLength(2))

    const rejected = connect(`?authToken=${token}`)
    expect(await closedWith(rejected)).toBe(1008)
    expect(attached!.registry.get('user-tabs')).toHaveLength(2)
    expect(logger.warn).toHaveBeenCalledWith(
      '[ws] connection rejected: per-user limit',
      JSON.stringify({ limit: 2, suppressedSinceLastLog: 0 }),
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('user-tabs')

    first.close()
    await vi.waitFor(() => expect(attached!.registry.get('user-tabs')).toHaveLength(1))

    const replacement = connect(`?authToken=${token}`)
    await opened(replacement)
    await vi.waitFor(() => expect(attached!.registry.get('user-tabs')).toHaveLength(2))

    second.close()
    replacement.close()
    await vi.waitFor(() => {
      expect(attached!.registry.size()).toBe(0)
      expect(attached!.registry.userCount()).toBe(0)
    })
  })

  it('does not resurrect a room reservation whose authorization resolves after socket close', async () => {
    let resolveAuthorization!: (value: {
      authorized: true
      expiresAt: number
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
      roomEpoch: string
      collaborationSecurityEpoch: string
      leaseRequestId: string
    }) => void
    let markAuthorizationStarted!: () => void
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve
    })
    const delayedAuthorization = new Promise<{
      authorized: true
      expiresAt: number
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
      roomEpoch: string
      collaborationSecurityEpoch: string
      leaseRequestId: string
    }>((resolve) => {
      resolveAuthorization = resolve
    })
    await attachGateway({
      authorizeRoomJoin: () => {
        markAuthorizationStarted()
        return delayedAuthorization
      },
    })
    const token = mintConnectionToken({ userUuid: 'user-race', sessionUuid: 'session-race' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    const messages: string[] = []
    socket.on('message', (data) => messages.push(data.toString()))
    await opened(socket)
    socket.send(
      JSON.stringify({
        t: 'room-reserve',
        room: 'note-race',
        requestId: 'delayed-join',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
      }),
    )
    await authorizationStarted

    const closed = closedWith(socket)
    socket.close()
    await closed
    resolveAuthorization({
      authorized: true,
      expiresAt: Date.now() + 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: ROOM_EPOCH,
      collaborationSecurityEpoch: SECURITY_EPOCH,
      leaseRequestId: 'delayed-join',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(attached!.registry.size()).toBe(0)
    expect(attached!.rooms.roomCount()).toBe(0)
    expect(messages.some((message) => message.includes('room-reserved'))).toBe(false)
    expect(
      logger.info.mock.calls.filter(([message]) => String(message).includes('[ws] disconnect conn=')),
    ).toHaveLength(1)
  })

  it('answers an application-level ping with pong', async () => {
    await attachGateway()
    const token = mintConnectionToken({ userUuid: 'user-1', sessionUuid: 'session-1' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    await opened(socket)

    socket.send('ping')
    expect(await nextMessage(socket)).toBe('pong')
    socket.close()
  })

  it('rejects an oversized message in ws before it can enter the relay', async () => {
    // Annotate the return type: without a contextual type the object literal
    // widens `collaborationProtocolVersion` to `number` and stops matching the
    // literal-3 v3 authorization. The grant is never consumed here -- the
    // oversized frame is rejected before any join -- but it must still be a
    // shape the gateway would actually accept.
    const authorizeRoomJoin = vi.fn((): RoomJoinAuthorization => ({
      authorized: true,
      expiresAt: Date.now() + 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomEpoch: ROOM_EPOCH,
      collaborationSecurityEpoch: SECURITY_EPOCH,
    }))
    await attachGateway({ authorizeRoomJoin })
    const token = mintConnectionToken(
      { userUuid: 'user-large', sessionUuid: 'session-large' },
      CONNECTION_SECRET,
      '60s',
    )
    const socket = connect(`?authToken=${token}`)
    await opened(socket)

    const closed = closedWith(socket)
    socket.send('x'.repeat(MAX_WEBSOCKET_MESSAGE_BYTES + 1))

    expect(await closed).toBe(1009)
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))
    expect(attached!.rooms.roomCount()).toBe(0)
    expect(authorizeRoomJoin).not.toHaveBeenCalled()
  })

  it('closes a connection that exhausts its per-connection frame bucket', async () => {
    await attachGateway({
      ingressLimits: {
        frameCapacity: 2,
        frameRefillPerSecond: 0.000_001,
        byteCapacity: 1024,
        byteRefillPerSecond: 1024,
      },
    })
    const token = mintConnectionToken(
      { userUuid: 'user-frames', sessionUuid: 'session-frames' },
      CONNECTION_SECRET,
      '60s',
    )
    const socket = connect(`?authToken=${token}`)
    await opened(socket)

    for (let index = 0; index < 2; index++) {
      const pong = nextMessage(socket)
      socket.send('ping')
      expect(await pong).toBe('pong')
    }

    const closed = closedWith(socket)
    socket.send('ping')
    expect(await closed).toBe(1008)
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))
    expect(logger.warn).toHaveBeenCalledWith('[ws] ingress rate exceeded', expect.stringContaining('"conn":'))
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('user-frames')
  })

  it('closes a connection that exhausts its per-connection byte bucket', async () => {
    await attachGateway({
      ingressLimits: {
        frameCapacity: 100,
        frameRefillPerSecond: 100,
        byteCapacity: 10,
        byteRefillPerSecond: 0.000_001,
      },
    })
    const token = mintConnectionToken(
      { userUuid: 'user-bytes', sessionUuid: 'session-bytes' },
      CONNECTION_SECRET,
      '60s',
    )
    const socket = connect(`?authToken=${token}`)
    await opened(socket)

    for (let index = 0; index < 2; index++) {
      const pong = nextMessage(socket)
      socket.send('ping')
      expect(await pong).toBe('pong')
    }

    const closed = closedWith(socket)
    socket.send('ping')
    expect(await closed).toBe(1008)
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))
    expect(logger.warn).toHaveBeenCalledWith('[ws] ingress rate exceeded', expect.stringContaining('"conn":'))
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('user-bytes')
  })

  // R15. The relay backlog used to close the socket on overflow. On the legacy
  // lane that socket is also the push, invite and MFA transport, so one
  // collaboration burst took four unrelated lanes down and left the client
  // reconnecting with backoff. Overflow now sheds the collaboration state and
  // keeps the connection.
  it('denies the rooms and keeps the socket when a slow relay lifecycle overflows the frame backlog', async () => {
    let releaseEval!: () => void
    try {
      await attachGateway({
        relayBacklogLimits: { frameCapacity: 3, byteCapacity: 64 * 1024 },
        ingressLimits: {
          frameCapacity: 100,
          frameRefillPerSecond: 100,
          byteCapacity: 1024 * 1024,
          byteRefillPerSecond: 1024 * 1024,
        },
        authorizeRoomJoin: (_userUuid, _room, capability) => {
          const binding = JSON.parse(capability ?? '{}') as { requestId?: string; challenge?: string }
          return {
            authorized: true,
            expiresAt: Date.now() + 60_000,
            serverUpdatedAtTimestamp: 1,
            collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
            roomEpoch: ROOM_EPOCH,
            collaborationSecurityEpoch: SECURITY_EPOCH,
            ...(binding.requestId ? { leaseRequestId: binding.requestId } : {}),
            ...(binding.challenge ? { bootstrapChallenge: binding.challenge } : {}),
          }
        },
      })
      const token = mintConnectionToken(
        { userUuid: 'user-relay-frames', sessionUuid: 'session-relay-frames' },
        CONNECTION_SECRET,
        '60s',
      )
      const socket = connect(`?authToken=${token}`)
      await opened(socket)
      const received: Record<string, unknown>[] = []
      socket.on('message', (data) => {
        const raw = data.toString()
        if (raw !== 'pong') {
          received.push(JSON.parse(raw) as Record<string, unknown>)
        }
      })

      // Join for real first: a pending reservation is not a membership, and
      // only a membership can be denied.
      socket.send(
        JSON.stringify({
          t: 'room-reserve',
          room: 'slow-frame-room',
          requestId: 'slow-frame-lease',
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: ROOM_EPOCH,
          cap: JSON.stringify({ requestId: 'slow-frame-lease' }),
        }),
      )
      await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ t: 'room-reserved' }))
      const reserved = received.at(-1) as { bootstrapChallenge?: string }
      socket.send(
        JSON.stringify({
          t: 'room-join',
          room: 'slow-frame-room',
          requestId: 'slow-frame-lease',
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: ROOM_EPOCH,
          cap: JSON.stringify({ requestId: 'slow-frame-lease', challenge: reserved.bootstrapChallenge }),
        }),
      )
      await vi.waitFor(() => expect(attached!.rooms.members('slow-frame-room').length).toBe(1))

      // Now stall the relay lifecycle and overflow the ordered queue behind it.
      redis.state.evalGate = new Promise<void>((resolve) => {
        releaseEval = resolve
      })
      const evalCallsBeforeStall = redis.state.evalCalls
      socket.send(
        JSON.stringify({
          t: 'room-reserve',
          room: 'slow-frame-room',
          requestId: 'stalled-lease',
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: ROOM_EPOCH,
          cap: JSON.stringify({ requestId: 'stalled-lease' }),
        }),
      )
      await vi.waitFor(() => expect(redis.state.evalCalls).toBeGreaterThan(evalCallsBeforeStall))
      for (let index = 0; index < 4; index += 1) {
        socket.send(JSON.stringify({ t: 'yjs', room: 'slow-frame-room', payload: `queued-${index}` }))
      }

      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith('[ws] relay backlog exceeded', expect.stringContaining('"conn":')),
      )
      await vi.waitFor(() =>
        expect(received).toContainEqual({ t: 'room-denied', room: 'slow-frame-room', reason: 'rate-limited' }),
      )

      // The socket survives: still registered, still serving push, still
      // answering the application-level ping.
      expect(socket.readyState).toBe(WebSocket.OPEN)
      expect(attached!.registry.size()).toBe(1)
      expect(attached!.rooms.members('slow-frame-room').length).toBe(0)
      const pong = nextMessage(socket)
      socket.send('ping')
      expect(await pong).toBe('pong')

      redis.state.evalGate = undefined
      releaseEval()
      socket.close()
    } finally {
      redis.state.evalGate = undefined
      releaseEval?.()
    }
  })

  it('keeps the socket open when a slow relay lifecycle exceeds the retained-byte ceiling', async () => {
    let releaseEval!: () => void
    redis.state.evalGate = new Promise<void>((resolve) => {
      releaseEval = resolve
    })
    const reserveFrame = JSON.stringify({
      t: 'room-reserve',
      room: 'slow-byte-room',
      cap: 'slow-byte-lease',
      requestId: 'slow-byte-lease',
      role: 'editor',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      expectedRoomEpoch: ROOM_EPOCH,
    })
    try {
      await attachGateway({
        relayBacklogLimits: { frameCapacity: 100, byteCapacity: Buffer.byteLength(reserveFrame, 'utf8') + 8 },
        ingressLimits: {
          frameCapacity: 100,
          frameRefillPerSecond: 100,
          byteCapacity: 1024 * 1024,
          byteRefillPerSecond: 1024 * 1024,
        },
        authorizeRoomJoin: (_userUuid, _room, capability) => ({
          authorized: true,
          expiresAt: Date.now() + 60_000,
          serverUpdatedAtTimestamp: 1,
          collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
          roomEpoch: ROOM_EPOCH,
          collaborationSecurityEpoch: SECURITY_EPOCH,
          leaseRequestId: capability,
        }),
      })
      const token = mintConnectionToken(
        { userUuid: 'user-relay-bytes', sessionUuid: 'session-relay-bytes' },
        CONNECTION_SECRET,
        '60s',
      )
      const socket = connect(`?authToken=${token}`)
      await opened(socket)
      socket.send(reserveFrame)
      await vi.waitFor(() => expect(redis.state.evalCalls).toBe(1))

      socket.send(JSON.stringify({ t: 'room-leave', room: 'slow-byte-room', requestId: 'queued-byte-frame' }))
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith('[ws] relay backlog exceeded', expect.stringContaining('"conn":')),
      )
      redis.state.evalGate = undefined
      releaseEval()

      // The byte ceiling sheds the same way the frame ceiling does.
      expect(socket.readyState).toBe(WebSocket.OPEN)
      expect(attached!.registry.size()).toBe(1)
      const pong = nextMessage(socket)
      socket.send('ping')
      expect(await pong).toBe('pong')
      await vi.waitFor(() => expect(attached!.rooms.roomCount()).toBe(0))
      socket.close()
    } finally {
      redis.state.evalGate = undefined
      releaseEval?.()
    }
  })

  it('sizes the default relay backlog to at least one full legacy ingress burst', async () => {
    // The two limits are one policy. A 128-frame backlog behind a 512-frame
    // burst meant the rate limiter deliberately admitted traffic the relay
    // queue then refused -- a self-inflicted overflow, not a hostile client.
    expect(DEFAULT_WEBSOCKET_RELAY_BACKLOG_LIMITS.frameCapacity).toBeGreaterThanOrEqual(
      DEFAULT_WEBSOCKET_INGRESS_LIMITS.frameCapacity,
    )
  })

  it('relays a yjs frame between two sockets that joined the same room', async () => {
    await attachGateway({
      authorizeRoomJoin: (_userUuid, _room, capability) => {
        const binding = JSON.parse(capability ?? '{}') as { requestId?: string; challenge?: string }
        return {
          authorized: true,
          expiresAt: Date.now() + 60_000,
          serverUpdatedAtTimestamp: 1,
          collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
          roomEpoch: ROOM_EPOCH,
          collaborationSecurityEpoch: SECURITY_EPOCH,
          ...(binding.requestId ? { leaseRequestId: binding.requestId } : {}),
          ...(binding.challenge ? { bootstrapChallenge: binding.challenge } : {}),
        }
      },
    })
    const tokenA = mintConnectionToken({ userUuid: 'user-A', sessionUuid: 'session-A' }, CONNECTION_SECRET, '60s')
    const tokenB = mintConnectionToken({ userUuid: 'user-B', sessionUuid: 'session-B' }, CONNECTION_SECRET, '60s')
    const socketA = connect(`?authToken=${tokenA}`)
    const socketB = connect(`?authToken=${tokenB}`)
    await Promise.all([opened(socketA), opened(socketB)])

    const activate = async (socket: WebSocket, requestId: string): Promise<void> => {
      const reservedMessage = nextMessage(socket)
      socket.send(
        JSON.stringify({
          t: 'room-reserve',
          room: 'note-1',
          requestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: ROOM_EPOCH,
          cap: JSON.stringify({ requestId }),
        }),
      )
      const reserved = JSON.parse(await reservedMessage) as { bootstrapChallenge?: string; roomEpoch?: string }
      expect(reserved.roomEpoch).toBe(ROOM_EPOCH)
      const joinedMessage = nextMessage(socket)
      socket.send(
        JSON.stringify({
          t: 'room-join',
          room: 'note-1',
          requestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: ROOM_EPOCH,
          cap: JSON.stringify({ requestId, challenge: reserved.bootstrapChallenge }),
        }),
      )
      expect(JSON.parse(await joinedMessage)).toMatchObject({
        t: 'room-joined',
        room: 'note-1',
        requestId,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        roomEpoch: ROOM_EPOCH,
      })
    }

    await activate(socketA, 'lease-a')
    await vi.waitFor(() => expect(attached!.rooms.members('note-1').length).toBe(1))
    await activate(socketB, 'lease-b')
    await vi.waitFor(() => expect(attached!.rooms.members('note-1').length).toBe(2))

    const relayed = nextMessage(socketB)
    socketA.send(JSON.stringify({ t: 'yjs', room: 'note-1', payload: 'update-1' }))
    expect(JSON.parse(await relayed)).toMatchObject({ t: 'yjs', room: 'note-1', payload: 'update-1' })

    socketA.close()
    socketB.close()
  })

  it('denies a room join that the authorizer rejects', async () => {
    await attachGateway({ authorizeRoomJoin: () => ({ authorized: false }) })
    const token = mintConnectionToken({ userUuid: 'user-A', sessionUuid: 'session-A' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    await opened(socket)

    const denied = nextMessage(socket)
    socket.send(JSON.stringify({ t: 'room-join', room: 'note-1' }))
    // `room-denied` gains a `reason` field in this wave (C1); match the shape.
    expect(JSON.parse(await denied)).toMatchObject({ t: 'room-denied', room: 'note-1' })
    expect(attached!.rooms.members('note-1').length).toBe(0)

    socket.close()
  })

  it('fails a room join closed when the authorizer throws, without dropping the socket', async () => {
    await attachGateway({
      authorizeRoomJoin: () => {
        throw new Error('authorizer exploded')
      },
    })
    const token = mintConnectionToken({ userUuid: 'user-A', sessionUuid: 'session-A' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    await opened(socket)

    const denied = nextMessage(socket)
    socket.send(JSON.stringify({ t: 'room-join', room: 'note-1' }))
    // `room-denied` gains a `reason` field in this wave (C1); match the shape.
    expect(JSON.parse(await denied)).toMatchObject({ t: 'room-denied', room: 'note-1' })
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(attached!.rooms.members('note-1').length).toBe(0)

    socket.close()
  })

  it('ignores a message that is not a recognised relay frame', async () => {
    await attachGateway()
    const token = mintConnectionToken({ userUuid: 'user-A', sessionUuid: 'session-A' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    await opened(socket)

    socket.send('not-a-frame')
    socket.send('ping')
    // The unrecognised frame is dropped silently; the next ping still answers.
    expect(await nextMessage(socket)).toBe('pong')

    socket.close()
  })

  it('terminates a socket that never answers the heartbeat ping', async () => {
    vi.useFakeTimers()
    try {
      await attachGateway()
      // autoPong: false makes this client ignore the server's ping, which is what a
      // wedged/half-open connection looks like to the gateway.
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/sockets?authToken=${mintConnectionToken(
          { userUuid: 'user-1', sessionUuid: 'session-1' },
          CONNECTION_SECRET,
          '60s',
        )}`,
        { autoPong: false },
      )
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(0)
        expect(attached!.registry.size()).toBe(1)
      })

      // First sweep: still marked alive, so it is pinged and marked stale.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logger.warn).not.toHaveBeenCalledWith('[ws] terminating dead socket')

      // Second sweep with no pong in between: the socket is dropped.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logger.warn).toHaveBeenCalledWith('[ws] terminating dead socket')

      socket.terminate()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a socket across sweeps when it answers the heartbeat ping', async () => {
    vi.useFakeTimers()
    try {
      await attachGateway()
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/sockets?authToken=${mintConnectionToken(
          { userUuid: 'user-1', sessionUuid: 'session-1' },
          CONNECTION_SECRET,
          '60s',
        )}`,
      )
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(0)
        expect(attached!.registry.size()).toBe(1)
      })

      // This client auto-pongs, which fires the gateway's 'pong' handler and
      // re-marks the connection alive before the next sweep looks at it.
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(0)
        expect(socket.readyState).toBe(WebSocket.OPEN)
      })
      await vi.advanceTimersByTimeAsync(30_000)

      expect(logger.warn).not.toHaveBeenCalledWith('[ws] terminating dead socket')
      expect(attached!.registry.size()).toBe(1)

      socket.terminate()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deregisters a connection when its socket errors', async () => {
    await attachGateway()
    const token = mintConnectionToken({ userUuid: 'user-1', sessionUuid: 'session-1' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    await opened(socket)
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(1))

    // Destroying the underlying tcp socket surfaces as an 'error' on the server side.
    socket.terminate()
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))
  })

  it('closes every live socket with 1001 on stop()', async () => {
    await attachGateway()
    const token = mintConnectionToken({ userUuid: 'user-1', sessionUuid: 'session-1' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    await opened(socket)

    const closed = closedWith(socket)
    await attached!.stop()
    attached = undefined
    expect(await closed).toBe(1001)
  })
})

describe('authenticated /sockets/sync command plane', () => {
  let port: number

  const syncOptions = () => ({
    isEnabled: () => true,
    allowedOrigins: ['https://app.example.test', 'tauri://localhost'],
    authorization: {
      ready: () => true,
      authorize: vi.fn(async () => ({ authorized: true as const })),
    },
    backend: {
      ready: () => true,
      execute: vi.fn(async (input: { digest: string }) => ({ digest: input.digest, payload: { ok: true } })),
      status: vi.fn(async (input: { digest: string }) => ({ status: 'UNKNOWN' as const, digest: input.digest })),
    },
  })

  /**
   * Fleet-shared store set: the real in-memory implementations behind adapters
   * that only differ in `distribution`. Behaviour is unchanged, so a test can
   * get past the shared-state guard and reach the composition checks behind it
   * without inventing store semantics.
   */
  const sharedSyncState = (): Pick<SyncGatewayOptions, 'tickets' | 'leases' | 'socketBudget' | 'inviteEvents'> => {
    const tickets = new InMemorySyncAuthTicketStore()
    const leases = new InMemorySyncCommandLeaseRegistry()
    const socketBudget = new InMemorySyncSocketBudget(4)
    return {
      // The in-memory implementations take no abort signal; the adapters accept
      // one to satisfy the interface and drop it, exactly as those stores do.
      tickets: {
        distribution: 'shared',
        ready: () => tickets.ready(),
        issue: (identity, ttlMs) => tickets.issue(identity, ttlMs),
        consume: (ticket) => tickets.consume(ticket),
        clear: () => tickets.clear(),
      },
      leases: {
        distribution: 'shared',
        ready: () => leases.ready(),
        acquire: (input) => leases.acquire(input),
        renew: (input) => leases.renew(input),
        release: (input) => leases.release(input),
      },
      socketBudget: {
        distribution: 'shared',
        ready: () => socketBudget.ready(),
        acquire: (input) => socketBudget.acquire(input),
        renew: (input) => socketBudget.renew(input),
        release: (input) => socketBudget.release(input),
      },
      inviteEvents: {
        distribution: 'shared',
        ready: () => true,
        tail: async () => '0',
        readAfter: async (_userUuid, cursor) => ({
          previousCursor: cursor,
          events: [],
          nextCursor: cursor,
          hasMore: false,
        }),
        subscribeAvailability: () => () => undefined,
      },
    }
  }

  async function attachSync(): Promise<void> {
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: syncOptions(),
    })
  }

  function closedWith(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => socket.once('close', (code) => resolve(code)))
  }

  function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
  }

  function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) =>
      socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>)),
    )
  }

  function closedWithReason(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    )
  }

  it('advertises no capability unless every adapter and kill switch is ready', async () => {
    await listen()
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger() })
    expect(attached.sync.capabilities()).toEqual({ capabilities: [] })
    await expect(
      attached.sync.issueTicket({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' }),
    ).rejects.toThrow(/unavailable/i)
    // The gateway-native ticket/capability handlers are gone: neither host
    // ever registered them and the ticket one had no session in front of it.
    expect(attached).not.toHaveProperty('handleSyncTicket')
    expect(attached).not.toHaveProperty('handleSyncCapabilities')
  })

  it('refuses a ticket with a typed error that says whether the cause is transient', async () => {
    await listen()
    const notReadyTickets = new InMemorySyncAuthTicketStore()
    vi.spyOn(notReadyTickets, 'ready').mockReturnValue(false)
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: { ...syncOptions(), tickets: notReadyTickets },
    })
    const identity = { userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' }
    const storeRefusal = await attached.sync.issueTicket(identity).catch((error: unknown) => error)
    expect(storeRefusal).toBeInstanceOf(SyncUnavailableError)
    expect(storeRefusal).toMatchObject({ reasons: ['ticket-store-unavailable'], transient: true })
    await attached.stop()

    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: { ...syncOptions(), tickets: notReadyTickets, isEnabled: () => false },
    })
    const mixedRefusal = await attached.sync.issueTicket(identity).catch((error: unknown) => error)
    expect(mixedRefusal).toMatchObject({
      reasons: ['disabled-by-configuration', 'ticket-store-unavailable'],
      transient: false,
    })
  })

  it('does not gate the whole lane on the invite availability bus', async () => {
    port = await listen()
    // A 1-2 s Redis reconnect window used to make whoever negotiated during
    // it HTTP-only for the session; INVITE_EVENTS alone depends on the bus.
    const shared = sharedSyncState()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: {
        ...syncOptions(),
        ...shared,
        inviteEvents: { ...shared.inviteEvents!, ready: () => false },
        requireSharedState: true,
        filesUnsupported: true,
      },
    })

    expect(attached.sync.unavailabilityReasons?.()).toEqual([])
    expect(attached.sync.capabilities().capabilities).toHaveLength(1)
    expect(attached.health().syncLane).toBe('up')
  })

  it('closes a rejected sync upgrade with the cause as the close reason', async () => {
    await attachSync()
    const queryString = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync?ticket=x`, {
      origin: 'https://app.example.test',
    })
    expect(await closedWithReason(queryString)).toEqual({ code: 1008, reason: 'query-string-not-permitted' })

    const foreignOrigin = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://evil.example' })
    expect(await closedWithReason(foreignOrigin)).toEqual({ code: 1008, reason: 'origin-not-allowed' })
    await attached!.stop()

    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: { ...syncOptions(), isEnabled: () => false },
    })
    const unavailable = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://app.example.test' })
    expect(await closedWithReason(unavailable)).toEqual({
      code: 1013,
      reason: 'sync-unavailable:disabled-by-configuration',
    })
  })

  // Contract C4 end to end through attach: the adapter reports the HMAC
  // initial epoch, the fleet-shared room state holds a rotated one, and the
  // gateway-supplied resolver is what lets the client echo an epoch the room
  // will actually accept.
  it('replaces the discovery roomEpoch with the resolver answer so a grant bound to the rotated epoch succeeds', async () => {
    const INITIAL = 'initial_room_epoch_0001'
    const ROTATED = 'rotated_room_epoch_0002'
    // `no-confusing-arrow` wants parentheses that prettier then removes, and this
    // repo's eslint config never applies eslint-config-prettier, so the two
    // tools cannot both be satisfied here. Suppress the formatting rule
    // rather than let them fight across every reformat.
    // eslint-disable-next-line no-confusing-arrow
    const authorizeCollaboration = vi.fn(async ({ request }: { request: Record<string, unknown> }) =>
      request.epochDiscovery === true
        ? {
            authorized: true as const,
            epochDiscovery: true as const,
            room: request.noteUuid as string,
            serverUpdatedAtTimestamp: 123,
            collaborationProtocolVersion: 3 as const,
            roomEpoch: INITIAL,
            collaborationSecurityEpoch: SECURITY_EPOCH,
          }
        : {
            authorized: true as const,
            capability: 'collaboration-capability',
            room: request.noteUuid as string,
            expiresIn: 300,
            serverUpdatedAtTimestamp: 123,
            collaborationProtocolVersion: 3 as const,
            roomEpoch: request.expectedRoomEpoch as string,
            collaborationSecurityEpoch: SECURITY_EPOCH,
            leaseRequestId: request.leaseRequestId as string,
          },
    )
    const collaborationRoomEpochResolver = vi.fn(async () => ROTATED)
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: {
        ...syncOptions(),
        collaborationAuthorization: { collaborationAuthorizationReady: () => true, authorizeCollaboration },
        collaborationRoomEpochResolver,
      },
    })
    const issued = await attached.sync.issueTicket({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://app.example.test' })
    await opened(socket)
    const frame = (type: string, sequence: number, payload: Record<string, unknown>) =>
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type,
        requestId: `${type.toLowerCase()}-${sequence}`,
        commandId: `${type.toLowerCase()}-${sequence}`,
        sequence,
        payloadLength: Buffer.byteLength(JSON.stringify(payload)),
        payload,
      })

    const authenticated = nextJson(socket)
    socket.send(frame('AUTH', 0, { ticket: issued.ticket, deviceId: 'device-1' }))
    expect(await authenticated).toMatchObject({ type: 'AUTHENTICATED' })

    const discovered = nextJson(socket)
    socket.send(
      frame('COLLABORATION_AUTHORIZE', 1, {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        epochDiscovery: true,
      }),
    )
    const discovery = (await discovered) as { type: string; payload: Record<string, unknown> }
    expect(discovery).toMatchObject({ type: 'COLLABORATION_AUTHORIZED', payload: { roomEpoch: ROTATED } })
    expect(collaborationRoomEpochResolver).toHaveBeenCalledWith('note-1', SECURITY_EPOCH)

    const granted = nextJson(socket)
    socket.send(
      frame('COLLABORATION_AUTHORIZE', 2, {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: ROTATED,
        epochDiscoveryChallenge: discovery.payload.epochDiscoveryChallenge,
        epochDiscoveryRequestId: discovery.payload.epochDiscoveryRequestId,
        leaseRequestId: 'lease-1',
      }),
    )
    expect(await granted).toMatchObject({
      type: 'COLLABORATION_AUTHORIZED',
      payload: { roomEpoch: ROTATED, leaseRequestId: 'lease-1' },
    })
    socket.close()
  })

  it('advertises and admits exact same-origin sync when no explicit origin list is configured', async () => {
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: { ...syncOptions(), allowedOrigins: [], allowSameOrigin: true },
    })
    expect(attached.sync.capabilities()).toEqual({
      capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }],
    })

    const sameOrigin = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: `http://127.0.0.1:${port}`,
    })
    await opened(sameOrigin)
    sameOrigin.close()

    const normalizedDefaultPort = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: 'https://app.example.test',
      headers: { host: 'app.example.test:443', 'x-forwarded-proto': 'https' },
    })
    await opened(normalizedDefaultPort)
    normalizedDefaultPort.close()

    const crossPort = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: 'https://app.example.test:444',
      headers: { host: 'app.example.test:443', 'x-forwarded-proto': 'https' },
    })
    expect(await closedWith(crossPort)).toBe(1008)

    const forwardedSchemeMismatch = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: 'http://app.example.test',
      headers: { host: 'app.example.test:443', 'x-forwarded-proto': 'https' },
    })
    expect(await closedWith(forwardedSchemeMismatch)).toBe(1008)

    const crossOrigin = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: 'https://evil.example.test',
    })
    expect(await closedWith(crossOrigin)).toBe(1008)
  })

  it('can require all production sync state to be fleet-shared', async () => {
    await listen()
    expect(() =>
      attachWebSocketGateway({
        httpServer,
        config: baseConfig(),
        logger: makeLogger(),
        sync: { ...syncOptions(), requireSharedState: true },
      }),
    ).toThrow(/fleet-shared/i)
  })

  it('refuses a shared-state composition that neither supplies nor waives FILES_V1', async () => {
    await listen()
    // FILES_V1 was silently absent from every bootstrap while the lane looked
    // fully wired, because nothing required `files`. Now a shared-state
    // composition has to state its intent.
    expect(() =>
      attachWebSocketGateway({
        httpServer,
        config: baseConfig(),
        logger: makeLogger(),
        sync: { ...syncOptions(), ...sharedSyncState(), requireSharedState: true },
      }),
    ).toThrow(/FILES_V1 storage adapter/i)

    expect(() =>
      attachWebSocketGateway({
        httpServer,
        config: baseConfig(),
        logger: makeLogger(),
        sync: { ...syncOptions(), ...sharedSyncState(), requireSharedState: true, filesUnsupported: true },
      }),
    ).not.toThrow()
  })

  it('advertises FILES_V1 only to the shared-state composition that supplied an adapter', async () => {
    const files = {
      ready: () => true,
      metadata: vi.fn(),
      openUpload: vi.fn(),
      uploadChunk: vi.fn(),
      finishUpload: vi.fn(),
      openDownload: vi.fn(),
      readDownloadChunk: vi.fn(),
      cancel: vi.fn(),
    } as unknown as SyncFilesAdapter

    for (const [supplied, expectation] of [
      [{ files }, expect.arrayContaining(['FILES_V1'])],
      [{ filesUnsupported: true }, expect.not.arrayContaining(['FILES_V1'])],
    ] as const) {
      port = await listen()
      attached = attachWebSocketGateway({
        httpServer,
        config: baseConfig(),
        logger: makeLogger(),
        sync: { ...syncOptions(), ...sharedSyncState(), requireSharedState: true, ...supplied },
      })
      const issued = await attached.sync.issueTicket({
        userUuid: 'user-guard',
        sessionUuid: 'session-guard',
        deviceId: 'device-guard',
      })
      const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://app.example.test' })
      await opened(socket)
      const payload = { ticket: issued.ticket, deviceId: 'device-guard' }
      const authenticated = nextJson(socket)
      socket.send(
        JSON.stringify({
          version: 1,
          channel: 'sync',
          type: 'AUTH',
          requestId: 'auth-guard',
          commandId: 'auth-guard',
          sequence: 0,
          payloadLength: Buffer.byteLength(JSON.stringify(payload)),
          payload,
        }),
      )
      expect(await authenticated).toMatchObject({
        type: 'AUTHENTICATED',
        payload: { operations: expectation },
      })
      socket.close()
      await attached.stop()
      attached = undefined
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  })

  it('clears unconsumed process-local authentication tickets during awaited stop', async () => {
    port = await listen()
    const tickets = new InMemorySyncAuthTicketStore()
    const clear = vi.spyOn(tickets, 'clear')
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: { ...syncOptions(), tickets },
    })
    const issued = await attached.sync.issueTicket({
      userUuid: 'shutdown-user',
      sessionUuid: 'shutdown-session',
      deviceId: 'shutdown-device',
    })
    // D7: the server's own clock rides along so a skewed client can derive
    // the ticket's remaining life instead of trusting its wall clock.
    expect(issued.expiresAt - issued.issuedAt!).toBe(30_000)

    await attached.stop()
    expect(clear).toHaveBeenCalledTimes(1)
    await expect(tickets.consume(issued.ticket)).resolves.toBeUndefined()
    await expect(attached.stop()).resolves.toBeUndefined()
    attached = undefined
  })

  it('fails ticket minting closed if the ready shared store rejects issuance', async () => {
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: {
        ...syncOptions(),
        tickets: {
          distribution: 'shared',
          ready: () => true,
          issue: vi.fn(async () => Promise.reject(new Error('shared store unavailable'))),
          consume: vi.fn(async () => undefined),
        },
      },
    })

    await expect(
      attached.sync.issueTicket({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' }),
    ).rejects.toThrow('shared store unavailable')
  })

  it('rejects query credentials without consuming the opaque ticket', async () => {
    await attachSync()
    const issued = await attached!.sync.issueTicket({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
    })
    const rejected = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync?ticket=${issued.ticket}`, {
      origin: 'https://app.example.test',
    })
    expect(await closedWith(rejected)).toBe(1008)

    const clean = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: 'https://app.example.test',
    })
    await opened(clean)
    const payload = { ticket: issued.ticket, deviceId: 'device-1' }
    const response = nextJson(clean)
    clean.send(
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type: 'AUTH',
        requestId: 'auth-request',
        commandId: 'auth-command',
        sequence: 0,
        payloadLength: Buffer.byteLength(JSON.stringify(payload)),
        payload,
      }),
    )
    expect(await response).toMatchObject({ type: 'AUTHENTICATED' })
    expect(clean.extensions).toBe('')
    clean.close()
  })

  it('rejects absent, wildcard-like, and unlisted origins while admitting configured desktop origins', async () => {
    await attachSync()
    const absent = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`)
    expect(await closedWith(absent)).toBe(1008)
    const unlisted = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://evil.example' })
    expect(await closedWith(unlisted)).toBe(1008)

    const desktop = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'tauri://localhost' })
    await opened(desktop)
    desktop.close()
  })

  it('hands the handler the throttled refusal logger so a lease that outlived its socket reaches the log', async () => {
    // R36 through attach: the handler names the refusal, but only reaches the
    // log if the gateway wires its logger in. A stub lease store that always
    // answers BUSY models a lease left behind by a SIGKILLed gateway.
    port = await listen()
    const logger = makeLogger()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger,
      sync: {
        ...syncOptions(),
        leases: {
          distribution: 'shared',
          ready: () => true,
          acquire: vi.fn(async () => ({ acquired: false as const, reason: 'BUSY' as const })),
          renew: vi.fn(async () => false),
          release: vi.fn(async () => undefined),
        },
      },
    })
    const issued = await attached.sync.issueTicket({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://app.example.test' })
    await opened(socket)
    const authPayload = { ticket: issued.ticket, deviceId: 'device-1' }
    const authenticated = nextJson(socket)
    socket.send(
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type: 'AUTH',
        requestId: 'auth-1',
        commandId: 'auth-1',
        sequence: 0,
        payloadLength: Buffer.byteLength(JSON.stringify(authPayload)),
        payload: authPayload,
      }),
    )
    expect(await authenticated).toMatchObject({ type: 'AUTHENTICATED' })

    const body = { api: '20200115', items: [] }
    const payload = { command: 'SYNC_ITEMS', body }
    const refused = nextJson(socket)
    socket.send(
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type: 'COMMAND',
        requestId: 'request-after-crash',
        commandId: 'after-crash',
        sequence: 1,
        payloadLength: Buffer.byteLength(JSON.stringify(payload)),
        payload,
        digest: digestSyncCommandBody(body),
      }),
    )
    expect(await refused).toMatchObject({ type: 'ERROR', payload: { code: 'BUSY', retryable: true } })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/lease outlived its socket/i),
      JSON.stringify({ code: 'BUSY', suppressedSinceLastLog: 0 }),
    )
    socket.close()
  })

  it('registers logger-backed production metrics and closes a sync frame above 512KiB before JSON parsing', async () => {
    port = await listen()
    const logger = makeLogger()
    const metrics = createLoggerSyncCommandMetrics(logger)
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger,
      sync: { ...syncOptions(), metrics },
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: 'https://app.example.test',
    })
    await opened(socket)
    const closed = closedWith(socket)
    socket.send('x'.repeat(512 * 1024 + 1))
    expect(await closed).toBe(1009)

    // N6: the counter is aggregated, so nothing is written until the window is
    // cut. The gateway's own shutdown cuts it, which is what stops the last
    // window of a process from being lost.
    expect(logger.info).not.toHaveBeenCalledWith('[ws-sync-metric]', expect.stringContaining('FRAME_TOO_LARGE'))
    metrics.flush()
    expect(logger.info).toHaveBeenCalledWith(
      '[ws-sync-metric]',
      expect.stringContaining('{"event":"protocol","code":"FRAME_TOO_LARGE","count":1}'),
    )
  })

  // N6 through attach, closing the seam a verifier flagged: the handler-emits
  // half and the sink-aggregates half were only ever tested apart, joined by an
  // unconditional pass-through of `syncOptions.metrics` into the handler. Here a
  // real RPC over a real socket stalls on credit, and the aggregate line that
  // reaches the logger is the assertion.
  it('aggregates the backpressure samples a credit-stalled RPC emits into one window line', async () => {
    const chunk = Buffer.alloc(8, 1)
    const apiRpc = {
      idempotencyScope: 'shared-durable' as const,
      ready: () => true,
      operations: () => ['API_RPC' as const],
      execute: async () => ({
        status: 200,
        stream: (async function* () {
          yield new Uint8Array(chunk)
        })(),
      }),
    }
    port = await listen()
    const logger = makeLogger()
    let now = 0
    const metrics = createLoggerSyncCommandMetrics(logger, {
      flushIntervalMs: 60_000,
      now: () => now,
      backstopTimer: false,
    })
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger,
      sync: { ...syncOptions(), apiRpc, metrics },
    })
    const issued = await attached.sync.issueTicket({
      userUuid: 'user-rpc-metric',
      sessionUuid: 'session-rpc-metric',
      deviceId: 'device-rpc-metric',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://app.example.test' })
    await opened(socket)
    const received: { type: string }[] = []
    socket.on('message', (data) => received.push(JSON.parse(data.toString()) as { type: string }))

    const frame = (type: string, sequence: number, payload: Record<string, unknown>) =>
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type,
        requestId: `rpc-${sequence}`,
        commandId: `rpc-${sequence}`,
        sequence,
        payloadLength: Buffer.byteLength(JSON.stringify(payload)),
        payload,
      })

    socket.send(frame('AUTH', 0, { ticket: issued.ticket, deviceId: 'device-rpc-metric' }))
    await vi.waitFor(() => expect(received.map((entry) => entry.type)).toContain('AUTHENTICATED'))

    // One byte of credit against an 8-byte chunk: the stream genuinely parks in
    // `consumeRpcCredit` until the client grants more.
    socket.send(
      frame('RPC_REQUEST', 1, {
        method: 'GET',
        path: '/v1/users/me',
        stream: true,
        initialCreditBytes: 1,
        deadlineMs: 5_000,
      }),
    )
    await vi.waitFor(() => expect(received.map((entry) => entry.type)).toContain('RPC_RESPONSE'))

    now = 10
    socket.send(frame('RPC_CREDIT', 2, { targetRequestId: 'rpc-1', creditBytes: 64 * 1024 }))
    await vi.waitFor(() => expect(received.map((entry) => entry.type)).toContain('RPC_END'))

    // Nothing written yet: every one of those events is inside the open window.
    expect(logger.info).not.toHaveBeenCalledWith('[ws-sync-metric]', expect.stringContaining('backpressure'))

    now = 60_000
    metrics.increment('rpc', 'window-roll')
    const lines = logger.info.mock.calls.filter(([prefix]) => prefix === '[ws-sync-metric]')
    expect(lines).toHaveLength(1)
    const window = JSON.parse(lines[0][1] as string) as {
      counts: { event: string; code?: string; count: number }[]
      samples: { event: string; code: string; count: number; max: number }[]
    }
    expect(window.counts).toContainEqual({ event: 'rpc', code: 'backpressure_wait', count: 1 })
    expect(window.samples).toContainEqual(
      expect.objectContaining({ event: 'rpc', code: 'backpressure_wait_count', count: 1 }),
    )
    expect(window.samples).toContainEqual(expect.objectContaining({ event: 'rpc', code: 'backpressure_wait_max_ms' }))
    socket.close()
  })

  it('writes one aggregate line per window however many increments land in it', async () => {
    const logger = makeLogger()
    let now = 0
    const metrics = createLoggerSyncCommandMetrics(logger, {
      flushIntervalMs: 60_000,
      now: () => now,
      backstopTimer: false,
    })

    for (let index = 0; index < 100; index += 1) {
      metrics.increment('rate_limit', 'ingress')
      metrics.observe('rpc', 'backpressure_wait_max_ms', index)
      now += 100
    }
    // 100 increments and 100 samples inside one 60s window: still silent.
    expect(logger.info).not.toHaveBeenCalled()

    now = 60_000
    metrics.increment('disconnect')

    const lines = logger.info.mock.calls.filter(([prefix]) => prefix === '[ws-sync-metric]')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0][1] as string)).toEqual({
      windowMs: 60_000,
      counts: [{ event: 'rate_limit', code: 'ingress', count: 100 }],
      samples: [{ event: 'rpc', code: 'backpressure_wait_max_ms', count: 100, sum: 4_950, max: 99 }],
    })

    // The increment that rolled the window opens the next one rather than
    // being counted twice, and `close` writes the tail.
    metrics.close()
    const after = logger.info.mock.calls.filter(([prefix]) => prefix === '[ws-sync-metric]')
    expect(after).toHaveLength(2)
    expect(JSON.parse(after[1][1] as string)).toEqual({
      windowMs: 0,
      counts: [{ event: 'disconnect', count: 1 }],
    })
  })

  it('refuses a nonsensical metric flush interval rather than silently never flushing', () => {
    expect(() => createLoggerSyncCommandMetrics(makeLogger(), { flushIntervalMs: 0 })).toThrow(
      /sync metric flush interval/,
    )
    expect(() => createLoggerSyncCommandMetrics(makeLogger(), { flushIntervalMs: Number.NaN })).toThrow(
      /sync metric flush interval/,
    )
  })

  // R1. `handler.stop()` disconnects first, which aborts the active command, so
  // a shutdown mid-SYNC_ITEMS closed 1001 over a write that had already
  // committed and the client could only learn the outcome by replaying over
  // HTTP. The drain runs before the close sweep.
  it('answers an in-flight sync command before stop() closes its socket', async () => {
    let releaseBackend!: () => void
    const backendGate = new Promise<void>((resolve) => {
      releaseBackend = resolve
    })
    const base = syncOptions()
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: {
        ...base,
        backend: {
          ...base.backend,
          execute: vi.fn(async (input: { digest: string }) => {
            await backendGate
            return { digest: input.digest, payload: { ok: true } }
          }),
        },
      },
    })
    const issued = await attached.sync.issueTicket({
      userUuid: 'user-drain',
      sessionUuid: 'session-drain',
      deviceId: 'device-drain',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://app.example.test' })
    await opened(socket)

    // The client's own view of the order: every frame, then the close.
    const observed: string[] = []
    socket.on('message', (data) => observed.push((JSON.parse(data.toString()) as { type: string }).type))
    const closed = new Promise<void>((resolve) =>
      socket.once('close', (code) => {
        observed.push(`close:${code}`)
        resolve()
      }),
    )

    const authPayload = { ticket: issued.ticket, deviceId: 'device-drain' }
    socket.send(
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type: 'AUTH',
        requestId: 'auth-drain',
        commandId: 'auth-drain',
        sequence: 0,
        payloadLength: Buffer.byteLength(JSON.stringify(authPayload)),
        payload: authPayload,
      }),
    )
    await vi.waitFor(() => expect(observed).toContain('AUTHENTICATED'))

    const body = { api: '20200115', items: [] }
    const payload = { command: 'SYNC_ITEMS', body }
    socket.send(
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type: 'COMMAND',
        requestId: 'request-drain',
        commandId: 'command-drain',
        sequence: 1,
        payloadLength: Buffer.byteLength(JSON.stringify(payload)),
        payload,
        digest: digestSyncCommandBody(body),
      }),
    )
    await vi.waitFor(() => expect(observed).toContain('ACCEPTED'))

    const stopped = attached.stop()
    // A commit landing well after shutdown began is exactly the case R1 is
    // about. The real-timer delay matters: a drain that only yields a microtask
    // would let this commit through by accident and prove nothing.
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseBackend()
    await stopped
    attached = undefined
    await closed

    expect(observed).toEqual(['AUTHENTICATED', 'ACCEPTED', 'COMMITTED', 'close:1001'])
  })

  it('refuses a frame sent during the drain with 1013 draining without losing the in-flight answer', async () => {
    let releaseBackend!: () => void
    const backendGate = new Promise<void>((resolve) => {
      releaseBackend = resolve
    })
    const base = syncOptions()
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: {
        ...base,
        backend: {
          ...base.backend,
          execute: vi.fn(async (input: { digest: string }) => {
            await backendGate
            return { digest: input.digest, payload: { ok: true } }
          }),
        },
      },
    })
    const issued = await attached.sync.issueTicket({
      userUuid: 'user-draining',
      sessionUuid: 'session-draining',
      deviceId: 'device-draining',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://app.example.test' })
    await opened(socket)
    const observed: string[] = []
    socket.on('message', (data) => observed.push((JSON.parse(data.toString()) as { type: string }).type))
    const closure = closedWithReason(socket)

    const authPayload = { ticket: issued.ticket, deviceId: 'device-draining' }
    const command = (sequence: number, requestId: string) => {
      const body = { api: '20200115', items: [], requestId }
      const payload = { command: 'SYNC_ITEMS', body }
      return JSON.stringify({
        version: 1,
        channel: 'sync',
        type: 'COMMAND',
        requestId,
        commandId: requestId,
        sequence,
        payloadLength: Buffer.byteLength(JSON.stringify(payload)),
        payload,
        digest: digestSyncCommandBody(body),
      })
    }
    socket.send(
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type: 'AUTH',
        requestId: 'auth-draining',
        commandId: 'auth-draining',
        sequence: 0,
        payloadLength: Buffer.byteLength(JSON.stringify(authPayload)),
        payload: authPayload,
      }),
    )
    await vi.waitFor(() => expect(observed).toContain('AUTHENTICATED'))
    socket.send(command(1, 'request-first'))
    await vi.waitFor(() => expect(observed).toContain('ACCEPTED'))

    const stopped = attached.stop()
    // A second command arriving mid-drain must not be admitted, and must not
    // take the first one's answer down with it by closing the socket early.
    socket.send(command(2, 'request-late'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseBackend()
    await stopped
    attached = undefined

    expect(await closure).toEqual({ code: 1013, reason: 'draining' })
    expect(observed).toEqual(['AUTHENTICATED', 'ACCEPTED', 'COMMITTED'])
  })

  it('routes owned binary FILES_V1 frames to the file session instead of the JSON parser', async () => {
    const files = {
      ready: () => true,
      metadata: vi.fn(),
      openUpload: vi.fn(),
      uploadChunk: vi.fn(),
      finishUpload: vi.fn(),
      openDownload: vi.fn(),
      readDownloadChunk: vi.fn(),
      cancel: vi.fn(),
    } as unknown as SyncFilesAdapter
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: { ...syncOptions(), files },
    })
    const issued = await attached.sync.issueTicket({
      userUuid: 'user-files',
      sessionUuid: 'session-files',
      deviceId: 'device-files',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: 'https://app.example.test',
    })
    await opened(socket)
    const payload = { ticket: issued.ticket, deviceId: 'device-files' }
    const authenticated = nextJson(socket)
    socket.send(
      JSON.stringify({
        version: 1,
        channel: 'sync',
        type: 'AUTH',
        requestId: 'auth-files',
        commandId: 'auth-files',
        sequence: 0,
        payloadLength: Buffer.byteLength(JSON.stringify(payload)),
        payload,
      }),
    )
    expect(await authenticated).toMatchObject({
      type: 'AUTHENTICATED',
      payload: { operations: expect.arrayContaining(['FILES_V1']) },
    })

    const error = nextJson(socket)
    socket.send(Buffer.from('not-a-file-frame'), { binary: true })
    expect(await error).toMatchObject({ type: 'ERROR', payload: { code: 'FILE_FRAME_MALFORMED' } })
    expect(files.uploadChunk).not.toHaveBeenCalled()
    socket.close()
  })

  it('runs a full FILES_V1 upload then download round trip over a real socket', async () => {
    // Byte-accurate storage double: the round trip only passes if every control
    // frame, binary chunk, credit grant and digest check on the real wire works.
    const stored = new Map<string, Uint8Array>()
    const staged = new Map<string, Uint8Array[]>()
    const uploadTargets = new Map<string, string>()
    const payload = Uint8Array.from({ length: 700 }, (_value, index) => (index * 7) % 251)

    const files: SyncFilesAdapter = {
      ready: () => true,
      metadata: async ({ resources }) =>
        resources.map((resource) => {
          const bytes = stored.get(resource.remoteIdentifier)
          return bytes
            ? { resource, exists: true, encryptedSize: bytes.byteLength }
            : { resource, exists: false as const }
        }),
      openUpload: async ({ descriptor }) => {
        staged.set('transfer-up', [])
        uploadTargets.set('transfer-up', descriptor.remoteIdentifier)
        return {
          transferId: 'transfer-up',
          generation: 1,
          resumeId: 'resume-up',
          nextIndex: 0,
          nextOffset: 0,
          declaredSize: descriptor.declaredSize,
        }
      },
      uploadChunk: async ({ header, bytes }) => {
        const parts = staged.get(header.transferId) as Uint8Array[]
        // Copy: the transport hands over a view onto a reusable frame buffer.
        parts[header.index] = Uint8Array.from(bytes)
        return {
          duplicate: false,
          nextIndex: header.index + 1,
          nextOffset: header.offset + bytes.byteLength,
          resumeId: 'resume-up',
        }
      },
      finishUpload: async ({ transferId, sha256 }) => {
        const parts = staged.get(transferId) as Uint8Array[]
        const joined = Buffer.concat(parts.map((part) => Buffer.from(part)))
        if (sha256Hex(joined) !== sha256) {
          throw new Error('digest mismatch')
        }
        stored.set(uploadTargets.get(transferId) as string, new Uint8Array(joined))
        return { sha256 }
      },
      openDownload: async ({ resource }) => ({
        transferId: 'transfer-down',
        generation: 1,
        resumeId: 'resume-down',
        declaredSize: (stored.get(resource.remoteIdentifier) as Uint8Array).byteLength,
        nextIndex: 0,
        nextOffset: 0,
      }),
      readDownloadChunk: async ({ index, offset, maxBytes }) => {
        const bytes = stored.get('remote-round-trip') as Uint8Array
        const slice = bytes.slice(offset, Math.min(bytes.byteLength, offset + maxBytes))
        return {
          index,
          offset,
          declaredSize: bytes.byteLength,
          bytes: slice,
          final: offset + slice.byteLength >= bytes.byteLength,
        }
      },
      cancel: async () => undefined,
    }

    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sync: { ...syncOptions(), files },
    })
    const issued = await attached.sync.issueTicket({
      userUuid: 'user-round-trip',
      sessionUuid: 'session-round-trip',
      deviceId: 'device-round-trip',
      authorization: 'Bearer server-only-credential',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://app.example.test' })
    await opened(socket)

    const controls: Array<Record<string, unknown>> = []
    const binaries: Uint8Array[] = []
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        binaries.push(new Uint8Array(data as Buffer))
        return
      }
      controls.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })

    let sequence = 0
    const send = (type: string, framePayload: Record<string, unknown>): string => {
      const requestId = `${type.toLowerCase()}-${sequence}`
      socket.send(
        JSON.stringify({
          version: 1,
          channel: 'sync',
          type,
          requestId,
          commandId: requestId,
          sequence: sequence++,
          payloadLength: Buffer.byteLength(JSON.stringify(framePayload), 'utf8'),
          payload: framePayload,
        }),
      )
      return requestId
    }
    const awaitControl = async (type: string): Promise<Record<string, unknown>> => {
      let frame: Record<string, unknown> | undefined
      await vi.waitFor(() => {
        frame = controls.find((candidate) => candidate.type === type)
        expect(frame, `waiting for ${type}; saw ${controls.map((seen) => seen.type).join(', ')}`).toBeDefined()
      })
      return frame as Record<string, unknown>
    }

    send('AUTH', { ticket: issued.ticket, deviceId: 'device-round-trip' })
    expect(await awaitControl('AUTHENTICATED')).toMatchObject({
      payload: { operations: expect.arrayContaining(['FILES_V1']) },
    })

    const resource = { ownershipType: 'user' as const, remoteIdentifier: 'remote-round-trip', fileUuid: 'file-1' }
    send('FILES_METADATA', { resources: [resource], deadlineMs: 5_000 })
    expect(await awaitControl('FILES_METADATA')).toMatchObject({
      payload: { entries: [{ exists: false }] },
    })

    send('FILES_UPLOAD_OPEN', {
      resource,
      decryptedSize: payload.byteLength,
      declaredSize: payload.byteLength,
      mimeType: 'application/octet-stream',
      deadlineMs: 5_000,
    })
    const accepted = await awaitControl('FILES_ACCEPTED')
    expect(accepted).toMatchObject({ payload: { mode: 'upload', transferId: 'transfer-up' } })

    const half = 350
    for (const [index, slice] of [payload.slice(0, half), payload.slice(half)].entries()) {
      socket.send(
        Buffer.from(
          encodeFileBinaryFrame(
            {
              kind: 'UPLOAD_CHUNK',
              requestId: 'upload-chunk',
              transferId: 'transfer-up',
              generation: 1,
              index,
              offset: index * half,
              declaredSize: payload.byteLength,
              byteLength: slice.byteLength,
              sha256: sha256Hex(slice),
              final: index === 1,
            },
            slice,
          ),
        ),
        { binary: true },
      )
      await vi.waitFor(() =>
        expect(controls.filter((frame) => frame.type === 'FILES_CHUNK_ACK')).toHaveLength(index + 1),
      )
    }

    send('FILES_UPLOAD_FINISH', {
      transferId: 'transfer-up',
      generation: 1,
      declaredSize: payload.byteLength,
      sha256: sha256Hex(payload),
      deadlineMs: 5_000,
    })
    expect(await awaitControl('FILES_COMPLETE')).toMatchObject({
      payload: { mode: 'upload', sha256: sha256Hex(payload) },
    })
    expect(stored.get('remote-round-trip')).toEqual(payload)

    controls.length = 0
    send('FILES_DOWNLOAD_OPEN', {
      resource,
      offset: 0,
      initialCreditBytes: payload.byteLength,
      deadlineMs: 5_000,
    })
    expect(await awaitControl('FILES_ACCEPTED')).toMatchObject({
      payload: { mode: 'download', declaredSize: payload.byteLength },
    })
    const completed = await awaitControl('FILES_COMPLETE')
    expect(completed).toMatchObject({ payload: { mode: 'download', sha256: sha256Hex(payload) } })

    const received = Buffer.concat(binaries.map((frame) => Buffer.from(decodeFileBinaryFrame(frame).bytes)))
    expect(new Uint8Array(received)).toEqual(payload)
    socket.close()
  })
})

describe('attach-time configuration parsing', () => {
  it('normalises the connection token ttl and refuses one jsonwebtoken would misread', async () => {
    await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig({ connectionTokenTtl: '60' }),
      logger: makeLogger(),
    })
    const { res, body } = fakeResponse()
    attached.handleMintToken(
      Object.assign(fakeRequest({ 'x-internal-secret': INTERNAL_SECRET }), {
        body: { userUuid: 'user-1', sessionUuid: 'session-1' },
      }),
      res,
    )
    const decoded = jwt.decode((body() as { token: string }).token) as { iat: number; exp: number }
    // "60" used to mean 60 ms (a 0 s token); it now means 60 seconds.
    expect(decoded.exp - decoded.iat).toBe(60)
    await attached.stop()
    attached = undefined

    for (const connectionTokenTtl of ['abc', '0', '60ms', '-5s']) {
      expect(() =>
        attachWebSocketGateway({ httpServer, config: baseConfig({ connectionTokenTtl }), logger: makeLogger() }),
      ).toThrow(/WEB_SOCKET_CONNECTION_TOKEN_TTL/)
    }
  })

  it('caps the per-user ceiling at 1024 from either the config or the attach override', async () => {
    await listen()
    expect(() =>
      attachWebSocketGateway({
        httpServer,
        config: baseConfig({ maxConnectionsPerUser: 1_025 }),
        logger: makeLogger(),
      }),
    ).toThrow(/no greater than 1024/)
    expect(() =>
      attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger(), maxConnectionsPerUser: 4_096 }),
    ).toThrow(/no greater than 1024/)
  })

  it('validates the redis namespace and passes it to both bridges as a prefix', async () => {
    await listen()
    // The gateway's own parser answers, before either bridge sees the value.
    expect(() =>
      attachWebSocketGateway({ httpServer, config: baseConfig({ redisNamespace: 'Tenant A' }), logger: makeLogger() }),
    ).toThrow('WEBSOCKET_REDIS_NAMESPACE must match ^[a-z0-9:_-]{1,64}$ when set.')

    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig({ redisNamespace: ' tenant-a ' }),
      logger: makeLogger(),
    })
    expect(attached.health().attached).toBe(true)
  })
})

describe('health()', () => {
  it('reports the push bridge, consumer, relay, sync lane and dispatch count without side effects', async () => {
    await listen()
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger() })

    expect(attached.health()).toEqual<GatewayHealth>({
      attached: true,
      pushBridge: 'redis',
      pushBridgeReady: false,
      sqsConsumerRunning: false,
      collaborationRelayHealthy: expect.any(Boolean),
      syncLane: 'down',
      pushesDispatched: 0,
    })

    // Every push transport fans out through the registry the gateway exposes.
    attached.registry.pushToUser('user-1', 'hello')
    attached.registry.pushToUser('user-2', 'hello')
    expect(attached.health().pushesDispatched).toBe(2)
    expect(attached.health().pushesDispatched).toBe(2)
  })

  it('tracks redis readiness, the sqs consumer and the sync lane live', async () => {
    await listen()
    redis.state.status = 'ready'
    let enabled = true
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig({ sqs: { queueUrl: 'http://localstack:4566/000000000000/queue' } }),
      logger: makeLogger(),
      sync: {
        isEnabled: () => enabled,
        allowedOrigins: ['https://app.example.test'],
        authorization: { ready: () => true, authorize: vi.fn(async () => ({ authorized: true as const })) },
        backend: { ready: () => true, execute: vi.fn(), status: vi.fn() } as unknown as SyncGatewayOptions['backend'],
      },
    })

    expect(attached.health()).toMatchObject({ pushBridgeReady: true, sqsConsumerRunning: true, syncLane: 'up' })
    enabled = false
    redis.state.status = 'reconnecting'
    expect(attached.health()).toMatchObject({ pushBridgeReady: false, sqsConsumerRunning: true, syncLane: 'down' })

    await attached.stop()
    expect(attached.health()).toMatchObject({ sqsConsumerRunning: false, syncLane: 'down' })
    attached = undefined
  })

  it('reports no push bridge when the redis plane was selected with no host', async () => {
    await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig({ redisHost: '' }),
      logger: makeLogger(),
      sharedState: 'redis',
    })

    expect(attached.health().pushBridge).toBe('none')
  })
})

describe('in-process shared state (C16)', () => {
  let port: number

  async function attachInProcess(
    overrides: Partial<Parameters<typeof attachWebSocketGateway>[0]> = {},
  ): Promise<ReturnType<typeof attachWebSocketGateway>> {
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      // No REDIS_HOST at all: the single container's configuration.
      config: baseConfig({ redisHost: undefined }),
      logger: makeLogger(),
      ...overrides,
    })
    return attached
  }

  function connect(query: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}/sockets${query}`)
  }

  function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  }

  function collect(socket: WebSocket): Record<string, unknown>[] {
    const received: Record<string, unknown>[] = []
    socket.on('message', (data) => {
      const raw = data.toString()
      if (raw !== 'pong') {
        try {
          received.push(JSON.parse(raw) as Record<string, unknown>)
        } catch {
          received.push({ raw })
        }
      }
    })
    return received
  }

  it('defaults to the in-process plane when no redis host is configured', async () => {
    const gateway = await attachInProcess()

    expect(gateway.health()).toMatchObject({
      attached: true,
      pushBridge: 'in-process',
      pushBridgeReady: true,
      collaborationRelayHealthy: true,
    })
    // The whole point: not one ioredis client is constructed, so there is no
    // connection to fail, no reconnect loop and no unready push bridge.
    expect(redis.state.constructed).toBe(0)
  })

  it('opens the redis plane when a host is configured, so the default is host-driven', async () => {
    port = await listen()
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger() })

    expect(attached.health().pushBridge).toBe('redis')
    expect(redis.state.constructed).toBeGreaterThan(0)
  })

  it('delivers a dispatched push to a legacy socket without any redis bridge', async () => {
    const gateway = await attachInProcess()
    const token = mintConnectionToken(
      { userUuid: 'user-in-process', sessionUuid: 'session-in-process' },
      CONNECTION_SECRET,
      '60s',
    )
    const socket = connect(`?authToken=${token}`)
    await opened(socket)
    const received = collect(socket)
    await vi.waitFor(() => expect(gateway.registry.size()).toBe(1))

    const delivered = gateway.dispatch({
      userUuid: 'user-in-process',
      message: JSON.stringify({ type: 'ITEMS_CHANGED_ON_SERVER' }),
    })

    expect(delivered).toBe(1)
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'ITEMS_CHANGED_ON_SERVER' }))
    // Counted like every other transport, so readiness reports one number.
    expect(gateway.health().pushesDispatched).toBe(1)
    // The originating session is still excluded, exactly as on the Redis path.
    expect(
      gateway.dispatch({
        userUuid: 'user-in-process',
        message: 'echo',
        originatingSessionUuid: 'session-in-process',
      }),
    ).toBe(0)

    socket.close()
  })

  it('refuses to attach when a fleet-shared composition asks for the in-process plane', async () => {
    port = await listen()

    expect(() =>
      attachWebSocketGateway({
        httpServer,
        config: baseConfig({ redisHost: undefined }),
        logger: makeLogger(),
        sharedState: 'in-process',
        sync: {
          isEnabled: () => true,
          allowedOrigins: ['https://app.example.test'],
          authorization: { ready: () => true, authorize: vi.fn(async () => ({ authorized: true as const })) },
          backend: { ready: () => true, execute: vi.fn(), status: vi.fn() } as unknown as SyncGatewayOptions['backend'],
          requireSharedState: true,
        },
      }),
    ).toThrow(/cannot require fleet-shared state on an in-process gateway/)
  })

  it('rotates the room epoch when the last editor leaves and denies a stale grant with the rotated one', async () => {
    const gateway = await attachInProcess({
      authorizeRoomJoin: (_userUuid, _room, capability) => {
        const binding = JSON.parse(capability ?? '{}') as { requestId?: string; challenge?: string; epoch?: string }
        return {
          authorized: true,
          expiresAt: Date.now() + 60_000,
          serverUpdatedAtTimestamp: 1,
          collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
          roomEpoch: binding.epoch ?? ROOM_EPOCH,
          collaborationSecurityEpoch: SECURITY_EPOCH,
          ...(binding.requestId ? { leaseRequestId: binding.requestId } : {}),
          ...(binding.challenge ? { bootstrapChallenge: binding.challenge } : {}),
        }
      },
    })
    const token = mintConnectionToken(
      { userUuid: 'user-epoch', sessionUuid: 'session-epoch' },
      CONNECTION_SECRET,
      '60s',
    )
    const socket = connect(`?authToken=${token}`)
    await opened(socket)
    const received = collect(socket)

    socket.send(
      JSON.stringify({
        t: 'room-reserve',
        room: 'rotating-room',
        requestId: 'lease-1',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
        cap: JSON.stringify({ requestId: 'lease-1' }),
      }),
    )
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ t: 'room-reserved' }))
    const reserved = received.at(-1) as { bootstrapChallenge?: string; bootstrap?: boolean }
    // First lease in an empty room elects the bootstrapper.
    expect(reserved.bootstrap).toBe(true)

    socket.send(
      JSON.stringify({
        t: 'room-join',
        room: 'rotating-room',
        requestId: 'lease-1',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
        cap: JSON.stringify({ requestId: 'lease-1', challenge: reserved.bootstrapChallenge }),
      }),
    )
    await vi.waitFor(() => expect(gateway.rooms.members('rotating-room').length).toBe(1))

    // The last editor leaves: the room's epoch rotates behind a 24 h tombstone.
    socket.send(JSON.stringify({ t: 'room-leave', room: 'rotating-room', requestId: 'lease-1' }))
    await vi.waitFor(() => expect(gateway.rooms.members('rotating-room').length).toBe(0))

    // Re-entering with the OLD epoch is refused, and the denial carries the
    // room's CURRENT epoch so the client can re-discover it (C1/C4).
    socket.send(
      JSON.stringify({
        t: 'room-reserve',
        room: 'rotating-room',
        requestId: 'lease-2',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: ROOM_EPOCH,
        cap: JSON.stringify({ requestId: 'lease-2' }),
      }),
    )
    await vi.waitFor(() =>
      expect(received.at(-1)).toMatchObject({ t: 'room-denied', room: 'rotating-room', reason: 'epoch-mismatch' }),
    )
    const denied = received.at(-1) as { roomEpoch?: string }
    expect(denied.roomEpoch).toEqual(expect.any(String))
    expect(denied.roomEpoch).not.toBe(ROOM_EPOCH)

    // And the rotated epoch is usable: the same room re-opens under it.
    socket.send(
      JSON.stringify({
        t: 'room-reserve',
        room: 'rotating-room',
        requestId: 'lease-3',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: denied.roomEpoch,
        cap: JSON.stringify({ requestId: 'lease-3', epoch: denied.roomEpoch }),
      }),
    )
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ t: 'room-reserved', requestId: 'lease-3' }))

    socket.close()
  })
})
