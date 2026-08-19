import { InviteRealtimeDomainEventEnvelope, InviteRealtimeDomainEventHandler } from './inviteEventDomainEventHandler.js'
import { InviteEventOutboxDispatcher } from './inviteEventOutbox.js'

export const INVITE_REALTIME_DOMAIN_EVENT_TYPE = 'INVITE_REALTIME_INVALIDATION_REQUESTED' as const

/** Structural port implemented by DirectCallDomainEventPublisher. */
export interface InviteRealtimeDirectCallPublisher {
  register(handler: InviteRealtimeDomainEventMessageHandler): void
}

/** Structural port implemented by SQSDomainEventSubscriber. */
export interface InviteRealtimeDomainEventSubscriber {
  start(): void
  stop(): void
}

/**
 * Adapter registered with DirectCallDomainEventPublisher. Direct-call
 * publishers broadcast every domain event, so unrelated events are ignored.
 * A raw string is rejected deliberately: the SQS path must use the repository's
 * SQSEventMessageHandler to decode and route the SNS envelope before this seam.
 */
export interface InviteRealtimeDomainEventMessageHandler {
  handleMessage(messageOrEvent: string | InviteRealtimeDomainEventEnvelope): Promise<void>
}

export interface InviteRealtimeDomainEventBridge {
  /** Start the optional SQS consumer and register the optional DirectCall adapter. */
  start(): void
  /** Stop owned subscriber resources exactly once and deactivate DirectCall delivery. */
  close(): Promise<void>
}

export type InviteRealtimeSubscriberFactory = (
  handler: InviteRealtimeDomainEventHandler,
  eventType: typeof INVITE_REALTIME_DOMAIN_EVENT_TYPE,
) => InviteRealtimeDomainEventSubscriber

export type InviteRealtimeDomainEventBridgeOptions = {
  dispatcher: Pick<InviteEventOutboxDispatcher, 'dispatch'>
  directCallPublisher?: InviteRealtimeDirectCallPublisher
  /**
   * Build the standard SQSEventMessageHandler -> SQSDomainEventSubscriber
   * chain around the supplied strict domain handler.
   */
  createSubscriber?: InviteRealtimeSubscriberFactory
}

/**
 * Production bridge from DirectCall or the standard SNS/SQS domain-event
 * subscriber into the durable Redis invite dispatcher.
 *
 * The runtime owns the optional subscriber. start() is idempotent; close() is
 * promise-stable and calls subscriber.stop() at most once, including cleanup
 * after a partially failed start.
 */
export function createInviteRealtimeDomainEventBridge(
  options: InviteRealtimeDomainEventBridgeOptions,
): InviteRealtimeDomainEventBridge {
  const domainHandler = new InviteRealtimeDomainEventHandler(options.dispatcher)
  const subscriber = options.createSubscriber?.(domainHandler, INVITE_REALTIME_DOMAIN_EVENT_TYPE)
  let acceptingDirectCallEvents = false
  let started = false
  let closed = false
  let subscriberStartAttempted = false
  let subscriberStopped = false
  let closePromise: Promise<void> | undefined

  const directCallHandler: InviteRealtimeDomainEventMessageHandler = {
    async handleMessage(messageOrEvent): Promise<void> {
      if (!acceptingDirectCallEvents) {
        return
      }
      if (typeof messageOrEvent === 'string') {
        throw new Error('Raw SQS domain events must be decoded by SQSEventMessageHandler.')
      }
      if (messageOrEvent.type !== INVITE_REALTIME_DOMAIN_EVENT_TYPE) {
        return
      }
      await domainHandler.handle(messageOrEvent)
    },
  }

  const stopSubscriberOnce = (): void => {
    if (!subscriberStartAttempted || subscriberStopped || !subscriber) {
      return
    }
    subscriberStopped = true
    subscriber.stop()
  }

  return {
    start(): void {
      if (closed) {
        throw new Error('Invite realtime domain event bridge is closed.')
      }
      if (started) {
        return
      }

      acceptingDirectCallEvents = true
      try {
        if (subscriber) {
          subscriberStartAttempted = true
          subscriber.start()
        }
        options.directCallPublisher?.register(directCallHandler)
        started = true
      } catch (error) {
        acceptingDirectCallEvents = false
        closed = true
        stopSubscriberOnce()
        throw error
      }
    },

    close(): Promise<void> {
      if (closePromise) {
        return closePromise
      }
      acceptingDirectCallEvents = false
      closed = true
      closePromise = Promise.resolve().then(stopSubscriberOnce)
      return closePromise
    },
  }
}
