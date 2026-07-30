import 'reflect-metadata'
import { EmailLevel, Uuid } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface, EmailBackupRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { Item } from '../Item/Item'
import { BackupContentTooLargeError } from '../Item/BackupContentTooLargeError'
import { ItemBackupServiceInterface } from '../Item/ItemBackupServiceInterface'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { ItemTransferCalculatorInterface } from '../Item/ItemTransferCalculatorInterface'
import { EmailBackupRequestedEventHandler } from './EmailBackupRequestedEventHandler'

describe('EmailBackupRequestedEventHandler', () => {
  let itemRepository: jest.Mocked<ItemRepositoryInterface>
  let itemBackupService: jest.Mocked<ItemBackupServiceInterface>
  let domainEventPublisher: jest.Mocked<DomainEventPublisherInterface>
  let domainEventFactory: jest.Mocked<DomainEventFactoryInterface>
  let itemTransferCalculator: jest.Mocked<ItemTransferCalculatorInterface>
  let logger: jest.Mocked<Logger>

  const userUuid = '00000000-0000-4000-8000-000000000001'
  const emailEvent = { type: 'EMAIL_REQUESTED' }
  const items = [{ id: { toString: () => 'item' } } as unknown as Item]

  const createHandler = (backupFileLocation = 's3-backup-bucket') =>
    new EmailBackupRequestedEventHandler(
      itemRepository,
      itemBackupService,
      domainEventPublisher,
      domainEventFactory,
      100,
      itemTransferCalculator,
      backupFileLocation,
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
    itemRepository = {
      findContentSizeForComputingTransferLimit: jest.fn().mockResolvedValue([]),
      findAll: jest.fn().mockResolvedValue(items),
    } as unknown as jest.Mocked<ItemRepositoryInterface>

    itemBackupService = {
      backup: jest.fn().mockResolvedValue(['backup-file']),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ItemBackupServiceInterface>

    domainEventPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<DomainEventPublisherInterface>

    domainEventFactory = {
      createEmailRequestedEvent: jest.fn().mockReturnValue(emailEvent),
    } as unknown as jest.Mocked<DomainEventFactoryInterface>

    itemTransferCalculator = {
      computeItemUuidBundlesToFetch: jest.fn().mockResolvedValue([['1-2-3']]),
    } as unknown as jest.Mocked<ItemTransferCalculatorInterface>

    logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    } as unknown as jest.Mocked<Logger>
  })

  it('creates one ordered batch event for every generated attachment', async () => {
    itemTransferCalculator.computeItemUuidBundlesToFetch.mockResolvedValue([['1-2-3'], ['2-3-4']])
    itemBackupService.backup.mockResolvedValueOnce(['backup-file-1']).mockResolvedValueOnce(['backup-file-2'])

    await createHandler().handle(event())

    expect(itemTransferCalculator.computeItemUuidBundlesToFetch).toHaveBeenCalledWith(
      [],
      100,
      Uuid.create(userUuid).getValue(),
    )
    expect(itemRepository.findAll).toHaveBeenNthCalledWith(1, {
      uuids: ['1-2-3'],
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
    })
    expect(itemRepository.findAll).toHaveBeenNthCalledWith(2, {
      uuids: ['2-3-4'],
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
    })
    expect(itemBackupService.backup).toHaveBeenCalledTimes(2)
    expect(domainEventFactory.createEmailRequestedEvent).toHaveBeenCalledTimes(1)
    expect(domainEventFactory.createEmailRequestedEvent).toHaveBeenCalledWith({
      backupBatchId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      body: expect.any(String),
      level: EmailLevel.LEVELS.System,
      messageIdentifier: 'DATA_BACKUP',
      subject: expect.stringContaining('1 Of 2'),
      userEmail: 'test@standardnotes.com',
      sender: 'backups@standardnotes.org',
      attachments: [
        {
          fileName: 'backup-file-1',
          filePath: 's3-backup-bucket',
          attachmentFileName: expect.stringMatching(/-Part-1-Of-2\.txt$/),
          attachmentContentType: 'application/json',
          emailSubject: expect.stringContaining('1 Of 2'),
          batchIndex: 1,
          batchCount: 2,
        },
        {
          fileName: 'backup-file-2',
          filePath: 's3-backup-bucket',
          attachmentFileName: expect.stringMatching(/-Part-2-Of-2\.txt$/),
          attachmentContentType: 'application/json',
          emailSubject: expect.stringContaining('2 Of 2'),
          batchIndex: 2,
          batchCount: 2,
        },
      ],
      userUuid,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(emailEvent)
  })

  it('publishes the exact owned local directory and preserves the single-file name', async () => {
    const localBackupDirectory = 'C:\\data\\uploads\\backups'

    await createHandler(localBackupDirectory).handle(event())

    expect(domainEventFactory.createEmailRequestedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            fileName: 'backup-file',
            filePath: localBackupDirectory,
            attachmentFileName: expect.stringMatching(/^SN-Data-\d{4}-\d{2}-\d{2}\.txt$/),
            batchIndex: 1,
            batchCount: 1,
          }),
        ],
      }),
    )
  })

  it('cleans generated artifacts and retries when publishing the batch fails', async () => {
    itemBackupService.backup.mockResolvedValue(['backup-file-1', 'backup-file-2'])
    domainEventPublisher.publish.mockRejectedValue(new Error('temporary queue outage'))

    await expect(createHandler().handle(event())).rejects.toThrow('temporary queue outage')

    expect(itemBackupService.delete.mock.calls.map(([fileName]) => fileName)).toEqual([
      'backup-file-1',
      'backup-file-2',
    ])
  })

  it('turns a single oversized item into one non-looping failure notice with no partial backup', async () => {
    itemTransferCalculator.computeItemUuidBundlesToFetch.mockResolvedValue([['1-2-3'], ['2-3-4']])
    itemBackupService.backup
      .mockResolvedValueOnce(['backup-file-1'])
      .mockRejectedValueOnce(new BackupContentTooLargeError())

    await createHandler().handle(event())

    expect(itemBackupService.delete).toHaveBeenCalledWith('backup-file-1')
    expect(domainEventFactory.createEmailRequestedEvent).toHaveBeenCalledTimes(1)
    expect(domainEventFactory.createEmailRequestedEvent).toHaveBeenCalledWith({
      body: expect.any(String),
      level: EmailLevel.LEVELS.System,
      messageIdentifier: 'DATA_BACKUP_FAILED',
      subject: expect.any(String),
      userEmail: 'test@standardnotes.com',
      sender: 'backups@standardnotes.org',
      userUuid,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(emailEvent)
    expect(logger.warn).toHaveBeenCalledWith(
      'Email backup could not be created because an item exceeds the attachment limit',
      {
        codeTag: 'EmailBackupRequestedEventHandler',
        userId: userUuid,
      },
    )
  })

  it('does not hide an unexpected backup failure after cleaning earlier artifacts', async () => {
    itemTransferCalculator.computeItemUuidBundlesToFetch.mockResolvedValue([['1-2-3'], ['2-3-4']])
    itemBackupService.backup
      .mockResolvedValueOnce(['backup-file-1'])
      .mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(createHandler().handle(event())).rejects.toThrow('storage unavailable')

    expect(itemBackupService.delete).toHaveBeenCalledWith('backup-file-1')
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('contains cleanup errors without logging provider details', async () => {
    itemTransferCalculator.computeItemUuidBundlesToFetch.mockResolvedValue([['1-2-3'], ['2-3-4']])
    itemBackupService.backup
      .mockResolvedValueOnce(['backup-file-1'])
      .mockRejectedValueOnce(new BackupContentTooLargeError())
    itemBackupService.delete.mockRejectedValue(new Error('secret storage endpoint'))

    await createHandler().handle(event())

    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Incomplete email backup artifact could not be deleted', {
      codeTag: 'EmailBackupRequestedEventHandler',
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret storage endpoint')
  })

  it('publishes nothing when no backup file was produced', async () => {
    itemBackupService.backup.mockResolvedValue([])

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

  it('creates no artifact when the account email identifier is malformed', async () => {
    const invalidEmailEvent = event()
    invalidEmailEvent.payload.keyParams = { identifier: 'not-an-email', version: '004' }

    await createHandler().handle(invalidEmailEvent)

    expect(itemRepository.findContentSizeForComputingTransferLimit).not.toHaveBeenCalled()
    expect(itemBackupService.backup).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('User email identifier is invalid', {
      userId: userUuid,
      codeTag: 'EmailBackupRequestedEventHandler',
    })
  })
})
