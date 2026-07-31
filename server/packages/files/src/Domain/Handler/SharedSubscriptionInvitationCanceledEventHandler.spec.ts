import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface, SharedSubscriptionInvitationCanceledEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { MarkFilesToBeRemoved } from '../UseCase/MarkFilesToBeRemoved/MarkFilesToBeRemoved'

import { SharedSubscriptionInvitationCanceledEventHandler } from './SharedSubscriptionInvitationCanceledEventHandler'

describe('SharedSubscriptionInvitationCanceledEventHandler', () => {
  let markFilesToBeRemoved: MarkFilesToBeRemoved
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let logger: Logger

  const inviteeIdentifier = '00000000-0000-0000-0000-000000000001'
  const removedEvent = { type: 'FILE_REMOVED' }

  const removedFile = {
    userOrSharedVaultUuid: inviteeIdentifier,
    filePath: `${inviteeIdentifier}/file`,
    fileName: 'file',
    fileByteSize: 123,
  }

  const createHandler = () =>
    new SharedSubscriptionInvitationCanceledEventHandler(
      markFilesToBeRemoved,
      domainEventPublisher,
      domainEventFactory,
      logger,
    )

  const event = (inviteeIdentifierType = 'uuid') =>
    ({
      payload: { inviteeIdentifier, inviteeIdentifierType },
    }) as jest.Mocked<SharedSubscriptionInvitationCanceledEvent>

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

  it("marks the invitee's files for removal and announces each one", async () => {
    await createHandler().handle(event())

    expect(markFilesToBeRemoved.execute).toHaveBeenCalledWith({ ownerUuid: inviteeIdentifier })
    expect(domainEventFactory.createFileRemovedEvent).toHaveBeenCalledWith({
      userUuid: inviteeIdentifier,
      filePath: `${inviteeIdentifier}/file`,
      fileName: 'file',
      fileByteSize: 123,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(removedEvent)
  })

  it('touches no file when the invitee was identified by email rather than uuid', async () => {
    await createHandler().handle(event('email'))

    expect(markFilesToBeRemoved.execute).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('announces nothing and logs safely when the files could not be marked for removal', async () => {
    markFilesToBeRemoved.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      `Could not mark files to be removed for invitee: ${inviteeIdentifier}.`,
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Oops')
  })

  it('announces one event per removed file', async () => {
    markFilesToBeRemoved.execute = jest
      .fn()
      .mockResolvedValue(Result.ok([removedFile, { ...removedFile, fileName: 'other' }]))

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(2)
  })
})
