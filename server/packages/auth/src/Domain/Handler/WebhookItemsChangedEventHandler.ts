import { DomainEventHandlerInterface, ItemsChangedOnServerEvent } from '@standardnotes/domain-events'

import { WebhookDispatcherInterface } from '../Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../Webhook/WebhookEvent'

/**
 * Standard Red Notes: bridges the internal ITEMS_CHANGED_ON_SERVER domain event
 * (emitted whenever a user's items are created or updated in a sync) onto the
 * public `item.created` / `item.updated` outbound webhooks.
 *
 * The bus event is a per-user "something changed up to this timestamp" signal
 * and does NOT carry per-item create-vs-update granularity or content, so this
 * handler fans out to BOTH `item.created` and `item.updated`; a subscriber picks
 * the event(s) it cares about. Payload is metadata only (userUuid + timestamp),
 * never decrypted note content.
 */
export class WebhookItemsChangedEventHandler implements DomainEventHandlerInterface {
  constructor(private webhookDispatcher: WebhookDispatcherInterface) {}

  async handle(event: ItemsChangedOnServerEvent): Promise<void> {
    const metadata = {
      timestamp: event.payload.timestamp,
    }

    await this.webhookDispatcher.dispatch(WebhookEvent.ItemCreated, {
      userUuid: event.payload.userUuid,
      metadata,
    })

    await this.webhookDispatcher.dispatch(WebhookEvent.ItemUpdated, {
      userUuid: event.payload.userUuid,
      metadata,
    })
  }
}
