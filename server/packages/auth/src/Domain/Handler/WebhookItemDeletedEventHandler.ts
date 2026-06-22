import { DomainEventHandlerInterface, ItemDeletedEvent } from '@standardnotes/domain-events'

import { WebhookDispatcherInterface } from '../Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../Webhook/WebhookEvent'

/**
 * Standard Red Notes: bridges the internal ITEM_DELETED domain event onto the
 * public `item.deleted` outbound webhook. Items are end-to-end encrypted, so the
 * payload carries only the item uuid (metadata) — never decrypted content.
 */
export class WebhookItemDeletedEventHandler implements DomainEventHandlerInterface {
  constructor(private webhookDispatcher: WebhookDispatcherInterface) {}

  async handle(event: ItemDeletedEvent): Promise<void> {
    await this.webhookDispatcher.dispatch(WebhookEvent.ItemDeleted, {
      userUuid: event.payload.userUuid,
      metadata: {
        itemUuid: event.payload.itemUuid,
      },
    })
  }
}
