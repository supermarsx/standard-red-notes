import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'
import { AccountDeletionRequestedEvent, DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { MarkFilesToBeRemoved } from '../UseCase/MarkFilesToBeRemoved/MarkFilesToBeRemoved'

import { AccountDeletionRequestedEventHandler } from './AccountDeletionRequestedEventHandler'

describe('AccountDeletionRequestedEventHandler (files)', () => {
  let markFilesToBeRemoved: MarkFilesToBeRemoved
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'
  const removedEvent = { type: 'FILE_REMOVED' }

  const removedFile = {
    userOrSharedVaultUuid: userUuid,
    filePath: `${userUuid}/file`,
    fileName: 'file',
    fileByteSize: 123,
  }

  const createHandler = () =>
    new AccountDeletionRequestedEventHandler(markFilesToBeRemoved, domainEventPublisher, domainEventFactory, logger)

  const event = () =>
    ({
      payload: { userUuid, regularSubscription: { uuid: 'subscription-uuid' } },
    }) as jest.Mocked<AccountDeletionRequestedEvent>

  const eventWithoutSubscription = () => ({ payload: { userUuid } }) as jest.Mocked<AccountDeletionRequestedEvent>

  beforeEach(() => {
    markFilesToBeRemoved = {} as jest.Mocked<MarkFilesToBeRemoved>
    markFilesToBeRemoved.execute = jest.fn().mockResolvedValue(Result.ok([removedFile]))

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createFileRemovedEvent = jest.fn().mockReturnValue(removedEvent)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.debug = jest.fn()
  })

  it('marks the files of the deleted account for removal and announces each one', async () => {
    await createHandler().handle(event())

    expect(markFilesToBeRemoved.execute).toHaveBeenCalledWith({ ownerUuid: userUuid })
    expect(domainEventFactory.createFileRemovedEvent).toHaveBeenCalledWith({
      userUuid,
      filePath: `${userUuid}/file`,
      fileName: 'file',
      fileByteSize: 123,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(removedEvent)
  })

  it('touches no file when the account had no regular subscription', async () => {
    await createHandler().handle(eventWithoutSubscription())

    expect(markFilesToBeRemoved.execute).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('announces nothing when the files could not be marked for removal', async () => {
    markFilesToBeRemoved.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(`Could not mark files for removal for user ${userUuid}: Oops`)
  })

  it('announces one event per removed file', async () => {
    markFilesToBeRemoved.execute = jest
      .fn()
      .mockResolvedValue(Result.ok([removedFile, { ...removedFile, fileName: 'other' }]))

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(2)
  })

  it('announces nothing when the account owned no files', async () => {
    markFilesToBeRemoved.execute = jest.fn().mockResolvedValue(Result.ok([]))

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })
})
