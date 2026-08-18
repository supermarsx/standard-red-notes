import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import {
  DomainEventHandlerInterface,
  DomainEventInterface,
  DomainEventMessageHandlerInterface,
} from '@standardnotes/domain-events'
import { DomainEventDeduplicator } from '../DomainEventDeduplicator'

export class DirectCallEventMessageHandler implements DomainEventMessageHandlerInterface {
  constructor(
    private handlers: Map<string, DomainEventHandlerInterface>,
    private logger: Logger,
    private deduplicator = new DomainEventDeduplicator(),
  ) {}

  async handleMessage(messageOrEvent: string | DomainEventInterface): Promise<void> {
    if (typeof messageOrEvent === 'string') {
      throw new Error('DirectCallEventMessageHandler does not support string messages')
    }

    const handler = this.handlers.get(messageOrEvent.type)
    if (!handler) {
      this.logger.debug(`Event handler for event type ${messageOrEvent.type} does not exist`)

      return
    }

    this.logger.debug(`Received event: ${messageOrEvent.type}`)

    await this.deduplicator.handle(messageOrEvent, () => handler.handle(messageOrEvent))
  }

  async handleError(error: Error): Promise<void> {
    this.logger.error('Error occurred while handling a direct-call event.', safeErrorLogMetadata(error))
  }
}
