import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { MapperInterface } from '@standardnotes/domain-core'
import { KeyParamsData } from '@standardnotes/responses'
import { Logger } from 'winston'

import { BackupContentTooLargeError } from '../../Domain/Item/BackupContentTooLargeError'
import { Item } from '../../Domain/Item/Item'
import { ItemBackupRepresentation } from '../../Mapping/Backup/ItemBackupRepresentation'
import { ItemHttpRepresentation } from '../../Mapping/Http/ItemHttpRepresentation'
import { S3ItemBackupService } from './S3ItemBackupService'

describe('S3ItemBackupService', () => {
  let backupMapper: MapperInterface<Item, ItemBackupRepresentation>
  let httpMapper: MapperInterface<Item, ItemHttpRepresentation>
  let logger: Logger
  let send: jest.Mock

  const authParams = {
    identifier: 'person@example.com',
    pw_nonce: 'nonce',
    version: '004',
  } as KeyParamsData

  const item = (id: string) =>
    ({
      id: {
        toString: () => id,
      },
    }) as Item

  const projection = (id: string, content = `encrypted-${id}`): ItemHttpRepresentation =>
    ({
      uuid: id,
      content,
    }) as ItemHttpRepresentation

  const createService = () =>
    new S3ItemBackupService('owned-backups', backupMapper, httpMapper, logger, { send } as unknown as S3Client)

  const uploadedBackups = (): Array<{ items: ItemHttpRepresentation[]; auth_params: KeyParamsData }> =>
    send.mock.calls.map(([command]) => {
      expect(command).toBeInstanceOf(PutObjectCommand)
      expect((command as PutObjectCommand).input.Bucket).toBe('owned-backups')
      expect((command as PutObjectCommand).input.IfNoneMatch).toBe('*')

      return JSON.parse((command as PutObjectCommand).input.Body as string)
    })

  beforeEach(() => {
    backupMapper = {} as jest.Mocked<MapperInterface<Item, ItemBackupRepresentation>>
    backupMapper.toProjection = jest.fn()

    httpMapper = {} as jest.Mocked<MapperInterface<Item, ItemHttpRepresentation>>
    httpMapper.toProjection = jest.fn().mockImplementation((value: Item) => projection(value.id.toString()))

    logger = {} as jest.Mocked<Logger>
    logger.warn = jest.fn()
    logger.error = jest.fn()

    send = jest.fn().mockResolvedValue({})
  })

  it('bundles by complete UTF-8 backup JSON byte size', async () => {
    const firstProjection = projection('item-1', 'é'.repeat(20))
    const secondProjection = projection('item-2')
    const thirdProjection = projection('item-3')
    ;(httpMapper.toProjection as jest.Mock)
      .mockReturnValueOnce(firstProjection)
      .mockReturnValueOnce(secondProjection)
      .mockReturnValueOnce(thirdProjection)
    const twoItemLimit = Buffer.byteLength(
      JSON.stringify({ items: [firstProjection, secondProjection], auth_params: authParams }),
      'utf8',
    )

    await createService().backup([item('item-1'), item('item-2'), item('item-3')], authParams, twoItemLimit)

    const backups = uploadedBackups()
    expect(backups.map((backup) => backup.items.map((value) => value.uuid))).toEqual([['item-1', 'item-2'], ['item-3']])
    expect(
      send.mock.calls.every(
        ([command]) => Buffer.byteLength((command as PutObjectCommand).input.Body as string, 'utf8') <= twoItemLimit,
      ),
    ).toBe(true)
  })

  it('rejects one oversized item without uploading an empty or oversized backup', async () => {
    const oversizedProjection = projection('oversized', 'x'.repeat(1_000))
    ;(httpMapper.toProjection as jest.Mock).mockReturnValueOnce(oversizedProjection)
    const singleItemSize = Buffer.byteLength(
      JSON.stringify({ items: [oversizedProjection], auth_params: authParams }),
      'utf8',
    )

    await expect(createService().backup([item('oversized')], authParams, singleItemSize - 1)).rejects.toThrow(
      'A single item cannot fit within the configured email attachment limit',
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('rolls back an earlier object when a later item is oversized', async () => {
    const firstProjection = projection('item-1', 'first')
    const secondProjection = projection('item-2', 'second')
    const oversizedProjection = projection('oversized', 'x'.repeat(1_000))
    ;(httpMapper.toProjection as jest.Mock)
      .mockReturnValueOnce(firstProjection)
      .mockReturnValueOnce(secondProjection)
      .mockReturnValueOnce(oversizedProjection)
    const oneItemLimit = Math.max(
      Buffer.byteLength(JSON.stringify({ items: [firstProjection], auth_params: authParams }), 'utf8'),
      Buffer.byteLength(JSON.stringify({ items: [secondProjection], auth_params: authParams }), 'utf8'),
    )

    await expect(
      createService().backup([item('item-1'), item('item-2'), item('oversized')], authParams, oneItemLimit),
    ).rejects.toBeInstanceOf(BackupContentTooLargeError)

    expect(send).toHaveBeenCalledTimes(2)
    const put = send.mock.calls[0][0] as PutObjectCommand
    const rollback = send.mock.calls[1][0] as DeleteObjectCommand
    expect(put).toBeInstanceOf(PutObjectCommand)
    expect(put.input.IfNoneMatch).toBe('*')
    expect(rollback).toBeInstanceOf(DeleteObjectCommand)
    expect(rollback.input).toEqual({
      Bucket: 'owned-backups',
      Key: put.input.Key,
    })
  })

  it('does not mask the typed oversized error when S3 rollback fails', async () => {
    const firstProjection = projection('item-1', 'first')
    const secondProjection = projection('item-2', 'second')
    const oversizedProjection = projection('oversized', 'x'.repeat(1_000))
    ;(httpMapper.toProjection as jest.Mock)
      .mockReturnValueOnce(firstProjection)
      .mockReturnValueOnce(secondProjection)
      .mockReturnValueOnce(oversizedProjection)
    const oneItemLimit = Math.max(
      Buffer.byteLength(JSON.stringify({ items: [firstProjection], auth_params: authParams }), 'utf8'),
      Buffer.byteLength(JSON.stringify({ items: [secondProjection], auth_params: authParams }), 'utf8'),
    )
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('rollback storage failure'))

    await expect(
      createService().backup([item('item-1'), item('item-2'), item('oversized')], authParams, oneItemLimit),
    ).rejects.toBeInstanceOf(BackupContentTooLargeError)
    expect(logger.error).toHaveBeenCalledWith('Incomplete S3 item backup could not be deleted')
  })

  it('uses an exclusive create precondition and never deletes a colliding object', async () => {
    send.mockRejectedValueOnce({
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    })

    await expect(createService().backup([item('item-1')], authParams)).rejects.toMatchObject({
      name: 'PreconditionFailed',
    })

    expect(send).toHaveBeenCalledTimes(1)
    const put = send.mock.calls[0][0] as PutObjectCommand
    expect(put).toBeInstanceOf(PutObjectCommand)
    expect(put.input.IfNoneMatch).toBe('*')
  })

  it('deletes the exact generated key from the owned bucket', async () => {
    await createService().delete('owned-backup-key')

    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0] as DeleteObjectCommand
    expect(command).toBeInstanceOf(DeleteObjectCommand)
    expect(command.input).toEqual({
      Bucket: 'owned-backups',
      Key: 'owned-backup-key',
    })
  })

  it('returns no files for an empty item set and rejects invalid limits', async () => {
    await expect(createService().backup([], authParams, 100)).resolves.toEqual([])
    expect(send).not.toHaveBeenCalled()

    await expect(createService().backup([item('item-1')], authParams, 0)).rejects.toThrow(
      'Backup content size limit must be a positive integer',
    )
    await expect(createService().backup([item('item-1')], authParams, Number.NaN)).rejects.toThrow(
      'Backup content size limit must be a positive integer',
    )
  })

  it('fails a non-empty backup loudly when S3 is not configured', async () => {
    const service = new S3ItemBackupService('', backupMapper, httpMapper, logger)

    await expect(service.backup([item('item-1')], authParams, 1000)).rejects.toThrow('S3 backup not configured')
    expect(logger.warn).toHaveBeenCalledWith('S3 backup not configured')
  })
})
