import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface, SharedVaultRemovedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { MarkFilesToBeRemoved } from '../UseCase/MarkFilesToBeRemoved/MarkFilesToBeRemoved'

import { SharedVaultRemovedEventHandler } from './SharedVaultRemovedEventHandler'

describe('SharedVaultRemovedEventHandler (files)', () => {
  let markFilesToBeRemoved: MarkFilesToBeRemoved
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let logger: Logger

  const sharedVaultUuid = '00000000-0000-0000-0000-000000000001'
  const vaultOwnerUuid = '00000000-0000-0000-0000-000000000002'
  const removedEvent = { type: 'SHARED_VAULT_FILE_REMOVED' }

  const removedFile = {
    userOrSharedVaultUuid: sharedVaultUuid,
    filePath: `${sharedVaultUuid}/file`,
    fileName: 'file',
    fileByteSize: 123,
  }

  const createHandler = () =>
    new SharedVaultRemovedEventHandler(markFilesToBeRemoved, domainEventPublisher, domainEventFactory, logger)

  const event = () => ({ payload: { sharedVaultUuid, vaultOwnerUuid } }) as jest.Mocked<SharedVaultRemovedEvent>

  beforeEach(() => {
    markFilesToBeRemoved = {} as jest.Mocked<MarkFilesToBeRemoved>
    markFilesToBeRemoved.execute = jest.fn().mockResolvedValue(Result.ok([removedFile]))

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createSharedVaultFileRemovedEvent = jest.fn().mockReturnValue(removedEvent)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.debug = jest.fn()
  })

  it("marks the removed vault's files for removal and announces each one to the vault owner", async () => {
    await createHandler().handle(event())

    expect(markFilesToBeRemoved.execute).toHaveBeenCalledWith({ ownerUuid: sharedVaultUuid })
    expect(domainEventFactory.createSharedVaultFileRemovedEvent).toHaveBeenCalledWith({
      fileByteSize: 123,
      fileName: 'file',
      filePath: `${sharedVaultUuid}/file`,
      sharedVaultUuid,
      vaultOwnerUuid,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(removedEvent)
  })

  it('announces one event per removed file', async () => {
    markFilesToBeRemoved.execute = jest
      .fn()
      .mockResolvedValue(Result.ok([removedFile, { ...removedFile, fileName: 'other' }]))

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(2)
  })

  it('announces nothing when the vault held no files', async () => {
    markFilesToBeRemoved.execute = jest.fn().mockResolvedValue(Result.ok([]))

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('rejects with a contextual error so failed file cleanup remains retryable', async () => {
    markFilesToBeRemoved.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await expect(createHandler().handle(event())).rejects.toThrow(
      `Could not mark files to be removed for shared vault: ${sharedVaultUuid}: Oops`,
    )

    expect(logger.error).toHaveBeenCalledWith(
      `Could not mark files to be removed for shared vault: ${sharedVaultUuid}: Oops`,
    )
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })
})
