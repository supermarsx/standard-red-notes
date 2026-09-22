import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Logger } from 'winston'
import Redis from 'ioredis'
import { createLogThrottle } from '@standard-red-notes/websocket-gateway'

import { WebSocketRedisBridge, WebSocketRedisPublisher } from './WebSocketRedisBridge'

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(),
}))

const EXPECTED_PUBLISHER_OPTIONS = {
  host: 'redis',
  port: 6380,
  lazyConnect: false,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 5_000,
}

describe('WebSocketRedisBridge lifecycle', () => {
  let logger: jest.Mocked<Logger>
  let publisher: jest.Mocked<WebSocketRedisPublisher>
  let createPublisher: jest.Mock

  const event = {
    type: 'WEB_SOCKET_MESSAGE_REQUESTED',
    payload: { userUuid: 'user-1', message: { encrypted: true } },
  } as never

  beforeEach(() => {
    logger = {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<Logger>
    publisher = {
      status: 'ready',
      on: jest.fn(),
      publish: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    }
    createPublisher = jest.fn().mockReturnValue(publisher)
    ;(Redis as unknown as jest.Mock).mockReturnValue(publisher)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('ignores serialized and unrelated domain events', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher })

    await bridge.handleMessage('serialized event')
    await bridge.handleMessage({ type: 'UNRELATED_EVENT', payload: {} } as never)

    expect(createPublisher).not.toHaveBeenCalled()
  })

  it('logs a disabled Redis bridge only once', async () => {
    const bridge = new WebSocketRedisBridge(logger, undefined, 6379, { createPublisher })

    bridge.connect()
    await bridge.handleMessage(event)
    await bridge.handleMessage(event)

    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('WebSocketRedisBridge: REDIS_HOST not set; realtime push bridge disabled.')
    expect(createPublisher).not.toHaveBeenCalled()
    expect(bridge.health()).toEqual({
      channel: 'websocket-messages',
      publisherStatus: 'none',
      droppedPublishes: 0,
      connectionErrors: 0,
    })
  })

  it('stays closed and names the reason once when the host disabled it (invalid namespace)', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, {
      createPublisher,
      disabledReason: 'WEBSOCKET_REDIS_NAMESPACE_INVALID (fix or unset it)',
      // No disabledSeverity given: a genuinely degraded state (an invalid
      // namespace) must default to warn, not silently drop to info.
    })

    bridge.connect()
    await bridge.handleMessage(event)
    await bridge.handleMessage(event)

    expect(createPublisher).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'WebSocketRedisBridge disabled: WEBSOCKET_REDIS_NAMESPACE_INVALID (fix or unset it)',
    )
    expect(bridge.health()).toEqual({
      channel: 'websocket-messages',
      publisherStatus: 'none',
      droppedPublishes: 0,
      connectionErrors: 0,
    })
    await bridge.close()
  })

  it('logs the disabled reason at info, not warn, when it names a healthy alternative transport', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, {
      createPublisher,
      disabledReason: 'push is delivered in-process by the attached gateway',
      disabledSeverity: 'info',
    })

    bridge.connect()
    await bridge.handleMessage(event)
    await bridge.handleMessage(event)

    expect(createPublisher).not.toHaveBeenCalled()
    // A healthy config must never warn at boot: a warning that fires on every
    // correct boot teaches operators to ignore the channel.
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      'WebSocketRedisBridge disabled: push is delivered in-process by the attached gateway',
    )
    await bridge.close()
  })

  it('publishes the event payload on the expected Redis channel without an offline queue', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6380, { createPublisher })

    await bridge.handleMessage(event)
    await bridge.handleMessage(event)

    expect(createPublisher).toHaveBeenCalledWith(EXPECTED_PUBLISHER_OPTIONS)
    expect(publisher.publish).toHaveBeenCalledWith(WebSocketRedisBridge.CHANNEL, JSON.stringify(event.payload))
    expect(publisher.publish).toHaveBeenCalledTimes(2)
    expect(createPublisher).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('opens the connection eagerly on connect() and reuses it for the first push', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6380, { createPublisher })

    bridge.connect()
    expect(createPublisher).toHaveBeenCalledTimes(1)
    expect(bridge.health().publisherStatus).toBe('ready')

    await bridge.handleMessage(event)

    expect(createPublisher).toHaveBeenCalledTimes(1)
    expect(publisher.publish).toHaveBeenCalledTimes(1)
  })

  it('uses the default Redis publisher factory', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6380)

    await bridge.handleMessage(event)

    expect(Redis).toHaveBeenCalledWith(EXPECTED_PUBLISHER_OPTIONS)
  })

  describe('namespace (WEBSOCKET_REDIS_NAMESPACE)', () => {
    it('prefixes the channel when a namespace is configured', async () => {
      const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher, namespace: 'tenant-a' })

      await bridge.handleMessage(event)

      expect(bridge.channel).toBe('tenant-a:websocket-messages')
      expect(publisher.publish).toHaveBeenCalledWith('tenant-a:websocket-messages', JSON.stringify(event.payload))
    })

    it('keeps the bare channel for an empty namespace (byte-identical to the pre-namespace wire)', () => {
      expect(WebSocketRedisBridge.channelFor(undefined)).toBe('websocket-messages')
      expect(WebSocketRedisBridge.channelFor('')).toBe('websocket-messages')
      expect(new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher, namespace: '' }).channel).toBe(
        'websocket-messages',
      )
    })

    it('applies the same rule as the gateway subscriber (no leading or trailing colon)', () => {
      expect(WebSocketRedisBridge.channelFor('prod:eu_1-a')).toBe('prod:eu_1-a:websocket-messages')
    })

    it.each(['Tenant', 'a b', '   ', 'x'.repeat(65), 'a/b', 'ns:', ':ns', 'ns:'.padEnd(70, 'x')])(
      'refuses the invalid namespace %j at construction',
      (namespace) => {
        expect(() => new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher, namespace })).toThrow(
          'WEBSOCKET_REDIS_NAMESPACE must match ^[a-z0-9:_-]{1,64}$ with no leading or trailing colon.',
        )
      },
    )
  })

  describe('failure surfacing', () => {
    it('warns once with the redacted cause and counts the dropped publish', async () => {
      publisher.publish.mockRejectedValue(Object.assign(new Error('publish unavailable'), { code: 'ECONNREFUSED' }))
      const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher })

      await bridge.handleMessage(event)

      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(
        'WebSocketRedisBridge publish failed; the realtime push was dropped (clients recover on their next sync).',
        {
          errorType: 'Error',
          errorCode: 'ECONNREFUSED',
          status: undefined,
          cause: 'publish',
          suppressedSinceLastLine: 0,
          droppedPublishes: 1,
          connectionErrors: 0,
        },
      )
      expect(logger.debug).not.toHaveBeenCalled()
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('publish unavailable')
      expect(bridge.health().droppedPublishes).toBe(1)
    })

    it('suppresses a second failure inside the throttle window but keeps counting it', async () => {
      publisher.publish.mockRejectedValue(new Error('publish unavailable'))
      let clock = 1_000
      const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, {
        createPublisher,
        throttle: createLogThrottle({ intervalMs: 60_000, now: () => clock }),
      })

      await bridge.handleMessage(event)
      clock += 59_999
      await bridge.handleMessage(event)
      await bridge.handleMessage(event)

      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(bridge.health().droppedPublishes).toBe(3)

      clock += 1
      await bridge.handleMessage(event)

      expect(logger.warn).toHaveBeenCalledTimes(2)
      expect(logger.warn).toHaveBeenLastCalledWith(
        expect.stringContaining('publish failed'),
        expect.objectContaining({ suppressedSinceLastLine: 2, droppedPublishes: 4 }),
      )
    })

    it('warns (throttled per cause) on a publisher connection error without leaking its message', async () => {
      const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher })

      bridge.connect()
      const redisErrorHandler = publisher.on.mock.calls[0][1]
      redisErrorHandler(new Error('redis unavailable'))
      redisErrorHandler(new Error('redis unavailable'))

      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(
        'WebSocketRedisBridge redis connection error; pushes are dropped until it reconnects.',
        expect.objectContaining({ cause: 'connection', connectionErrors: 1, droppedPublishes: 0 }),
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('redis unavailable')
      expect(bridge.health().connectionErrors).toBe(2)
    })

    it('throttles the two causes independently', async () => {
      publisher.publish.mockRejectedValue(new Error('publish unavailable'))
      const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher })

      await bridge.handleMessage(event)
      publisher.on.mock.calls[0][1](new Error('redis unavailable'))

      expect(logger.warn).toHaveBeenCalledTimes(2)
      expect(logger.warn.mock.calls.map(([, metadata]) => (metadata as { cause: string }).cause)).toEqual([
        'publish',
        'connection',
      ])
    })
  })

  it('quits the lazily-created Redis publisher and can create a fresh one after close', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher })

    await bridge.handleMessage(event)
    await bridge.close()
    expect(bridge.health().publisherStatus).toBe('none')
    await bridge.handleMessage(event)

    expect(publisher.quit).toHaveBeenCalledTimes(1)
    expect(createPublisher).toHaveBeenCalledTimes(2)
  })

  it('falls back to a hard disconnect when graceful Redis shutdown fails', async () => {
    publisher.quit.mockRejectedValue(new Error('connection lost'))
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher })

    await bridge.handleMessage(event)
    await bridge.close()

    expect(publisher.disconnect).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledWith('WebSocketRedisBridge graceful close failed.')
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('connection lost')
  })

  it('does not allocate Redis merely to close a disabled bridge', async () => {
    const bridge = new WebSocketRedisBridge(logger, undefined, 6379, { createPublisher })

    await bridge.close()

    expect(createPublisher).not.toHaveBeenCalled()
  })

  it('forwards domain subscriber errors to the logger', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, { createPublisher })
    const error = new Error('handler failed')

    await bridge.handleError(error)

    expect(logger.error).toHaveBeenCalledWith('WebSocketRedisBridge domain subscriber error.')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('handler failed')
  })
})

describe('WEB_SOCKET_MESSAGE_REQUESTED wire contract', () => {
  // The publisher leg of the shared fixture. The producer (syncing-server) and
  // the consumer (websocket-gateway) assert the same file, so none of the three
  // packages that make up the push path can change the shape on its own.
  const fixture = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../websocket-gateway/test/fixtures/websocket-message-requested.json'),
      'utf8',
    ),
  ) as {
    type: string
    channel: string
    payload: { userUuid: string; message: string; originatingSessionUuid: string }
  }

  it('publishes the fixture payload verbatim on the fixture channel', async () => {
    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<Logger>
    const publisher = {
      status: 'ready',
      on: jest.fn(),
      publish: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    } as unknown as jest.Mocked<WebSocketRedisPublisher>
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, {
      createPublisher: jest.fn().mockReturnValue(publisher),
    })

    expect(WebSocketRedisBridge.channelFor(undefined)).toBe(fixture.channel)

    bridge.connect()
    await bridge.handleMessage({ type: fixture.type, payload: fixture.payload } as never)

    // The gateway parses exactly this string, so the bridge must not reshape it.
    expect(publisher.publish).toHaveBeenCalledWith(fixture.channel, JSON.stringify(fixture.payload))
  })
})
