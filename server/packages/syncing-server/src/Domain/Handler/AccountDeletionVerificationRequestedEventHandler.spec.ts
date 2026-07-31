import 'reflect-metadata'
import { AccountDeletionVerificationRequestedEvent, DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'

import { AccountDeletionVerificationRequestedEventHandler } from './AccountDeletionVerificationRequestedEventHandler'

describe('AccountDeletionVerificationRequestedEventHandler', () => {
  let itemRepository: ItemRepositoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'
  const passedEvent = { type: 'ACCOUNT_DELETION_VERIFICATION_PASSED' }

  const createHandler = () =>
    new AccountDeletionVerificationRequestedEventHandler(
      itemRepository,
      domainEventPublisher,
      domainEventFactory,
      logger,
    )

  const event = (uuid = userUuid) =>
    ({
      payload: { userUuid: uuid, email: 'test@standardnotes.com' },
    }) as jest.Mocked<AccountDeletionVerificationRequestedEvent>

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.countAll = jest.fn().mockResolvedValue(0)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createAccountDeletionVerificationPassedEvent = jest.fn().mockReturnValue(passedEvent)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.warn = jest.fn()
  })

  it('lets the deletion proceed when the account holds no items', async () => {
    await createHandler().handle(event())

    expect(itemRepository.countAll).toHaveBeenCalledWith({ userUuid })
    expect(domainEventFactory.createAccountDeletionVerificationPassedEvent).toHaveBeenCalledWith({
      userUuid,
      email: 'test@standardnotes.com',
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(passedEvent)
  })

  it('refuses to pass verification while the account still holds items', async () => {
    itemRepository.countAll = jest.fn().mockResolvedValue(3)

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      `AccountDeletionVerificationRequestedEventHandler: User ${userUuid} has 3 items and cannot be deleted.`,
    )
  })

  it('does not touch the repository when the user uuid is malformed', async () => {
    await createHandler().handle(event('not-a-uuid'))

    expect(itemRepository.countAll).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      'AccountDeletionVerificationRequestedEventHandler failed.',
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('not-a-uuid')
  })
})
