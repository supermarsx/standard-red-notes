import 'reflect-metadata'

import { createReadStream, fsync, promises } from 'fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from 'winston'

import { FSFileUploader, FSFileUploadOperations, FSUploadFileHandle } from './FSFileUploader'

describe('FSFileUploader', () => {
  let uploadRoot: string
  let logger: Logger

  const filePath = 'user-uuid/file-uuid'
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])]
  const results = chunks.map((chunk, index) => ({
    chunkId: index + 1,
    chunkSize: chunk.byteLength,
    tag: 'upload-id',
  }))
  const expectedBytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))

  beforeEach(async () => {
    uploadRoot = await mkdtemp(join(tmpdir(), 'srn-fs-uploader-'))
    logger = {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    } as unknown as Logger
  })

  afterEach(async () => {
    await rm(uploadRoot, { recursive: true, force: true })
  })

  const nodeOperations = (): FSFileUploadOperations => ({
    mkdir: (path, options) => promises.mkdir(path, options),
    open: (path, flags, mode) => promises.open(path, flags, mode),
    sync: (fileHandle) =>
      new Promise((resolve, reject) => {
        fsync(fileHandle.fd, (error) => (error ? reject(error) : resolve()))
      }),
    syncDirectory: jest.fn(async () => undefined),
    link: (existingPath, newPath) => promises.link(existingPath, newPath),
    rm: (path, options) => promises.rm(path, options),
    stat: (path) => promises.stat(path),
    createReadStream: (path) => createReadStream(path),
  })

  const createUploader = (
    operations = nodeOperations(),
    generateUuid = () => `attempt-${Math.random().toString(36).slice(2)}`,
  ) => new FSFileUploader(uploadRoot, logger, generateUuid, operations)

  const bufferChunks = async (uploader: FSFileUploader, uploadId: string) => {
    for (let index = 0; index < chunks.length; index++) {
      await uploader.uploadFileChunk({
        uploadId,
        data: chunks[index],
        filePath,
        chunkId: index + 1,
        unencryptedFileSize: 10_000,
      })
    }
  }

  const partialArtifacts = async () => {
    const entries = await readdir(join(uploadRoot, 'user-uuid'))
    return entries.filter((entry) => entry.endsWith('.partial'))
  }

  it('cleans an attempt-owned partial after a write failure and retries without duplicating bytes', async () => {
    const operations = nodeOperations()
    const realOpen = operations.open
    let injectedFailure = false

    operations.open = async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode)
      let writes = 0

      return {
        fd: handle.fd,
        writeFile: async (data: Uint8Array) => {
          writes++
          if (!injectedFailure && writes === 2) {
            injectedFailure = true
            throw new Error('simulated partial write failure')
          }
          await handle.writeFile(data)
        },
        close: () => handle.close(),
      } satisfies FSUploadFileHandle
    }

    const uploader = createUploader(operations)
    const uploadId = await uploader.createUploadSession(filePath)
    await bufferChunks(uploader, uploadId)

    await expect(uploader.finishUploadSession(uploadId, filePath, results)).rejects.toThrow(
      'simulated partial write failure',
    )
    await expect(readFile(join(uploadRoot, filePath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await partialArtifacts()).toEqual([])

    await expect(uploader.finishUploadSession(uploadId, filePath, results)).resolves.toBeUndefined()
    expect(await readFile(join(uploadRoot, filePath))).toEqual(expectedBytes)
    expect(await partialArtifacts()).toEqual([])
  })

  it('treats an identical existing destination as an idempotent completion', async () => {
    const uploader = createUploader()
    const uploadId = await uploader.createUploadSession(filePath)
    await bufferChunks(uploader, uploadId)
    await writeFile(join(uploadRoot, filePath), expectedBytes)

    await expect(uploader.finishUploadSession(uploadId, filePath, results)).resolves.toBeUndefined()
    await expect(uploader.finishUploadSession(uploadId, filePath, results)).resolves.toBeUndefined()

    expect(await readFile(join(uploadRoot, filePath))).toEqual(expectedBytes)
    expect(await partialArtifacts()).toEqual([])
  })

  it('refuses to clobber an existing destination with different content', async () => {
    const uploader = createUploader()
    const uploadId = await uploader.createUploadSession(filePath)
    await bufferChunks(uploader, uploadId)
    const existingBytes = Buffer.from('different-existing-content')
    await writeFile(join(uploadRoot, filePath), existingBytes)

    await expect(uploader.finishUploadSession(uploadId, filePath, results)).rejects.toThrow(
      'content differs from completed upload',
    )

    expect(await readFile(join(uploadRoot, filePath))).toEqual(existingBytes)
    expect(await partialArtifacts()).toEqual([])
  })

  it('allows concurrent identical finish calls while publishing the bytes exactly once', async () => {
    const operations = nodeOperations()
    const uploader = createUploader(operations)
    const uploadId = await uploader.createUploadSession(filePath)
    await bufferChunks(uploader, uploadId)

    await expect(
      Promise.all([
        uploader.finishUploadSession(uploadId, filePath, results),
        uploader.finishUploadSession(uploadId, filePath, results),
      ]),
    ).resolves.toEqual([undefined, undefined])

    expect(await readFile(join(uploadRoot, filePath))).toEqual(expectedBytes)
    expect(await partialArtifacts()).toEqual([])
    expect(operations.syncDirectory).toHaveBeenCalledTimes(2)
    expect(operations.syncDirectory).toHaveBeenCalledWith(join(uploadRoot, 'user-uuid'))
  })

  it('does not remove a temporary path that this attempt did not create', async () => {
    const operations = nodeOperations()
    const uploader = createUploader(operations, () => 'occupied')
    const uploadId = await uploader.createUploadSession(filePath)
    await bufferChunks(uploader, uploadId)
    const occupiedTemporaryPath = join(uploadRoot, 'user-uuid', '.file-uuid.occupied.partial')
    const occupiedBytes = Buffer.from('owned-by-another-attempt')
    await writeFile(occupiedTemporaryPath, occupiedBytes)

    await expect(uploader.finishUploadSession(uploadId, filePath, results)).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(occupiedTemporaryPath)).toEqual(occupiedBytes)
    await expect(readFile(join(uploadRoot, filePath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces hard-link publication errors without creating a destination', async () => {
    const operations = nodeOperations()
    operations.link = async () => {
      throw Object.assign(new Error('hard-link publication is unavailable'), { code: 'EPERM' })
    }
    const uploader = createUploader(operations)
    const uploadId = await uploader.createUploadSession(filePath)
    await bufferChunks(uploader, uploadId)

    await expect(uploader.finishUploadSession(uploadId, filePath, results)).rejects.toThrow(
      'hard-link publication is unavailable',
    )

    await expect(readFile(join(uploadRoot, filePath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await partialArtifacts()).toEqual([])
  })

  it('rejects upload paths that escape the configured root', async () => {
    const uploader = createUploader()

    await expect(uploader.createUploadSession('../escaped-file')).rejects.toThrow(
      'outside the configured file upload directory',
    )
    await expect(uploader.finishUploadSession('upload-id', '../escaped-file', results)).rejects.toThrow(
      'outside the configured file upload directory',
    )
  })

  it('rejects a gapped chunk manifest before creating a destination', async () => {
    const uploader = createUploader()
    const uploadId = await uploader.createUploadSession(filePath)
    await uploader.uploadFileChunk({
      uploadId,
      data: chunks[0],
      filePath,
      chunkId: 1,
      unencryptedFileSize: 10_000,
    })
    await uploader.uploadFileChunk({
      uploadId,
      data: chunks[2],
      filePath,
      chunkId: 3,
      unencryptedFileSize: 10_000,
    })

    await expect(uploader.finishUploadSession(uploadId, filePath, [results[0], results[2]])).rejects.toThrow(
      'Expected chunk 2, received 3',
    )
    await expect(readFile(join(uploadRoot, filePath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await partialArtifacts()).toEqual([])
  })
})
