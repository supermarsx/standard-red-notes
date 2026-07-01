import { ItemDeletedEvent } from '@standardnotes/domain-events'

import { WebhookDispatcherInterface } from '../Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../Webhook/WebhookEvent'

import { WebhookItemDeletedEventHandler } from './WebhookItemDeletedEventHandler'

describe('WebhookItemDeletedEventHandler', () => {
  let webhookDispatcher: WebhookDispatcherInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const itemUuid = 'item-1'

  const createHandler = () => new WebhookItemDeletedEventHandler(webhookDispatcher)

  const event = {
    payload: { userUuid, itemUuid },
  } as jest.Mocked<ItemDeletedEvent>

  beforeEach(() => {
    webhookDispatcher = {} as jest.Mocked<WebhookDispatcherInterface>
    webhookDispatcher.dispatch = jest.fn().mockResolvedValue(undefined)
  })

  it('should map the internal item-deleted event onto the item.deleted webhook with the item uuid', async () => {
    await createHandler().handle(event)

    expect(webhookDispatcher.dispatch).toHaveBeenCalledTimes(1)
    expect(webhookDispatcher.dispatch).toHaveBeenCalledWith(WebhookEvent.ItemDeleted, {
      userUuid,
      metadata: { itemUuid },
    })
  })
})
