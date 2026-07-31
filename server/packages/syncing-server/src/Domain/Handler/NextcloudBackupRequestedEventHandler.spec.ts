import 'reflect-metadata'
import {
  DomainEventPublisherInterface,
  DomainEventService,
  NextcloudBackupRequestedEvent,
} from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { Item } from '../Item/Item'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { WebDAVItemBackupServiceInterface } from '../Item/WebDAVItemBackupServiceInterface'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'

import { NextcloudBackupRequestedEventHandler } from './NextcloudBackupRequestedEventHandler'

describe('NextcloudBackupRequestedEventHandler', () => {
  let itemRepository: ItemRepositoryInterface
  let webDAVItemBackupService: WebDAVItemBackupServiceInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'
  const requestUuid = '00000000-0000-0000-0000-000000000002'
  const legacyRequestUuid = '3ca35b86-abfe-5c91-83df-c871d3d04af4'
  const createdAt = new Date('2026-07-31T12:00:00.000Z')
  const items = [{ id: { toString: () => 'item' } } as unknown as Item]

  const createHandler = () =>
    new NextcloudBackupRequestedEventHandler(
      itemRepository,
      webDAVItemBackupService,
      domainEventPublisher,
      domainEventFactory,
      logger,
    )

  const event = (overrides: Record<string, unknown> = {}) =>
    ({
      type: 'NEXTCLOUD_BACKUP_REQUESTED',
      createdAt,
      meta: {
        correlation: { userIdentifier: userUuid, userIdentifierType: 'uuid' },
        origin: DomainEventService.Auth,
        target: DomainEventService.SyncingServer,
      },
      payload: {
        userUuid,
        requestUuid,
        keyParams: { identifier: 'test@standardnotes.com', version: '004' },
        nextcloudUrl: 'https://cloud.example.com',
        nextcloudAppPassword: 'app-password',
        nextcloudFolder: 'Backups',
        ...overrides,
      },
    }) as jest.Mocked<NextcloudBackupRequestedEvent>

  const legacyEvent = () => {
    const result = event()
    delete result.payload.requestUuid
    delete result.meta.target

    return result
  }

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findAll = jest.fn().mockResolvedValue(items)

    webDAVItemBackupService = {} as jest.Mocked<WebDAVItemBackupServiceInterface>
    webDAVItemBackupService.uploadBackup = jest.fn().mockResolvedValue('backup.txt')

    domainEventFactory = {
      createNextcloudBackupCompletedEvent: jest.fn((payload) => ({
        type: 'NEXTCLOUD_BACKUP_COMPLETED',
        payload: { ...payload, completedAt: 123 },
      })),
    } as unknown as jest.Mocked<DomainEventFactoryInterface>
    domainEventPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<DomainEventPublisherInterface>

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.warn = jest.fn()
    logger.info = jest.fn()
  })

  it('uploads every undeleted item of the user to the configured nextcloud folder', async () => {
    await createHandler().handle(event())

    expect(itemRepository.findAll).toHaveBeenCalledWith({
      userUuid,
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
      deleted: false,
    })
    expect(webDAVItemBackupService.uploadBackup).toHaveBeenCalledWith(
      items,
      { identifier: 'test@standardnotes.com', version: '004' },
      {
        url: 'https://cloud.example.com',
        username: 'test@standardnotes.com',
        appPassword: 'app-password',
        folder: 'Backups',
      },
      { artifactDate: '2026-07-31' },
    )
    expect(logger.info).toHaveBeenCalledWith('Nextcloud backup uploaded for user', {
      userId: userUuid,
      requestId: requestUuid,
    })
    expect(domainEventFactory.createNextcloudBackupCompletedEvent).toHaveBeenCalledWith({
      userUuid,
      requestUuid,
      outcome: 'succeeded',
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
  })

  it('uploads a legacy request without an id and acknowledges it with a pinned UUIDv5 identity', async () => {
    await createHandler().handle(legacyEvent())

    expect(webDAVItemBackupService.uploadBackup).toHaveBeenCalledTimes(1)
    expect(domainEventFactory.createNextcloudBackupCompletedEvent).toHaveBeenCalledWith({
      userUuid,
      requestUuid: legacyRequestUuid,
      outcome: 'succeeded',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('derives the same legacy request id across queue redelivery', async () => {
    const redeliveredEvent = legacyEvent()

    await createHandler().handle(redeliveredEvent)
    await createHandler().handle(redeliveredEvent)

    expect(webDAVItemBackupService.uploadBackup).toHaveBeenCalledTimes(2)
    expect(webDAVItemBackupService.uploadBackup).toHaveBeenNthCalledWith(
      1,
      items,
      expect.any(Object),
      expect.any(Object),
      { artifactDate: '2026-07-31' },
    )
    expect(webDAVItemBackupService.uploadBackup).toHaveBeenNthCalledWith(
      2,
      items,
      expect.any(Object),
      expect.any(Object),
      { artifactDate: '2026-07-31' },
    )
    expect(domainEventFactory.createNextcloudBackupCompletedEvent).toHaveBeenNthCalledWith(1, {
      userUuid,
      requestUuid: legacyRequestUuid,
      outcome: 'succeeded',
    })
    expect(domainEventFactory.createNextcloudBackupCompletedEvent).toHaveBeenNthCalledWith(2, {
      userUuid,
      requestUuid: legacyRequestUuid,
      outcome: 'succeeded',
    })
  })

  it('does not read any item when the user uuid is malformed', async () => {
    await createHandler().handle(event({ userUuid: 'not-a-uuid' }))

    expect(itemRepository.findAll).not.toHaveBeenCalled()
    expect(webDAVItemBackupService.uploadBackup).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Nextcloud backup request identifiers are invalid.', {
      codeTag: 'NextcloudBackupRequestedEventHandler',
    })
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('rejects a supplied malformed request id instead of treating it as a legacy event', async () => {
    await createHandler().handle(event({ requestUuid: 'not-a-uuid' }))

    expect(itemRepository.findAll).not.toHaveBeenCalled()
    expect(webDAVItemBackupService.uploadBackup).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Nextcloud backup request identifiers are invalid.', {
      codeTag: 'NextcloudBackupRequestedEventHandler',
    })
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('rejects an invalid immutable event date before reading or uploading items', async () => {
    const invalidEvent = event()
    invalidEvent.createdAt = new Date('invalid')

    await createHandler().handle(invalidEvent)

    expect(itemRepository.findAll).not.toHaveBeenCalled()
    expect(webDAVItemBackupService.uploadBackup).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Nextcloud backup request identifiers are invalid.', {
      codeTag: 'NextcloudBackupRequestedEventHandler',
    })
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('rejects a new request whose event provenance does not target syncing', async () => {
    const misroutedEvent = event()
    misroutedEvent.meta.origin = DomainEventService.SyncingServer
    misroutedEvent.meta.target = DomainEventService.Auth

    await createHandler().handle(misroutedEvent)

    expect(itemRepository.findAll).not.toHaveBeenCalled()
    expect(webDAVItemBackupService.uploadBackup).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Nextcloud backup request identifiers are invalid.', {
      codeTag: 'NextcloudBackupRequestedEventHandler',
    })
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('falls back to an empty username when the key params carry no identifier', async () => {
    await createHandler().handle(event({ keyParams: { version: '004' } }))

    expect(webDAVItemBackupService.uploadBackup).toHaveBeenCalledWith(
      items,
      { version: '004' },
      expect.objectContaining({ username: '' }),
      { artifactDate: '2026-07-31' },
    )
  })

  it('warns rather than reporting success when the upload did not complete', async () => {
    webDAVItemBackupService.uploadBackup = jest.fn().mockResolvedValue(null)

    await createHandler().handle(event())

    expect(logger.warn).toHaveBeenCalledWith('Nextcloud backup upload did not complete for user', {
      userId: userUuid,
      requestId: requestUuid,
    })
    expect(logger.info).not.toHaveBeenCalled()
    expect(domainEventFactory.createNextcloudBackupCompletedEvent).toHaveBeenCalledWith({
      userUuid,
      requestUuid,
      outcome: 'failed',
    })
  })

  it('turns item-read failures into a safe failed completion without logging secrets', async () => {
    itemRepository.findAll = jest.fn().mockRejectedValue(new Error('https://cloud.example.com app-password'))

    await createHandler().handle(event())

    expect(domainEventFactory.createNextcloudBackupCompletedEvent).toHaveBeenCalledWith({
      userUuid,
      requestUuid,
      outcome: 'failed',
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('cloud.example.com')
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('app-password')
  })

  it('propagates completion publication failure so the queue can redeliver the request', async () => {
    ;(domainEventPublisher.publish as jest.Mock).mockRejectedValue(new Error('broker unavailable'))

    await expect(createHandler().handle(event())).rejects.toThrow('broker unavailable')
  })
})
