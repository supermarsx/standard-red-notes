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
  }

  class FakeRedisClient {
    constructor(readonly options: Record<string, unknown>) {}
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
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WebSocketIngressLimiter,
  WebSocketRelayBacklog,
  type GatewayConfig,
  type SyncFilesAdapter,
  type SyncGatewayOptions,
} from '../src/gateway.js'
import { decodeFileBinaryFrame, encodeFileBinaryFrame, sha256Hex } from '../src/filesProtocol.js'
import { InMemorySyncAuthTicketStore, mintConnectionToken } from '../src/auth.js'
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

/** A request double: headers plus an optional raw body streamed on 'data'/'end'. */
function fakeRequest(headers: Record<string, unknown>, rawBody?: string): IncomingMessage {
  const stream = rawBody === undefined ? new Readable({ read() {} }) : Readable.from([rawBody])

  return Object.assign(stream, { headers, destroy: vi.fn(stream.destroy.bind(stream)) }) as unknown as IncomingMessage
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
    expect(logger.info).toHaveBeenCalledWith('[token] minted (x-auth) user=user-1')
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
    expect(logger.info).toHaveBeenCalledWith('[token] minted user=user-9')
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
    return new WebSocket(`ws://127.0.0.1:${port}/${query}`)
  }

  function closedWith(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => socket.once('close', (code) => resolve(code)))
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

    expect(await closedWith(socket)).toBe(1008)
    expect(attached!.registry.size()).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith('[ws] connection rejected: missing authToken')
  })

  it('closes a connection whose authToken does not verify', async () => {
    await attachGateway()
    const forged = jwt.sign({ userUuid: 'user-1', sessionUuid: 'session-1' }, 'wrong-secret', { algorithm: 'HS256' })
    const socket = connect(`?authToken=${forged}`)

    expect(await closedWith(socket)).toBe(1008)
    expect(attached!.registry.size()).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith('[ws] connection rejected: bad token', {
      errorType: 'Error',
      errorCode: undefined,
    })
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

  it('rejects the N+1 socket at the per-user ceiling and reclaims the user bucket on close', async () => {
    await attachGateway({ maxConnectionsPerUser: 2 })
    const token = mintConnectionToken({ userUuid: 'user-tabs', sessionUuid: 'session-tabs' }, CONNECTION_SECRET, '60s')
    const first = connect(`?authToken=${token}`)
    const second = connect(`?authToken=${token}`)
    await Promise.all([opened(first), opened(second)])
    await vi.waitFor(() => expect(attached!.registry.get('user-tabs')).toHaveLength(2))

    const rejected = connect(`?authToken=${token}`)
    expect(await closedWith(rejected)).toBe(1008)
    expect(attached!.registry.get('user-tabs')).toHaveLength(2)
    expect(logger.warn).toHaveBeenCalledWith('[ws] connection rejected: per-user limit user=user-tabs')

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
      logger.info.mock.calls.filter(([message]) => String(message).includes('disconnect user=user-race')),
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
    const authorizeRoomJoin = vi.fn(
      (): RoomJoinAuthorization => ({
        authorized: true,
        expiresAt: Date.now() + 60_000,
        serverUpdatedAtTimestamp: 1,
        collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
        roomEpoch: ROOM_EPOCH,
        collaborationSecurityEpoch: SECURITY_EPOCH,
      }),
    )
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
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[ws] ingress rate exceeded user=user-frames'))
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
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[ws] ingress rate exceeded user=user-bytes'))
  })

  it('closes a socket before a slow relay lifecycle can retain an unbounded frame backlog', async () => {
    let releaseEval!: () => void
    redis.state.evalGate = new Promise<void>((resolve) => {
      releaseEval = resolve
    })
    try {
      await attachGateway({
        relayBacklogLimits: { frameCapacity: 3, byteCapacity: 64 * 1024 },
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
        { userUuid: 'user-relay-frames', sessionUuid: 'session-relay-frames' },
        CONNECTION_SECRET,
        '60s',
      )
      const socket = connect(`?authToken=${token}`)
      await opened(socket)
      socket.send(
        JSON.stringify({
          t: 'room-reserve',
          room: 'slow-frame-room',
          cap: 'slow-frame-lease',
          requestId: 'slow-frame-lease',
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          expectedRoomEpoch: ROOM_EPOCH,
        }),
      )
      await vi.waitFor(() => expect(redis.state.evalCalls).toBe(1))

      const closed = closedWith(socket)
      for (let index = 0; index < 4; index += 1) {
        socket.send(JSON.stringify({ t: 'room-leave', room: 'slow-frame-room', requestId: `queued-${index}` }))
      }
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('[ws] relay backlog exceeded user=user-relay-frames'),
        ),
      )
      redis.state.evalGate = undefined
      releaseEval()

      expect(await closed).toBe(1008)
      await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))
      expect(attached!.rooms.roomCount()).toBe(0)
    } finally {
      redis.state.evalGate = undefined
      releaseEval?.()
    }
  })

  it('closes a socket when a slow relay lifecycle exceeds the retained-byte ceiling', async () => {
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

      const closed = closedWith(socket)
      socket.send(JSON.stringify({ t: 'room-leave', room: 'slow-byte-room', requestId: 'queued-byte-frame' }))
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('[ws] relay backlog exceeded user=user-relay-bytes'),
        ),
      )
      redis.state.evalGate = undefined
      releaseEval()

      expect(await closed).toBe(1008)
      await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))
      expect(attached!.rooms.roomCount()).toBe(0)
    } finally {
      redis.state.evalGate = undefined
      releaseEval?.()
    }
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
    expect(JSON.parse(await denied)).toEqual({ t: 'room-denied', room: 'note-1' })
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
    expect(JSON.parse(await denied)).toEqual({ t: 'room-denied', room: 'note-1' })
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
        `ws://127.0.0.1:${port}/?authToken=${mintConnectionToken(
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
        `ws://127.0.0.1:${port}/?authToken=${mintConnectionToken(
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

  async function invokeSyncTicket(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const capture = fakeResponse()
    attached!.handleSyncTicket(req, capture.res)
    await vi.waitFor(() => expect(capture.status()).toBeGreaterThan(0))
    return { status: capture.status(), body: capture.body() }
  }

  it('advertises no capability unless every adapter and kill switch is ready', async () => {
    await listen()
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger() })
    expect(attached.sync.capabilities()).toEqual({ capabilities: [] })
    await expect(
      attached.sync.issueTicket({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' }),
    ).rejects.toThrow(/unavailable/i)

    const capabilityResponse = fakeResponse()
    attached.handleSyncCapabilities(fakeRequest({}), capabilityResponse.res)
    expect(capabilityResponse.status()).toBe(200)
    expect(capabilityResponse.body()).toEqual({ capabilities: [] })

    const disabledTicket = await invokeSyncTicket(fakeRequest({}))
    expect(disabledTicket).toEqual({ status: 503, body: { error: { code: 'SYNC_DISABLED' } } })
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

    await attached.stop()
    expect(clear).toHaveBeenCalledTimes(1)
    await expect(tickets.consume(issued.ticket)).resolves.toBeUndefined()
    await expect(attached.stop()).resolves.toBeUndefined()
    attached = undefined
  })

  it('issues HTTPS tickets through forwarded or internal authentication and rejects invalid input', async () => {
    await attachSync()
    const crossServiceToken = jwt.sign({ user: { uuid: 'user-1' }, session: { uuid: 'session-1' } }, AUTH_SECRET, {
      algorithm: 'HS256',
    })
    const forwardedRequest = Object.assign(fakeRequest({ 'x-auth-token': crossServiceToken }), {
      body: { deviceId: 'device-1' },
    })
    const forwarded = await invokeSyncTicket(forwardedRequest)
    expect(forwarded).toMatchObject({
      status: 200,
      body: { endpoint: '/sockets/sync', capability: 'ws-sync', version: 1 },
    })
    expect((forwarded.body as { ticket: string }).ticket).not.toContain('user-1')

    const internalRequest = Object.assign(fakeRequest({ 'x-internal-secret': INTERNAL_SECRET }), {
      body: { deviceId: 'device-2', userUuid: 'user-2', sessionUuid: 'session-2' },
    })
    expect(await invokeSyncTicket(internalRequest)).toMatchObject({ status: 200 })

    const badDevice = Object.assign(fakeRequest({ 'x-auth-token': crossServiceToken }), {
      body: { deviceId: '../bad' },
    })
    expect(await invokeSyncTicket(badDevice)).toEqual({
      status: 400,
      body: { error: { code: 'INVALID_DEVICE' } },
    })

    const forged = Object.assign(fakeRequest({ 'x-auth-token': 'not-a-jwt' }), {
      body: { deviceId: 'device-1' },
    })
    expect(await invokeSyncTicket(forged)).toEqual({
      status: 401,
      body: { error: { code: 'AUTH_REJECTED' } },
    })

    const incompleteInternal = Object.assign(fakeRequest({ 'x-internal-secret': INTERNAL_SECRET }), {
      body: { deviceId: 'device-1', userUuid: 'user-1' },
    })
    expect(await invokeSyncTicket(incompleteInternal)).toEqual({
      status: 401,
      body: { error: { code: 'AUTH_REJECTED' } },
    })
  })

  it('bounds and validates streamed ticket bodies before authentication', async () => {
    await attachSync()
    const malformed = await mintWithStreamedBody(attached!.handleSyncTicket, {}, '{')
    expect(malformed).toEqual({ status: 400, body: { error: { code: 'INVALID_DEVICE' } } })

    const nonObject = await mintWithStreamedBody(attached!.handleSyncTicket, {}, '[]')
    expect(nonObject).toEqual({ status: 400, body: { error: { code: 'INVALID_DEVICE' } } })

    const oversized = await mintWithStreamedBody(attached!.handleSyncTicket, {}, 'x'.repeat(16_385))
    expect(oversized).toEqual({ status: 400, body: { error: { code: 'INVALID_DEVICE' } } })
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
    const crossServiceToken = jwt.sign({ user: { uuid: 'user-1' }, session: { uuid: 'session-1' } }, AUTH_SECRET, {
      algorithm: 'HS256',
    })
    const request = Object.assign(fakeRequest({ 'x-auth-token': crossServiceToken }), {
      body: { deviceId: 'device-1' },
    })

    expect(await invokeSyncTicket(request)).toEqual({
      status: 503,
      body: { error: { code: 'SYNC_DISABLED' } },
    })
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

  it('registers logger-backed production metrics and closes a sync frame above 512KiB before JSON parsing', async () => {
    port = await listen()
    const logger = makeLogger()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger,
      sync: { ...syncOptions(), metrics: createLoggerSyncCommandMetrics(logger) },
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, {
      origin: 'https://app.example.test',
    })
    await opened(socket)
    const closed = closedWith(socket)
    socket.send('x'.repeat(512 * 1024 + 1))
    expect(await closed).toBe(1009)
    expect(logger.info).toHaveBeenCalledWith(
      '[ws-sync-metric]',
      JSON.stringify({ event: 'protocol', code: 'FRAME_TOO_LARGE' }),
    )
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
