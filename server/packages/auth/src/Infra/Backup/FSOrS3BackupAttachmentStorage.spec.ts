import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { FileHandle } from 'fs/promises'
import { promises, Stats } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Readable } from 'stream'

import {
  BackupAttachmentAlreadyDeliveredError,
  BackupAttachmentChangedDuringReadError,
  BackupAttachmentNotFoundError,
  BackupAttachmentReference,
  BackupAttachmentTooLargeError,
  InvalidBackupAttachmentReferenceError,
} from '../../Domain/Email/BackupAttachmentStorageInterface'
import { BackupAttachmentFileOperations, FSOrS3BackupAttachmentStorage } from './FSOrS3BackupAttachmentStorage'

describe('FSOrS3BackupAttachmentStorage', () => {
  let uploadPath: string
  let backupPath: string

  const referenceFor = (fileName: string, filePath: string): BackupAttachmentReference => ({
    fileName,
    filePath,
    attachmentFileName: 'SN-Data.txt',
    attachmentContentType: 'application/json',
  })
  const missingObject = () => ({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })

  beforeEach(async () => {
    uploadPath = await promises.mkdtemp(join(tmpdir(), 'srn-email-backup-storage-'))
    backupPath = join(uploadPath, 'backups')
    await promises.mkdir(backupPath)
  })

  afterEach(async () => {
    await promises.rm(uploadPath, { recursive: true, force: true })
  })

  it('reads a regular owned file, atomically turns it into a receipt, and deletes both paths', async () => {
    const fileName = '00000000-0000-4000-8000-000000000001.json'
    const filePath = join(backupPath, fileName)
    const receiptPath = `${filePath}.delivered`
    await promises.writeFile(filePath, 'encrypted-backup')
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath)
    const reference = referenceFor(fileName, resolve(backupPath))

    await expect(storage.read(reference)).resolves.toEqual(Buffer.from('encrypted-backup'))
    await expect(storage.markDelivered(reference)).resolves.toBeUndefined()
    await expect(promises.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(promises.readFile(receiptPath)).resolves.toEqual(Buffer.from('encrypted-backup'))
    await expect(storage.read(reference)).rejects.toBeInstanceOf(BackupAttachmentAlreadyDeliveredError)
    await expect(storage.markDelivered(reference)).resolves.toBeUndefined()
    await expect(storage.delete(reference)).resolves.toBeUndefined()
    await expect(promises.stat(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { fileName: '../outside.json', filePath: 'expected' },
    { fileName: 'nested/backup.json', filePath: 'expected' },
    { fileName: 'backup.json', filePath: 'wrong' },
    { fileName: '.hidden', filePath: 'expected' },
  ])('rejects an unowned local reference %#', async ({ fileName, filePath }) => {
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath)

    await expect(
      storage.read(
        referenceFor(fileName, filePath === 'expected' ? resolve(backupPath) : resolve(uploadPath, filePath)),
      ),
    ).rejects.toBeInstanceOf(InvalidBackupAttachmentReferenceError)
  })

  it('reports a missing local source without exposing a filesystem error', async () => {
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath)

    await expect(
      storage.read(referenceFor('00000000-0000-4000-8000-000000000001.json', resolve(backupPath))),
    ).rejects.toBeInstanceOf(BackupAttachmentNotFoundError)
  })

  it('rejects an oversized local file before buffering it', async () => {
    const fileName = '00000000-0000-4000-8000-000000000001.json'
    await promises.writeFile(join(backupPath, fileName), '12345')
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath, undefined, undefined, 4)

    await expect(storage.read(referenceFor(fileName, resolve(backupPath)))).rejects.toBeInstanceOf(
      BackupAttachmentTooLargeError,
    )
  })

  it('opens the canonical owned path and verifies a stable complete handle read', async () => {
    const fileName = 'backup.json'
    const requestedPath = resolve(backupPath, fileName)
    const canonicalRoot = resolve(uploadPath, 'canonical-backups')
    const canonicalPath = resolve(canonicalRoot, fileName)
    const originalStats = fileStats(4, 11, 22, 100)
    const openStats = fileStats(4, 11, 22, 100)
    const handle = {
      stat: jest.fn().mockResolvedValue(openStats),
      read: jest.fn().mockImplementation(async (buffer: Buffer) => {
        Buffer.from('data').copy(buffer)
        return { bytesRead: 4, buffer }
      }),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileHandle>
    const operations = fileOperationsFor({
      requestedPath,
      canonicalRoot,
      canonicalPath,
      originalStats,
      handle,
    })
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath, undefined, undefined, 4, operations)

    await expect(storage.read(referenceFor(fileName, resolve(backupPath)))).resolves.toEqual(Buffer.from('data'))
    expect(operations.open).toHaveBeenCalledWith(canonicalPath, expect.any(Number))
    expect(operations.open).not.toHaveBeenCalledWith(requestedPath, expect.any(Number))
    expect(handle.stat).toHaveBeenCalledTimes(2)
    expect(handle.close).toHaveBeenCalled()
  })

  it.each([
    ['short read', fileStats(4, 11, 22, 100), fileStats(4, 11, 22, 100), 2],
    ['final size change', fileStats(4, 11, 22, 100), fileStats(3, 11, 22, 100), 4],
    ['replacement inode', fileStats(4, 99, 22, 100), fileStats(4, 99, 22, 100), 4],
    ['pre-open timestamp change', fileStats(4, 11, 22, 101), fileStats(4, 11, 22, 101), 4],
  ])('rejects a %s during a canonical file read', async (_description, openStats, finalStats, bytesRead) => {
    const fileName = 'backup.json'
    const requestedPath = resolve(backupPath, fileName)
    const canonicalRoot = resolve(uploadPath, 'canonical-backups')
    const canonicalPath = resolve(canonicalRoot, fileName)
    const originalStats = fileStats(4, 11, 22, 100)
    const handle = {
      stat: jest.fn().mockResolvedValueOnce(openStats).mockResolvedValue(finalStats),
      read: jest
        .fn()
        .mockImplementationOnce(async (buffer: Buffer) => ({ bytesRead, buffer }))
        .mockImplementation(async (buffer: Buffer) => ({ bytesRead: 0, buffer })),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileHandle>
    const operations = fileOperationsFor({
      requestedPath,
      canonicalRoot,
      canonicalPath,
      originalStats,
      handle,
    })
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath, undefined, undefined, 4, operations)

    await expect(storage.read(referenceFor(fileName, resolve(backupPath)))).rejects.toBeInstanceOf(
      BackupAttachmentChangedDuringReadError,
    )
    expect(handle.close).toHaveBeenCalled()
  })

  it('reads only from the configured S3 bucket and deletes the object plus receipt', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(missingObject())
      .mockResolvedValueOnce({ Body: Readable.from([Buffer.from('encrypted-s3-backup')]) })
      .mockResolvedValue({})
    const s3Client = { send } as unknown as S3Client
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath, 'owned-backups', s3Client)
    const reference = referenceFor('00000000-0000-4000-8000-000000000001', 'owned-backups')

    await expect(storage.read(reference)).resolves.toEqual(Buffer.from('encrypted-s3-backup'))
    await expect(storage.delete(reference)).resolves.toBeUndefined()

    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand)
    const getCommand = send.mock.calls[1][0] as GetObjectCommand
    expect(getCommand).toBeInstanceOf(GetObjectCommand)
    expect(getCommand.input).toEqual({
      Bucket: 'owned-backups',
      Key: reference.fileName,
      Range: 'bytes=0-10485760',
    })
    const deleteInputs = send.mock.calls.slice(2).map(([command]) => (command as DeleteObjectCommand).input)
    expect(deleteInputs).toEqual(
      expect.arrayContaining([
        { Bucket: 'owned-backups', Key: reference.fileName },
        { Bucket: 'owned-backups', Key: `${reference.fileName}.delivered` },
      ]),
    )
  })

  it('persists an S3 receipt before deleting source bytes and blocks replay', async () => {
    const send = jest.fn().mockResolvedValue({})
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath, 'owned-backups', { send } as unknown as S3Client)
    const reference = referenceFor('backup.json', 'owned-backups')

    await storage.markDelivered(reference)

    const putCommand = send.mock.calls[0][0] as PutObjectCommand
    expect(putCommand).toBeInstanceOf(PutObjectCommand)
    expect(putCommand.input).toEqual({
      Bucket: 'owned-backups',
      Key: 'backup.json.delivered',
      Body: '',
      ContentType: 'application/x-standard-notes-delivery-receipt',
    })
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand)

    send.mockClear()
    send.mockResolvedValueOnce({})
    await expect(storage.read(reference)).rejects.toBeInstanceOf(BackupAttachmentAlreadyDeliveredError)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand)
  })

  it('rejects another S3 bucket before making an SDK request', async () => {
    const send = jest.fn()
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath, 'owned-backups', {
      send,
    } as unknown as S3Client)

    await expect(
      storage.read(referenceFor('00000000-0000-4000-8000-000000000001', 'attacker-bucket')),
    ).rejects.toBeInstanceOf(InvalidBackupAttachmentReferenceError)
    expect(send).not.toHaveBeenCalled()
  })

  it('maps a missing S3 object to the storage not-found contract after checking its receipt', async () => {
    const send = jest.fn().mockRejectedValueOnce(missingObject()).mockRejectedValueOnce(missingObject())
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath, 'owned-backups', {
      send,
    } as unknown as S3Client)

    await expect(
      storage.read(referenceFor('00000000-0000-4000-8000-000000000001', 'owned-backups')),
    ).rejects.toBeInstanceOf(BackupAttachmentNotFoundError)
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand)
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand)
  })

  it('caps the S3 range and rejects the sentinel byte instead of buffering the full object', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(missingObject())
      .mockResolvedValueOnce({ Body: Readable.from([Buffer.from('12'), Buffer.from('345')]) })
    const storage = new FSOrS3BackupAttachmentStorage(uploadPath, 'owned-backups', { send } as unknown as S3Client, 4)

    await expect(storage.read(referenceFor('backup.json', 'owned-backups'))).rejects.toBeInstanceOf(
      BackupAttachmentTooLargeError,
    )

    const getCommand = send.mock.calls[1][0] as GetObjectCommand
    expect(getCommand.input.Range).toBe('bytes=0-4')
  })

  it('fails fast on an unsafe attachment byte limit', () => {
    expect(() => new FSOrS3BackupAttachmentStorage(uploadPath, undefined, undefined, 0)).toThrow(RangeError)
  })

  function fileStats(size: number, ino: number, dev: number, mtimeMs: number): Stats {
    return {
      size,
      ino,
      dev,
      mtimeMs,
      ctimeMs: mtimeMs,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as Stats
  }

  function fileOperationsFor(options: {
    requestedPath: string
    canonicalRoot: string
    canonicalPath: string
    originalStats: Stats
    handle: jest.Mocked<FileHandle>
  }): jest.Mocked<BackupAttachmentFileOperations> {
    return {
      lstat: jest.fn().mockImplementation(async (path: string) => {
        if (path.endsWith('.delivered')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        if (path === options.requestedPath) {
          return options.originalStats
        }
        throw new Error(`Unexpected lstat path: ${path}`)
      }),
      realpath: jest.fn().mockImplementation(async (path: string) => {
        if (path === resolve(backupPath)) {
          return options.canonicalRoot
        }
        if (path === options.requestedPath) {
          return options.canonicalPath
        }
        throw new Error(`Unexpected realpath path: ${path}`)
      }),
      open: jest.fn().mockResolvedValue(options.handle),
      rename: jest.fn().mockResolvedValue(undefined),
      unlink: jest.fn().mockResolvedValue(undefined),
    }
  }
})
