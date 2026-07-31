import 'reflect-metadata'
import { NextcloudBackupRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { Item } from '../Item/Item'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { WebDAVItemBackupServiceInterface } from '../Item/WebDAVItemBackupServiceInterface'

import { NextcloudBackupRequestedEventHandler } from './NextcloudBackupRequestedEventHandler'

describe('NextcloudBackupRequestedEventHandler', () => {
  let itemRepository: ItemRepositoryInterface
  let webDAVItemBackupService: WebDAVItemBackupServiceInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'
  const items = [{ id: { toString: () => 'item' } } as unknown as Item]

  const createHandler = () => new NextcloudBackupRequestedEventHandler(itemRepository, webDAVItemBackupService, logger)

  const event = (overrides: Record<string, unknown> = {}) =>
    ({
      payload: {
        userUuid,
        keyParams: { identifier: 'test@standardnotes.com', version: '004' },
        nextcloudUrl: 'https://cloud.example.com',
        nextcloudAppPassword: 'app-password',
        nextcloudFolder: 'Backups',
        ...overrides,
      },
    }) as jest.Mocked<NextcloudBackupRequestedEvent>

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findAll = jest.fn().mockResolvedValue(items)

    webDAVItemBackupService = {} as jest.Mocked<WebDAVItemBackupServiceInterface>
    webDAVItemBackupService.uploadBackup = jest.fn().mockResolvedValue('backup.txt')

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
    )
    expect(logger.info).toHaveBeenCalledWith('Nextcloud backup uploaded for user', { userId: userUuid })
  })

  it('does not read any item when the user uuid is malformed', async () => {
    await createHandler().handle(event({ userUuid: 'not-a-uuid' }))

    expect(itemRepository.findAll).not.toHaveBeenCalled()
    expect(webDAVItemBackupService.uploadBackup).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('User uuid is invalid', {
      userId: 'not-a-uuid',
      codeTag: 'NextcloudBackupRequestedEventHandler',
    })
  })

  it('falls back to an empty username when the key params carry no identifier', async () => {
    await createHandler().handle(event({ keyParams: { version: '004' } }))

    expect(webDAVItemBackupService.uploadBackup).toHaveBeenCalledWith(
      items,
      { version: '004' },
      expect.objectContaining({ username: '' }),
    )
  })

  it('warns rather than reporting success when the upload did not complete', async () => {
    webDAVItemBackupService.uploadBackup = jest.fn().mockResolvedValue(null)

    await createHandler().handle(event())

    expect(logger.warn).toHaveBeenCalledWith('Nextcloud backup upload did not complete for user', {
      userId: userUuid,
    })
    expect(logger.info).not.toHaveBeenCalled()
  })
})
