import 'reflect-metadata'

import { createReadStream, fsync, mkdtempSync, promises, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from 'winston'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'

import { FSFileUploader, FSFileUploadOperations } from '../../Infra/FS/FSFileUploader'
import { FSFileDownloader } from '../../Infra/FS/FSFileDownloader'
import { InMemoryUploadRepository } from '../../Infra/InMemory/InMemoryUploadRepository'
import { InMemoryValetTokenRepository } from '../../Infra/InMemory/InMemoryValetTokenRepository'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'

import { CreateUploadSession } from './CreateUploadSession/CreateUploadSession'
import { UploadFileChunk } from './UploadFileChunk/UploadFileChunk'
import { FinishUploadSession } from './FinishUploadSession/FinishUploadSession'
import { GetFileMetadata } from './GetFileMetadata/GetFileMetadata'
import { StreamDownloadFile } from './StreamDownloadFile/StreamDownloadFile'

/**
 * Standard Red Notes: proves the ONE identifier the client mints per file — the
 * `remoteIdentifier` the valet token carries in `permittedResources[0]` — keys the
 * same bytes at every server stage, and that the bytes land exactly where a later
 * download looks for them.
 *
 * The reported symptom ("files upload but the server always considers them
 * non-existent") is precisely what a divergence between the write key and the read
 * key would produce, so this drives the real FS uploader and the real FS downloader
 * against one temporary root instead of mocking either side.
 *
 * Everything except the directory fsync is genuine filesystem work. Publishing a
 * finished upload fsyncs the containing DIRECTORY to make the new entry durable,
 * which is a Linux (and container) operation: Windows rejects fsync on a directory
 * handle with EPERM. Only that one call is adapted, so the write path, the
 * published path, and the read path stay real on every platform.
 */
function durabilityTolerantFileOperations(): FSFileUploadOperations {
  const syncFileDescriptor = (fileDescriptor: number): Promise<void> =>
    new Promise((resolveSync, reject) => {
      fsync(fileDescriptor, (error) => (error ? reject(error) : resolveSync()))
    })

  return {
    mkdir: (path, options) => promises.mkdir(path, options),
    open: (path, flags, mode) => promises.open(path, flags, mode),
    sync: (fileHandle) => syncFileDescriptor(fileHandle.fd),
    syncDirectory: async (path) => {
      const directoryHandle = await promises.open(path, 'r')
      try {
        await syncFileDescriptor(directoryHandle.fd)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
          throw error
        }
      } finally {
        await directoryHandle.close()
      }
    },
    link: (existingPath, newPath) => promises.link(existingPath, newPath),
    rm: (path, options) => promises.rm(path, options),
    stat: (path) => promises.stat(path),
    createReadStream: (path) => createReadStream(path),
  }
}

describe('file identifier round trip', () => {
  const userUuid = '00000000-0000-0000-0000-000000000001'
  const remoteIdentifier = '018f2b3c-4d5e-7f80-9123-456789abcdef'

  let uploadRoot: string
  let logger: Logger
  let timer: TimerInterface

  const buildUploader = (): FSFileUploader =>
    new FSFileUploader(uploadRoot, logger, undefined, durabilityTolerantFileOperations())

  const buildFinishUploadSession = (
    fileUploader: FSFileUploader,
    uploadRepository: InMemoryUploadRepository,
    valetTokenRepository: InMemoryValetTokenRepository,
  ): FinishUploadSession =>
    new FinishUploadSession(
      fileUploader,
      uploadRepository,
      { publish: jest.fn() } as unknown as DomainEventPublisherInterface,
      {
        createFileUploadedEvent: jest.fn().mockReturnValue({}),
        createSharedVaultFileUploadedEvent: jest.fn().mockReturnValue({}),
      } as unknown as DomainEventFactoryInterface,
      valetTokenRepository,
    )

  beforeEach(() => {
    uploadRoot = mkdtempSync(join(tmpdir(), 'srn-files-roundtrip-'))
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger
    timer = {
      getTimestampInSeconds: () => 1_000,
      getUTCDateNSecondsAhead: (seconds: number) => new Date((1_000 + seconds) * 1000),
    } as unknown as TimerInterface
  })

  afterEach(() => {
    rmSync(uploadRoot, { recursive: true, force: true })
  })

  it('writes and reads the same bytes under ownerUuid/remoteIdentifier', async () => {
    const fileUploader = buildUploader()
    const fileDownloader = new FSFileDownloader(uploadRoot)
    const uploadRepository = new InMemoryUploadRepository(timer)
    const valetTokenRepository = new InMemoryValetTokenRepository(timer)

    const createUploadSession = new CreateUploadSession(fileUploader, uploadRepository, logger)
    const uploadFileChunk = new UploadFileChunk(fileUploader, uploadRepository, logger)
    const finishUploadSession = buildFinishUploadSession(fileUploader, uploadRepository, valetTokenRepository)
    const getFileMetadata = new GetFileMetadata(fileDownloader, logger)
    const streamDownloadFile = new StreamDownloadFile(fileDownloader, valetTokenRepository, logger)

    // (a) open the session with the remote identifier the valet token carries
    const session = await createUploadSession.execute({
      ownerUuid: userUuid,
      resourceRemoteIdentifier: remoteIdentifier,
    })
    expect(session.success).toBe(true)

    // (b) write the bytes under that same identifier
    const chunks = [Uint8Array.from([1, 2, 3, 4, 5]), Uint8Array.from([6, 7, 8])]
    for (const [index, chunk] of chunks.entries()) {
      const uploaded = await uploadFileChunk.execute({
        ownerUuid: userUuid,
        resourceRemoteIdentifier: remoteIdentifier,
        resourceUnencryptedFileSize: 1_000,
        chunkId: index + 1,
        data: chunk,
      })
      expect(uploaded.success).toBe(true)
    }

    const finished = await finishUploadSession.execute({
      userUuid,
      resourceRemoteIdentifier: remoteIdentifier,
      uploadBytesLimit: -1,
      uploadBytesUsed: 0,
      valetToken: 'write-valet-token',
    })
    expect(finished.isFailed()).toBe(false)

    // The published path is exactly `${ownerUuid}/${remoteIdentifier}` — no
    // prefixing, no case folding, no separate storage id.
    expect(readFileSync(join(uploadRoot, userUuid, remoteIdentifier))).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))

    // (c) a later read keyed on the SAME identifier finds it
    const metadata = await getFileMetadata.execute({ ownerUuid: userUuid, resourceRemoteIdentifier: remoteIdentifier })
    expect(metadata.isFailed()).toBe(false)
    expect(metadata.getValue()).toEqual(8)

    const download = await streamDownloadFile.execute({
      ownerUuid: userUuid,
      resourceRemoteIdentifier: remoteIdentifier,
      startRange: 0,
      endRange: 7,
      endRangeOfFile: 7,
      valetToken: 'read-valet-token',
    })
    expect(download.success).toBe(true)

    const downloadedChunks: Buffer[] = []
    for await (const chunk of download.readStream as NodeJS.ReadableStream) {
      downloadedChunks.push(chunk as Buffer)
    }
    expect(Buffer.concat(downloadedChunks)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
  })

  it('reports a genuinely absent file as not found rather than unavailable', async () => {
    const getFileMetadata = new GetFileMetadata(new FSFileDownloader(uploadRoot), logger)

    const metadata = await getFileMetadata.execute({
      ownerUuid: userUuid,
      resourceRemoteIdentifier: remoteIdentifier,
    })

    expect(metadata.isFailed()).toBe(true)
    expect(metadata.getError()).toEqual('Encrypted file data was not found on this server.')
  })

  it('cannot find a file written for one storage owner when read under another', async () => {
    const fileUploader = buildUploader()
    const fileDownloader = new FSFileDownloader(uploadRoot)
    const uploadRepository = new InMemoryUploadRepository(timer)
    const valetTokenRepository = new InMemoryValetTokenRepository(timer)

    const createUploadSession = new CreateUploadSession(fileUploader, uploadRepository, logger)
    const uploadFileChunk = new UploadFileChunk(fileUploader, uploadRepository, logger)
    const finishUploadSession = buildFinishUploadSession(fileUploader, uploadRepository, valetTokenRepository)
    const getFileMetadata = new GetFileMetadata(fileDownloader, logger)

    await createUploadSession.execute({ ownerUuid: userUuid, resourceRemoteIdentifier: remoteIdentifier })
    await uploadFileChunk.execute({
      ownerUuid: userUuid,
      resourceRemoteIdentifier: remoteIdentifier,
      resourceUnencryptedFileSize: 1_000,
      chunkId: 1,
      data: Uint8Array.from([9]),
    })
    const finished = await finishUploadSession.execute({
      userUuid,
      resourceRemoteIdentifier: remoteIdentifier,
      uploadBytesLimit: -1,
      uploadBytesUsed: 0,
      valetToken: 'write-valet-token',
    })
    expect(finished.isFailed()).toBe(false)

    // A shared-vault upload stores under the VAULT uuid, a personal one under the
    // user uuid. A reader that resolves the same file under the other owner misses
    // it entirely: the storage owner and the remote identifier must BOTH agree, and
    // an owner mismatch is indistinguishable from a file that was never uploaded.
    const vaultUuid = '00000000-0000-0000-0000-0000000000ff'
    const metadata = await getFileMetadata.execute({
      ownerUuid: vaultUuid,
      resourceRemoteIdentifier: remoteIdentifier,
    })

    expect(metadata.isFailed()).toBe(true)
    expect(metadata.getError()).toEqual('Encrypted file data was not found on this server.')
  })
})
