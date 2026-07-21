import 'reflect-metadata'
import { EmailLevel, Uuid } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface, EmailBackupRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { Item } from '../Item/Item'
import { ItemBackupServiceInterface } from '../Item/ItemBackupServiceInterface'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { ItemTransferCalculatorInterface } from '../Item/ItemTransferCalculatorInterface'

import { EmailBackupRequestedEventHandler } from './EmailBackupRequestedEventHandler'

describe('EmailBackupRequestedEventHandler', () => {
  let itemRepository: ItemRepositoryInterface
  let itemBackupService: ItemBackupServiceInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let itemTransferCalculator: ItemTransferCalculatorInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'
  const emailEvent = { type: 'EMAIL_REQUESTED' }
  const items = [{ id: { toString: () => 'item' } } as unknown as Item]

  const createHandler = () =>
    new EmailBackupRequestedEventHandler(
      itemRepository,
      itemBackupService,
      domainEventPublisher,
      domainEventFactory,
      100,
      itemTransferCalculator,
      's3-backup-bucket',
      logger,
    )

  const event = (uuid = userUuid) =>
    ({
      payload: {
        userUuid: uuid,
        keyParams: { identifier: 'test@standardnotes.com', version: '004' },
      },
    }) as jest.Mocked<EmailBackupRequestedEvent>

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue([])
    itemRepository.findAll = jest.fn().mockResolvedValue(items)

    itemBackupService = {} as jest.Mocked<ItemBackupServiceInterface>
    itemBackupService.backup = jest.fn().mockResolvedValue(['backup-file'])

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createEmailRequestedEvent = jest.fn().mockReturnValue(emailEvent)

    itemTransferCalculator = {} as jest.Mocked<ItemTransferCalculatorInterface>
    itemTransferCalculator.computeItemUuidBundlesToFetch = jest.fn().mockResolvedValue([['1-2-3']])

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.info = jest.fn()
  })

  it('requests one email per backup bundle produced', async () => {
    await createHandler().handle(event())

    expect(itemTransferCalculator.computeItemUuidBundlesToFetch).toHaveBeenCalledWith(
      [],
      100,
      Uuid.create(userUuid).getValue(),
    )
    expect(itemRepository.findAll).toHaveBeenCalledWith({
      uuids: ['1-2-3'],
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
    })
    expect(itemBackupService.backup).toHaveBeenCalledWith(items, event().payload.keyParams, 100)
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(emailEvent)
    expect(logger.info).toHaveBeenCalledWith('Email with backup requested for user', { userId: userUuid })
  })

  it('addresses the email to the account holder and points the attachment at the backup bucket', async () => {
    await createHandler().handle(event())

    expect(domainEventFactory.createEmailRequestedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: EmailLevel.LEVELS.System,
        messageIdentifier: 'DATA_BACKUP',
        userEmail: 'test@standardnotes.com',
        sender: 'backups@standardnotes.org',
        userUuid,
        attachments: [
          expect.objectContaining({
            fileName: 'backup-file',
            filePath: 's3-backup-bucket',
            attachmentContentType: 'application/json',
          }),
        ],
      }),
    )
  })

  it('numbers the bundles across every backup file', async () => {
    itemTransferCalculator.computeItemUuidBundlesToFetch = jest.fn().mockResolvedValue([['1-2-3'], ['2-3-4']])
    itemBackupService.backup = jest
      .fn()
      .mockResolvedValueOnce(['backup-file-1'])
      .mockResolvedValueOnce(['backup-file-2'])

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(2)
    const subjects = (domainEventFactory.createEmailRequestedEvent as jest.Mock).mock.calls.map(([dto]) => dto.subject)
    expect(subjects[0]).not.toEqual(subjects[1])
  })

  it('publishes nothing when no backup file was produced', async () => {
    itemBackupService.backup = jest.fn().mockResolvedValue([])

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('Email with backup requested for user', { userId: userUuid })
  })

  it('reads no item when the user uuid is malformed', async () => {
    await createHandler().handle(event('not-a-uuid'))

    expect(itemRepository.findContentSizeForComputingTransferLimit).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('User uuid is invalid', {
      userId: 'not-a-uuid',
      codeTag: 'EmailBackupRequestedEventHandler',
    })
  })
})
