import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { DomainEventInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events'
import {
  createLogThrottle,
  namespacedPushChannel,
  WEBSOCKET_MESSAGES_CHANNEL,
  type LogThrottle,
} from '@standard-red-notes/websocket-gateway'
import Redis, { RedisOptions } from 'ioredis'
import { Logger } from 'winston'

export interface WebSocketRedisPublisher {
  /** ioredis connection state; `'ready'` once the socket is usable. */
  status?: string
  on(event: 'error', listener: (error: Error) => void): unknown
  publish(channel: string, message: string): Promise<unknown>
  quit(): Promise<unknown>
  disconnect(): void
}

export interface WebSocketRedisBridgeOptions {
  /**
   * WEBSOCKET_REDIS_NAMESPACE. Empty/undefined publishes on the bare
   * `websocket-messages` channel (byte-identical to the pre-namespace wire);
   * a non-empty value prefixes it as `<namespace>:websocket-messages`, which is
   * the channel the in-process gateway subscribes to under the same variable.
   */
  namespace?: string
  /**
   * When set, the bridge never opens Redis and logs this reason once (at warn)
   * instead of the "REDIS_HOST not set" line: the host decided at its gate that
   * the shared Redis must not be touched (e.g. an invalid namespace would
   * publish on the un-namespaced channel of a sibling stack).
   */
  disabledReason?: string
  /**
   * Level of the `disabledReason` line. Defaults to `warn`, which is right
   * for a degraded state (an invalid namespace). A reason that describes a
   * HEALTHY alternative transport (push delivered in-process on a single
   * container) must log at `info`: a warning that fires on every correct boot
   * teaches operators to ignore the channel.
   */
  disabledSeverity?: 'info' | 'warn'
  createPublisher?: (options: RedisOptions) => WebSocketRedisPublisher
  /** Bounds the warn lines to one per cause per interval (default 60 s). */
  throttle?: LogThrottle
}

export interface WebSocketRedisBridgeHealth {
  channel: string
  /** ioredis `status` of the publisher, or `'none'` before the first connect / when disabled. */
  publisherStatus: string
  /** Pushes that never reached Redis since boot; every one is a client that syncs on its next trigger instead. */
  droppedPublishes: number
  connectionErrors: number
}

/**
 * Bridges the in-process `WEB_SOCKET_MESSAGE_REQUESTED` domain event onto a
 * Redis pub/sub channel so the self-hosted WebSocket gateway (a separate
 * process, or the one attached in-process on the same http server) holding the
 * live browser/agent sockets can push it to clients.
 *
 * In home-server mode events are dispatched in-process via
 * DirectCallDomainEventPublisher and the AWS-based websockets push package is
 * dormant; this handler is what makes realtime push work without AWS.
 *
 * The publish is awaited INLINE from the saving request (SaveItems → the
 * DirectCall publisher), so it must never stall: the publisher runs with
 * `enableOfflineQueue: false` (a command issued while Redis is unreachable
 * rejects at once instead of queueing until reconnect), one retry, and a
 * bounded command timeout. A failed publish is a DROPPED push -- the client
 * recovers on its next sync trigger -- so it is counted and surfaced at `warn`
 * (throttled to one line per cause per minute), never hidden at `debug`.
 *
 * No-op (logs once) when REDIS_HOST is unset, so non-Redis deployments are
 * unaffected.
 */
export class WebSocketRedisBridge implements DomainEventMessageHandlerInterface {
  static readonly CHANNEL = WEBSOCKET_MESSAGES_CHANNEL
  static readonly WARN_INTERVAL_MS = 60_000
  static readonly PUBLISH_TIMEOUT_MS = 5_000

  /**
   * The gateway's own rule (`namespacedPushChannel`, C10): the subscriber in
   * the in-process gateway derives its channel from the same function, so the
   * two sides cannot drift. Throws on a malformed namespace.
   */
  static channelFor(namespace: string | undefined): string {
    return namespacedPushChannel(namespace)
  }

  /**
   * The two operator lines, as constants: the cause selects one, nothing
   * dynamic ever reaches the message position.
   */
  private static readonly WARN_LINES: Readonly<Record<'connection' | 'publish', string>> = Object.freeze({
    connection: 'WebSocketRedisBridge redis connection error; pushes are dropped until it reconnects.',
    publish: 'WebSocketRedisBridge publish failed; the realtime push was dropped (clients recover on their next sync).',
  })

  readonly channel: string
  private readonly disabledReason: string | undefined
  private readonly disabledSeverity: 'info' | 'warn'
  private readonly createPublisher: (options: RedisOptions) => WebSocketRedisPublisher
  private readonly throttle: LogThrottle
  private publisher: WebSocketRedisPublisher | undefined
  private warned = false
  private droppedPublishes = 0
  private connectionErrors = 0

  constructor(
    private readonly logger: Logger,
    private readonly redisHost: string | undefined,
    private readonly redisPort: number,
    options: WebSocketRedisBridgeOptions = {},
  ) {
    this.channel = WebSocketRedisBridge.channelFor(options.namespace)
    this.disabledReason = options.disabledReason
    this.disabledSeverity = options.disabledSeverity ?? 'warn'
    this.createPublisher = options.createPublisher ?? ((redisOptions) => new Redis(redisOptions))
    this.throttle = options.throttle ?? createLogThrottle({ intervalMs: WebSocketRedisBridge.WARN_INTERVAL_MS })
  }

  /**
   * Open the Redis connection now rather than on the first push. With the
   * offline queue disabled, a publish issued before the socket is ready is
   * rejected, so the host calls this at boot to have the connection up long
   * before the first request can produce an event. Safe to call when Redis is
   * not configured (logs the disabled line once).
   */
  connect(): void {
    this.getPublisher()
  }

  health(): WebSocketRedisBridgeHealth {
    return {
      channel: this.channel,
      publisherStatus: this.publisher?.status ?? 'none',
      droppedPublishes: this.droppedPublishes,
      connectionErrors: this.connectionErrors,
    }
  }

  private getPublisher(): WebSocketRedisPublisher | undefined {
    if (this.disabledReason !== undefined) {
      if (!this.warned) {
        this.logger[this.disabledSeverity](`WebSocketRedisBridge disabled: ${this.disabledReason}`)
        this.warned = true
      }
      return undefined
    }
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
        enableOfflineQueue: false,
        commandTimeout: WebSocketRedisBridge.PUBLISH_TIMEOUT_MS,
      })
      this.publisher.on('error', (error) => {
        this.connectionErrors += 1
        this.warnThrottled('connection', error)
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
      await publisher.publish(this.channel, JSON.stringify(messageOrEvent.payload))
    } catch (error) {
      this.droppedPublishes += 1
      this.warnThrottled('publish', error)
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
    } catch {
      this.logger.debug('WebSocketRedisBridge graceful close failed.')
      publisher.disconnect()
    }
  }

  async handleError(_error: Error): Promise<void> {
    this.logger.error('WebSocketRedisBridge domain subscriber error.')
  }

  /**
   * One warn line per cause per interval, carrying how many occurrences the
   * window swallowed and the running drop counter, so a Redis outage shows up
   * promptly and its size is readable without flooding the log. Error metadata
   * is the redacted classification only (type, code), never the message.
   */
  private warnThrottled(cause: 'connection' | 'publish', error: unknown): void {
    const decision = this.throttle.consider(cause)
    if (!decision.emit) {
      return
    }
    this.logger.warn(WebSocketRedisBridge.WARN_LINES[cause], {
      ...safeErrorLogMetadata(error),
      cause,
      suppressedSinceLastLine: decision.suppressed,
      droppedPublishes: this.droppedPublishes,
      connectionErrors: this.connectionErrors,
    })
  }
}
