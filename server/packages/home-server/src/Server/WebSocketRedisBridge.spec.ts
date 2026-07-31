import { Logger } from 'winston'
import Redis from 'ioredis'

import { WebSocketRedisBridge, WebSocketRedisPublisher } from './WebSocketRedisBridge'

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(),
}))

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
    } as unknown as jest.Mocked<Logger>
    publisher = {
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
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, createPublisher)

    await bridge.handleMessage('serialized event')
    await bridge.handleMessage({ type: 'UNRELATED_EVENT', payload: {} } as never)

    expect(createPublisher).not.toHaveBeenCalled()
  })

  it('logs a disabled Redis bridge only once', async () => {
    const bridge = new WebSocketRedisBridge(logger, undefined, 6379, createPublisher)

    await bridge.handleMessage(event)
    await bridge.handleMessage(event)

    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('WebSocketRedisBridge: REDIS_HOST not set; realtime push bridge disabled.')
    expect(createPublisher).not.toHaveBeenCalled()
  })

  it('publishes the event payload on the expected Redis channel', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6380, createPublisher)

    await bridge.handleMessage(event)
    await bridge.handleMessage(event)

    expect(createPublisher).toHaveBeenCalledWith({
      host: 'redis',
      port: 6380,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    })
    expect(publisher.publish).toHaveBeenCalledWith(WebSocketRedisBridge.CHANNEL, JSON.stringify(event.payload))
    expect(createPublisher).toHaveBeenCalledTimes(1)
  })

  it('uses the default Redis publisher factory', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379)

    await bridge.handleMessage(event)

    expect(Redis).toHaveBeenCalledWith({
      host: 'redis',
      port: 6379,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    })
  })

  it('logs publisher connection and publish failures', async () => {
    publisher.publish.mockRejectedValue(new Error('publish unavailable'))
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, createPublisher)

    await bridge.handleMessage(event)
    const redisErrorHandler = publisher.on.mock.calls[0][1]
    redisErrorHandler(new Error('redis unavailable'))

    expect(logger.debug).toHaveBeenCalledWith('WebSocketRedisBridge publish failed.')
    expect(logger.debug).toHaveBeenCalledWith('WebSocketRedisBridge redis connection error.')
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('publish unavailable')
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('redis unavailable')
  })

  it('quits the lazily-created Redis publisher and can create a fresh one after close', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, createPublisher)

    await bridge.handleMessage(event)
    await bridge.close()
    await bridge.handleMessage(event)

    expect(publisher.quit).toHaveBeenCalledTimes(1)
    expect(createPublisher).toHaveBeenCalledTimes(2)
  })

  it('falls back to a hard disconnect when graceful Redis shutdown fails', async () => {
    publisher.quit.mockRejectedValue(new Error('connection lost'))
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, createPublisher)

    await bridge.handleMessage(event)
    await bridge.close()

    expect(publisher.disconnect).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledWith('WebSocketRedisBridge graceful close failed.')
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('connection lost')
  })

  it('does not allocate Redis merely to close a disabled bridge', async () => {
    const bridge = new WebSocketRedisBridge(logger, undefined, 6379, createPublisher)

    await bridge.close()

    expect(createPublisher).not.toHaveBeenCalled()
  })

  it('forwards domain subscriber errors to the logger', async () => {
    const bridge = new WebSocketRedisBridge(logger, 'redis', 6379, createPublisher)
    const error = new Error('handler failed')

    await bridge.handleError(error)

    expect(logger.error).toHaveBeenCalledWith('WebSocketRedisBridge domain subscriber error.')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('handler failed')
  })
})
