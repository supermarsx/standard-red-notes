import { DomainEventInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events'
import Redis, { RedisOptions } from 'ioredis'
import { Logger } from 'winston'

export interface WebSocketRedisPublisher {
  on(event: 'error', listener: (error: Error) => void): unknown
  publish(channel: string, message: string): Promise<unknown>
  quit(): Promise<unknown>
  disconnect(): void
}

/**
 * Bridges the in-process `WEB_SOCKET_MESSAGE_REQUESTED` domain event onto a
 * Redis pub/sub channel so the self-hosted WebSocket gateway (a separate
 * process holding the live browser/agent sockets) can push it to clients.
 *
 * In home-server mode events are dispatched in-process via
 * DirectCallDomainEventPublisher and the AWS-based websockets push package is
 * dormant; this handler is what makes realtime push work without AWS.
 *
 * No-op (logs once) when REDIS_HOST is unset, so non-Redis deployments are
 * unaffected.
 */
export class WebSocketRedisBridge implements DomainEventMessageHandlerInterface {
  static readonly CHANNEL = 'websocket-messages'
  private publisher: WebSocketRedisPublisher | undefined
  private warned = false

  constructor(
    private readonly logger: Logger,
    private readonly redisHost: string | undefined,
    private readonly redisPort: number,
    private readonly createPublisher: (options: RedisOptions) => WebSocketRedisPublisher = (options) =>
      new Redis(options),
  ) {}

  private getPublisher(): WebSocketRedisPublisher | undefined {
    if (!this.redisHost) {
      if (!this.warned) {
        this.logger.info('WebSocketRedisBridge: REDIS_HOST not set; realtime push bridge disabled.')
        this.warned = true
      }
      return undefined
    }
    if (!this.publisher) {
      this.publisher = this.createPublisher({
        host: this.redisHost,
        port: this.redisPort,
        lazyConnect: false,
        maxRetriesPerRequest: 1,
      })
      this.publisher.on('error', (error) => {
        this.logger.debug(`WebSocketRedisBridge redis error: ${(error as Error).message}`)
      })
    }
    return this.publisher
  }

  async handleMessage(messageOrEvent: string | DomainEventInterface): Promise<void> {
    if (typeof messageOrEvent === 'string') {
      return
    }
    if (messageOrEvent.type !== 'WEB_SOCKET_MESSAGE_REQUESTED') {
      return
    }
    const publisher = this.getPublisher()
    if (!publisher) {
      return
    }
    try {
      // payload = { userUuid, message, originatingSessionUuid? } — forwarded verbatim.
      await publisher.publish(WebSocketRedisBridge.CHANNEL, JSON.stringify(messageOrEvent.payload))
    } catch (error) {
      this.logger.debug(`WebSocketRedisBridge publish failed: ${(error as Error).message}`)
    }
  }

  async close(): Promise<void> {
    const publisher = this.publisher
    this.publisher = undefined
    if (!publisher) {
      return
    }

    try {
      await publisher.quit()
    } catch (error) {
      this.logger.debug(`WebSocketRedisBridge graceful close failed: ${(error as Error).message}`)
      publisher.disconnect()
    }
  }

  async handleError(error: Error): Promise<void> {
    this.logger.error('WebSocketRedisBridge error: %O', error)
  }
}
