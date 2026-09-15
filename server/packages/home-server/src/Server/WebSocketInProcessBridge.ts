import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { DomainEventInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events'
import {
  createLogThrottle,
  domainEventToDispatch,
  type DispatchMessage,
  type LogThrottle,
} from '@standard-red-notes/websocket-gateway'
import { Logger } from 'winston'

/** The one thing this bridge needs from the attached gateway (C16). */
export interface WebSocketPushTarget {
  dispatch(message: DispatchMessage): number
}

export interface WebSocketInProcessBridgeOptions {
  /** Bounds the warn lines to one per cause per interval (default 60 s). */
  throttle?: LogThrottle
}

export interface WebSocketInProcessBridgeHealth {
  /** Events accepted and handed to the gateway since boot. */
  dispatchedPushes: number
  /** Live sockets those pushes reached in total. */
  socketsReached: number
  /** Events that named no live socket; the client syncs on its next trigger. */
  undeliveredPushes: number
  /** Events refused before dispatch: malformed payload, or no gateway attached. */
  droppedPushes: number
}

/**
 * Bridges the in-process `WEB_SOCKET_MESSAGE_REQUESTED` domain event straight
 * onto the attached gateway's connection registry, for a deployment that runs
 * one process and no Redis (the single container, the LXC image).
 *
 * The Redis bridge publishes the same payload on a channel that the gateway --
 * possibly in another container -- subscribes to. With one process there is no
 * second party to the conversation: the sockets are in this heap, so the event
 * is delivered by a function call. Everything else is deliberately identical to
 * `WebSocketRedisBridge`:
 *
 *   - the SAME payload validation, reusing the gateway's `domainEventToDispatch`
 *     so the two transports cannot diverge on what they accept;
 *   - the publish is awaited INLINE from the saving request, so it never awaits
 *     anything and cannot stall a save;
 *   - a refused event is a DROPPED push -- the client recovers on its next sync
 *     trigger -- so it is counted and surfaced at `warn` (throttled), never
 *     hidden.
 */
export class WebSocketInProcessBridge implements DomainEventMessageHandlerInterface {
  static readonly WARN_INTERVAL_MS = 60_000

  /** Constant operator lines; nothing dynamic reaches the message position. */
  private static readonly WARN_LINES: Readonly<Record<'gateway' | 'payload' | 'dispatch', string>> = Object.freeze({
    gateway:
      'WebSocketInProcessBridge has no attached gateway; the realtime push was dropped (clients recover on their next sync).',
    payload: 'WebSocketInProcessBridge received a malformed push payload; it was dropped.',
    dispatch:
      'WebSocketInProcessBridge dispatch failed; the realtime push was dropped (clients recover on their next sync).',
  })

  private readonly throttle: LogThrottle
  private gateway: WebSocketPushTarget | undefined
  private dispatchedPushes = 0
  private socketsReached = 0
  private undeliveredPushes = 0
  private droppedPushes = 0

  constructor(
    private readonly logger: Logger,
    gateway?: WebSocketPushTarget,
    options: WebSocketInProcessBridgeOptions = {},
  ) {
    this.gateway = gateway
    this.throttle = options.throttle ?? createLogThrottle({ intervalMs: WebSocketInProcessBridge.WARN_INTERVAL_MS })
  }

  /**
   * The bridge is registered with the domain-event publisher BEFORE the gateway
   * attaches (the publisher is built early in the boot), so the target arrives
   * afterwards. Until it does, an event is a counted drop rather than a throw.
   */
  setGateway(gateway: WebSocketPushTarget | undefined): void {
    this.gateway = gateway
  }

  health(): WebSocketInProcessBridgeHealth {
    return {
      dispatchedPushes: this.dispatchedPushes,
      socketsReached: this.socketsReached,
      undeliveredPushes: this.undeliveredPushes,
      droppedPushes: this.droppedPushes,
    }
  }

  async handleMessage(messageOrEvent: string | DomainEventInterface): Promise<void> {
    if (typeof messageOrEvent === 'string' || messageOrEvent.type !== 'WEB_SOCKET_MESSAGE_REQUESTED') {
      return
    }
    // The gateway's own projection: same accepted shape as the SQS consumer and
    // the Redis channel, so a payload that would push in one topology pushes in
    // all of them.
    const dispatch = domainEventToDispatch(messageOrEvent as unknown as Record<string, unknown>)
    if (!dispatch) {
      this.droppedPushes += 1
      this.warnThrottled('payload')
      return
    }
    const gateway = this.gateway
    if (!gateway) {
      this.droppedPushes += 1
      this.warnThrottled('gateway')
      return
    }

    let reached: number
    try {
      reached = gateway.dispatch({
        userUuid: dispatch.userUuid,
        message: dispatch.message,
        ...(dispatch.originatingSessionUuid === undefined
          ? {}
          : { originatingSessionUuid: dispatch.originatingSessionUuid }),
      })
    } catch (error) {
      this.droppedPushes += 1
      this.warnThrottled('dispatch', error)
      return
    }

    this.dispatchedPushes += 1
    this.socketsReached += reached
    if (reached === 0) {
      // Not an error: the account simply has no live socket on this process.
      this.undeliveredPushes += 1
    }
  }

  async close(): Promise<void> {
    this.gateway = undefined
  }

  async handleError(_error: Error): Promise<void> {
    this.logger.error('WebSocketInProcessBridge domain subscriber error.')
  }

  /**
   * One warn line per cause per interval, carrying how many occurrences the
   * window swallowed and the running drop counter. Error metadata is the
   * redacted classification only (type, code), never the message.
   */
  private warnThrottled(cause: 'gateway' | 'payload' | 'dispatch', error?: unknown): void {
    const decision = this.throttle.consider(cause)
    if (!decision.emit) {
      return
    }
    this.logger.warn(WebSocketInProcessBridge.WARN_LINES[cause], {
      ...(error === undefined ? {} : safeErrorLogMetadata(error)),
      cause,
      suppressedSinceLastLine: decision.suppressed,
      droppedPushes: this.droppedPushes,
    })
  }
}
