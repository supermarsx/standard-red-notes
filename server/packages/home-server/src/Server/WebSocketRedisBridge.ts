import {
  DomainEventInterface,
  DomainEventMessageHandlerInterface,
} from '@standardnotes/domain-events'
import Redis from 'ioredis'
import { Logger } from 'winston'

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
  private publisher: Redis | undefined
  private warned = false

  constructor(
    private readonly logger: Logger,
    private readonly redisHost: string | undefined,
    private readonly redisPort: number,
  ) {}

  private getPublisher(): Redis | undefined {
    if (!this.redisHost) {
      if (!this.warned) {
        this.logger.info('WebSocketRedisBridge: REDIS_HOST not set; realtime push bridge disabled.')
        this.warned = true
      }
      return undefined
    }
    if (!this.publisher) {
      this.publisher = new Redis({
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

  async handleError(error: Error): Promise<void> {
    this.logger.error('WebSocketRedisBridge error: %O', error)
  }
}
