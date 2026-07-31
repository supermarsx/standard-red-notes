import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => void

interface FakeRedis {
  options: Record<string, unknown>
  subscriptions: string[]
  subscribeCallback?: (err: Error | null | undefined, count?: number) => void
  emit(event: string, ...args: unknown[]): void
}

/** Records everything `startRedisBridge` does to its ioredis client. */
const redis = vi.hoisted(() => {
  const instances: FakeRedis[] = []

  class FakeRedisClient implements FakeRedis {
    readonly handlers = new Map<string, Handler[]>()
    readonly subscriptions: string[] = []
    subscribeCallback?: (err: Error | null | undefined, count?: number) => void

    constructor(readonly options: Record<string, unknown>) {
      instances.push(this)
    }

    on(event: string, handler: Handler): this {
      const existing = this.handlers.get(event) ?? []
      existing.push(handler)
      this.handlers.set(event, existing)

      return this
    }

    subscribe(channel: string, callback: (err: Error | null | undefined, count?: number) => void): void {
      this.subscriptions.push(channel)
      this.subscribeCallback = callback
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args)
      }
    }
  }

  return { instances, FakeRedisClient }
})

vi.mock('ioredis', () => ({ Redis: redis.FakeRedisClient }))

import { WEBSOCKET_MESSAGES_CHANNEL, startRedisBridge } from '../src/redisBridge.js'
import { ConnectionRegistry, type Conn, type SendableSocket } from '../src/registry.js'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeRegistry(): {
  registry: InstanceType<typeof ConnectionRegistry<SendableSocket>>
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const socket: SendableSocket = { send }
  const registry = new ConnectionRegistry<SendableSocket>()
  const conn: Conn<SendableSocket> = {
    socket,
    userUuid: 'user-1',
    sessionUuid: 'session-1',
    connectionId: 'conn-1',
  }
  registry.add('user-1', conn)

  return { registry, send }
}

beforeEach(() => {
  redis.instances.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('startRedisBridge', () => {
  it('constructs the client with a bounded exponential reconnect backoff capped at 5s', () => {
    startRedisBridge(makeRegistry().registry, { host: 'redis.internal', port: 6380, logger: makeLogger() })

    const [client] = redis.instances
    expect(client.options.host).toBe('redis.internal')
    expect(client.options.port).toBe(6380)
    expect(client.options.lazyConnect).toBe(false)
    expect(client.options.maxRetriesPerRequest).toBeNull()

    const retryStrategy = client.options.retryStrategy as (times: number) => number
    expect(retryStrategy(1)).toBe(200)
    expect(retryStrategy(10)).toBe(2000)
    // Capped, so a long outage never backs off further than 5s.
    expect(retryStrategy(100)).toBe(5000)
    expect(retryStrategy(1_000_000)).toBe(5000)
  })

  it('subscribes to the websocket-messages channel and returns the client', () => {
    const client = startRedisBridge(makeRegistry().registry, { host: 'h', port: 1, logger: makeLogger() })

    expect(WEBSOCKET_MESSAGES_CHANNEL).toBe('websocket-messages')
    expect(redis.instances[0].subscriptions).toEqual([WEBSOCKET_MESSAGES_CHANNEL])
    expect(client).toBe(redis.instances[0])
  })

  it('logs a connection error without throwing', () => {
    const logger = makeLogger()
    startRedisBridge(makeRegistry().registry, { host: 'h', port: 1, logger })

    redis.instances[0].emit('error', new Error('ECONNREFUSED'))
    expect(logger.error).toHaveBeenCalledWith('[redis] connection error', {
      errorType: 'Error',
      errorCode: undefined,
    })

    redis.instances[0].emit('error', 'plain string failure')
    expect(logger.error).toHaveBeenCalledWith('[redis] connection error', {
      errorType: 'Error',
      errorCode: undefined,
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('plain string failure')
  })

  it('logs host and port once the client reports ready', () => {
    const logger = makeLogger()
    startRedisBridge(makeRegistry().registry, { host: 'cache', port: 6379, logger })

    redis.instances[0].emit('ready')
    expect(logger.info).toHaveBeenCalledWith('[redis] connected cache:6379')
  })

  it('logs the subscribed channel count on a successful subscribe', () => {
    const logger = makeLogger()
    startRedisBridge(makeRegistry().registry, { host: 'h', port: 1, logger })

    redis.instances[0].subscribeCallback?.(null, 3)
    expect(logger.info).toHaveBeenCalledWith(`[redis] subscribed to ${WEBSOCKET_MESSAGES_CHANNEL} (3 channels)`)
  })

  it('logs and gives up quietly when the subscribe fails', () => {
    const logger = makeLogger()
    startRedisBridge(makeRegistry().registry, { host: 'h', port: 1, logger })

    redis.instances[0].subscribeCallback?.(new Error('NOPERM'))
    expect(logger.error).toHaveBeenCalledWith('[redis] subscribe failed', {
      errorType: 'Error',
      errorCode: undefined,
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('NOPERM')
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('subscribed to'))
  })

  it('dispatches a message published on the websocket-messages channel', () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    startRedisBridge(registry, { host: 'h', port: 1, logger })

    redis.instances[0].emit(
      'message',
      WEBSOCKET_MESSAGES_CHANNEL,
      JSON.stringify({ userUuid: 'user-1', message: 'payload-a' }),
    )

    expect(send).toHaveBeenCalledWith('payload-a')
    expect(logger.info).toHaveBeenCalledWith('[push] dispatched websocket message', {
      userId: 'user-1',
      socketCount: 1,
      originExcluded: false,
    })
  })

  it('ignores messages published on any other channel', () => {
    const { registry, send } = makeRegistry()
    startRedisBridge(registry, { host: 'h', port: 1, logger: makeLogger() })

    redis.instances[0].emit(
      'message',
      'some-other-channel',
      JSON.stringify({ userUuid: 'user-1', message: 'payload-a' }),
    )

    expect(send).not.toHaveBeenCalled()
  })

  it('drops a malformed payload without dispatching it', () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    startRedisBridge(registry, { host: 'h', port: 1, logger })

    redis.instances[0].emit('message', WEBSOCKET_MESSAGES_CHANNEL, '{ not json')

    expect(send).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('[redis] dropping malformed message', {
      errorType: 'Error',
      errorCode: undefined,
    })
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('{ not json')
  })

  it('excludes the originating session from a dispatched message', () => {
    const send = vi.fn()
    const otherSend = vi.fn()
    const registry = new ConnectionRegistry<SendableSocket>()
    registry.add('user-1', {
      socket: { send },
      userUuid: 'user-1',
      sessionUuid: 'session-origin',
      connectionId: 'c1',
    })
    registry.add('user-1', {
      socket: { send: otherSend },
      userUuid: 'user-1',
      sessionUuid: 'session-other',
      connectionId: 'c2',
    })
    const logger = makeLogger()
    startRedisBridge(registry, { host: 'h', port: 1, logger })

    redis.instances[0].emit(
      'message',
      WEBSOCKET_MESSAGES_CHANNEL,
      JSON.stringify({ userUuid: 'user-1', message: 'm', originatingSessionUuid: 'session-origin' }),
    )

    expect(send).not.toHaveBeenCalled()
    expect(otherSend).toHaveBeenCalledWith('m')
    expect(logger.info).toHaveBeenCalledWith('[push] dispatched websocket message', {
      userId: 'user-1',
      socketCount: 1,
      originExcluded: true,
    })
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('session-origin')
  })
})
