import 'reflect-metadata'
import { DomainEventPublisherInterface, DuplicateItemSyncedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { Item } from '../Item/Item'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'

import { DuplicateItemSyncedEventHandler } from './DuplicateItemSyncedEventHandler'

describe('DuplicateItemSyncedEventHandler', () => {
  let itemRepository: ItemRepositoryInterface
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'
  const itemUuid = '00000000-0000-0000-0000-000000000002'
  const originalItemUuid = '00000000-0000-0000-0000-000000000003'
  const copyEvent = { type: 'REVISIONS_COPY_REQUESTED' }

  const createHandler = () =>
    new DuplicateItemSyncedEventHandler(itemRepository, domainEventFactory, domainEventPublisher, logger)

  const event = () => ({ payload: { itemUuid, userUuid } }) as jest.Mocked<DuplicateItemSyncedEvent>

  const duplicate = {
    id: { toString: () => itemUuid },
    props: { duplicateOf: { value: originalItemUuid } },
  } as unknown as Item

  const original = { id: { toString: () => originalItemUuid } } as unknown as Item

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findByUuidAndUserUuid = jest.fn().mockImplementation(async (uuid: string) => {
      if (uuid === itemUuid) {
        return duplicate
      }

      return original
    })

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createRevisionsCopyRequestedEvent = jest.fn().mockReturnValue(copyEvent)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()
  })

  it('requests the revisions of the original item be copied onto the duplicate', async () => {
    await createHandler().handle(event())

    expect(domainEventFactory.createRevisionsCopyRequestedEvent).toHaveBeenCalledWith(userUuid, {
      originalItemUuid,
      newItemUuid: itemUuid,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(copyEvent)
  })

  it('does nothing when the synced item cannot be found', async () => {
    itemRepository.findByUuidAndUserUuid = jest.fn().mockResolvedValue(null)

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(`Could not find item with uuid ${itemUuid}`)
  })

  it('does nothing when the synced item is not a duplicate of anything', async () => {
    itemRepository.findByUuidAndUserUuid = jest.fn().mockResolvedValue({
      id: { toString: () => itemUuid },
      props: { duplicateOf: null },
    })

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(`Item ${itemUuid} does not point to any duplicate`)
  })

  it('does not request a copy when the original item no longer exists', async () => {
    itemRepository.findByUuidAndUserUuid = jest.fn().mockImplementation(async (uuid: string) => {
      if (uuid === itemUuid) {
        return duplicate
      }

      return null
    })

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('swallows a publishing failure so the already persisted item is not re-processed', async () => {
    domainEventPublisher.publish = jest.fn().mockRejectedValue(new Error('Event bus is down'))

    await expect(createHandler().handle(event())).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      `Failed to publish revisions copy requested event for item ${itemUuid} (item already persisted).`,
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('Event bus is down')
  })
})
