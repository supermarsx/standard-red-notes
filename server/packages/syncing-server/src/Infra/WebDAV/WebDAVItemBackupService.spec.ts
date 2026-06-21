import 'reflect-metadata'

import { KeyParamsData } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { Item } from '../../Domain/Item/Item'
import { ItemHttpRepresentation } from '../../Mapping/Http/ItemHttpRepresentation'
import { WebDAVItemBackupService } from './WebDAVItemBackupService'
import { WebDAVClientInterface, WebDAVUploadDestination } from './WebDAVClientInterface'

describe('WebDAVItemBackupService', () => {
  let httpMapper: MapperInterface<Item, ItemHttpRepresentation>
  let webDAVClient: WebDAVClientInterface
  let logger: Logger

  const authParams = { identifier: 'user@example.com', version: '004' } as unknown as KeyParamsData

  const items = [{ id: { toString: () => 'item-1' } }, { id: { toString: () => 'item-2' } }] as unknown as Item[]

  const destination = {
    url: 'https://cloud.example.com',
    username: 'user@example.com',
    appPassword: 'app-pass-123',
    folder: 'Backups/StandardNotes',
  }

  const createService = () => new WebDAVItemBackupService(httpMapper, webDAVClient, logger)

  beforeEach(() => {
    httpMapper = {
      toProjection: jest.fn((item: Item) => ({ uuid: item.id.toString() }) as unknown as ItemHttpRepresentation),
      toDomain: jest.fn(),
    } as unknown as MapperInterface<Item, ItemHttpRepresentation>

    webDAVClient = {
      putFile: jest.fn().mockResolvedValue(undefined),
    }

    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger
  })

  it('uploads to a date-stamped SN-Data file in the configured folder', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-21T08:30:00.000Z'))

    const fileName = await createService().uploadBackup(items, authParams, destination)

    expect(fileName).toEqual('SN-Data-2026-06-21.json')

    const putCall = (webDAVClient.putFile as jest.Mock).mock.calls[0]
    const passedDestination = putCall[0] as WebDAVUploadDestination
    expect(passedDestination.fileName).toEqual('SN-Data-2026-06-21.json')
    expect(passedDestination.folder).toEqual('Backups/StandardNotes')
    expect(passedDestination.url).toEqual('https://cloud.example.com')
    expect(passedDestination.username).toEqual('user@example.com')
    expect(passedDestination.appPassword).toEqual('app-pass-123')

    jest.useRealTimers()
  })

  it('writes the encrypted item projections plus auth_params as the JSON body', async () => {
    await createService().uploadBackup(items, authParams, destination)

    const putCall = (webDAVClient.putFile as jest.Mock).mock.calls[0]
    const body = JSON.parse(putCall[1] as string)

    expect(body.items).toEqual([{ uuid: 'item-1' }, { uuid: 'item-2' }])
    expect(body.auth_params).toEqual(authParams)
  })

  it('swallows client errors (returns null, logs, never throws)', async () => {
    ;(webDAVClient.putFile as jest.Mock).mockRejectedValue(new Error('connection refused'))

    const result = await createService().uploadBackup(items, authParams, destination)

    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalled()
  })

  it('does not log the app password when an upload fails', async () => {
    ;(webDAVClient.putFile as jest.Mock).mockRejectedValue(new Error('connection refused'))

    await createService().uploadBackup(items, authParams, destination)

    const loggedError = (logger.error as jest.Mock).mock.calls[0][0] as string
    expect(loggedError).not.toContain('app-pass-123')
  })

  it('skips (returns null) when the destination is incomplete', async () => {
    const result = await createService().uploadBackup(items, authParams, {
      url: '',
      username: 'user@example.com',
      appPassword: 'app-pass-123',
      folder: 'Backups',
    })

    expect(result).toBeNull()
    expect(webDAVClient.putFile).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('skips (returns null) when the username is missing', async () => {
    const result = await createService().uploadBackup(items, authParams, {
      url: 'https://cloud.example.com',
      username: '',
      appPassword: 'app-pass-123',
      folder: 'Backups',
    })

    expect(result).toBeNull()
    expect(webDAVClient.putFile).not.toHaveBeenCalled()
  })
})
