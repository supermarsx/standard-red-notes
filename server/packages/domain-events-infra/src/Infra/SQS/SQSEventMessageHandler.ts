import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import * as zlib from 'zlib'

import {
  DomainEventHandlerInterface,
  DomainEventInterface,
  DomainEventMessageHandlerInterface,
} from '@standardnotes/domain-events'
import { DomainEventDeduplicator } from '../DomainEventDeduplicator'

/** Distinct unhandled types remembered per process; a poisoned queue cannot grow the map without bound. */
const MAX_TRACKED_UNHANDLED_EVENT_TYPES = 256

export class SQSEventMessageHandler implements DomainEventMessageHandlerInterface {
  private readonly unhandledEventTypes = new Map<string, number>()

  constructor(
    private handlers: Map<string, DomainEventHandlerInterface>,
    private logger: Logger,
    private deduplicator = new DomainEventDeduplicator(),
  ) {}

  async handleMessage(message: string): Promise<void> {
    const messageParsed = JSON.parse(message)

    const domainEventJson = zlib.unzipSync(Buffer.from(messageParsed.Message, 'base64')).toString()

    const domainEvent: DomainEventInterface = JSON.parse(domainEventJson)

    domainEvent.createdAt = new Date(domainEvent.createdAt)

    const handler = this.handlers.get(domainEvent.type)
    if (!handler) {
      this.recordUnhandledEventType(domainEvent.type)

      return
    }

    this.logger.debug(`Received event: ${domainEvent.type}`)

    await this.deduplicator.handle(domainEvent, () => handler.handle(domainEvent))
  }

  async handleError(error: Error): Promise<void> {
    this.logger.error('Error occurred while handling an SQS message.', safeErrorLogMetadata(error))
  }

  /** How many messages of each type this process acknowledged without a handler. */
  unhandledEventTypeCounts(): ReadonlyMap<string, number> {
    return this.unhandledEventTypes
  }

  /**
   * An unhandled type is acknowledged and gone, so the first occurrence per
   * type is a warning: a worker that keeps seeing types it never registered is
   * almost always polling another service's queue.
   */
  private recordUnhandledEventType(type: string): void {
    const count = (this.unhandledEventTypes.get(type) ?? 0) + 1
    if (count === 1 && this.unhandledEventTypes.size >= MAX_TRACKED_UNHANDLED_EVENT_TYPES) {
      this.logger.debug(`Event handler for event type ${type} does not exist`)

      return
    }
    this.unhandledEventTypes.set(type, count)
    if (count === 1) {
      this.logger.warn(`unhandled event type ${type}; check the SQS_QUEUE_URL of this worker`)

      return
    }
    this.logger.debug(`Event handler for event type ${type} does not exist (${count} unhandled so far)`)
  }
}
