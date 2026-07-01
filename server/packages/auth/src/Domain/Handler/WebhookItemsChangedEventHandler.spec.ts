import { ItemsChangedOnServerEvent } from '@standardnotes/domain-events'

import { WebhookDispatcherInterface } from '../Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../Webhook/WebhookEvent'

import { WebhookItemsChangedEventHandler } from './WebhookItemsChangedEventHandler'

describe('WebhookItemsChangedEventHandler', () => {
  let webhookDispatcher: WebhookDispatcherInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const timestamp = 1719100000000

  const createHandler = () => new WebhookItemsChangedEventHandler(webhookDispatcher)

  const event = {
    payload: { userUuid, sessionUuid: 'session-1', timestamp },
  } as jest.Mocked<ItemsChangedOnServerEvent>

  beforeEach(() => {
    webhookDispatcher = {} as jest.Mocked<WebhookDispatcherInterface>
    webhookDispatcher.dispatch = jest.fn().mockResolvedValue(undefined)
  })

  it('should fan the internal items-changed event out to both item.created and item.updated', async () => {
    await createHandler().handle(event)

    expect(webhookDispatcher.dispatch).toHaveBeenCalledTimes(2)
    expect(webhookDispatcher.dispatch).toHaveBeenNthCalledWith(1, WebhookEvent.ItemCreated, {
      userUuid,
      metadata: { timestamp },
    })
    expect(webhookDispatcher.dispatch).toHaveBeenNthCalledWith(2, WebhookEvent.ItemUpdated, {
      userUuid,
      metadata: { timestamp },
    })
  })
})
