import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'

const redis = vi.hoisted(() => {
  const state = { quitCalls: 0, disconnectCalls: 0, quitRejects: false }

  class FakeRedisClient {
    constructor(readonly options: Record<string, unknown>) {}
    on(): this {
      return this
    }
    subscribe(): void {}
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

import { attachWebSocketGateway, defaultRoomJoinAuthorizer, type GatewayConfig } from '../src/gateway.js'
import { mintConnectionToken } from '../src/auth.js'

const CONNECTION_SECRET = 'connection-secret'
const AUTH_SECRET = 'auth-jwt-secret'
const INTERNAL_SECRET = 'internal-secret'

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
    expect(redis.state.quitCalls).toBe(1)
    expect(redis.state.disconnectCalls).toBe(0)

    redis.state.quitRejects = true
    attached = attachWebSocketGateway({ httpServer, config: baseConfig(), logger: makeLogger() })
    await attached.stop()
    expect(redis.state.quitCalls).toBe(2)
    expect(redis.state.disconnectCalls).toBe(1)
    attached = undefined
  })
})

describe('defaultRoomJoinAuthorizer', () => {
  const authorizer = defaultRoomJoinAuthorizer(CONNECTION_SECRET)

  function capability(claims: Record<string, unknown>): string {
    return jwt.sign(claims, CONNECTION_SECRET, { algorithm: 'HS256', expiresIn: '60s' })
  }

  it('admits a capability minted for exactly this user and room', () => {
    const cap = capability({ purpose: 'collab-room', userUuid: 'user-1', room: 'note-1' })
    expect(authorizer('user-1', 'note-1', cap)).toBe(true)
  })

  it('denies a join with no capability at all', () => {
    expect(authorizer('user-1', 'note-1', undefined)).toBe(false)
  })

  it('denies a capability issued for a different room', () => {
    const cap = capability({ purpose: 'collab-room', userUuid: 'user-1', room: 'note-OTHER' })
    expect(authorizer('user-1', 'note-1', cap)).toBe(false)
  })

  it('denies a capability issued for a different user', () => {
    const cap = capability({ purpose: 'collab-room', userUuid: 'user-OTHER', room: 'note-1' })
    expect(authorizer('user-1', 'note-1', cap)).toBe(false)
  })

  it('denies a capability signed with the wrong secret', () => {
    const cap = jwt.sign({ purpose: 'collab-room', userUuid: 'user-1', room: 'note-1' }, 'other-secret', {
      algorithm: 'HS256',
    })
    expect(authorizer('user-1', 'note-1', cap)).toBe(false)
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
    expect(logger.info).toHaveBeenCalledWith('[token] minted (x-auth) user=user-1 session=session-1')
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
    expect(logger.info).toHaveBeenCalledWith('[token] minted user=user-9 session=session-9')
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
    expect(logger.warn).toHaveBeenCalledWith('[ws] connection rejected: bad token', expect.any(String))
  })

  it('registers a connection presenting a valid token and deregisters it on close', async () => {
    await attachGateway()
    const token = mintConnectionToken({ userUuid: 'user-1', sessionUuid: 'session-1' }, CONNECTION_SECRET, '60s')
    const socket = connect(`?authToken=${token}`)
    await opened(socket)
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(1))

    socket.close()
    await vi.waitFor(() => expect(attached!.registry.size()).toBe(0))
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

  it('relays a yjs frame between two sockets that joined the same room', async () => {
    await attachGateway({ authorizeRoomJoin: () => true })
    const tokenA = mintConnectionToken({ userUuid: 'user-A', sessionUuid: 'session-A' }, CONNECTION_SECRET, '60s')
    const tokenB = mintConnectionToken({ userUuid: 'user-B', sessionUuid: 'session-B' }, CONNECTION_SECRET, '60s')
    const socketA = connect(`?authToken=${tokenA}`)
    const socketB = connect(`?authToken=${tokenB}`)
    await Promise.all([opened(socketA), opened(socketB)])

    socketA.send(JSON.stringify({ t: 'room-join', room: 'note-1' }))
    await vi.waitFor(() => expect(attached!.rooms.members('note-1').length).toBe(1))
    socketB.send(JSON.stringify({ t: 'room-join', room: 'note-1' }))
    await vi.waitFor(() => expect(attached!.rooms.members('note-1').length).toBe(2))

    const relayed = nextMessage(socketB)
    socketA.send(JSON.stringify({ t: 'yjs', room: 'note-1', payload: 'update-1' }))
    expect(JSON.parse(await relayed)).toMatchObject({ t: 'yjs', room: 'note-1', payload: 'update-1' })

    socketA.close()
    socketB.close()
  })

  it('denies a room join that the authorizer rejects', async () => {
    await attachGateway({ authorizeRoomJoin: () => false })
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
