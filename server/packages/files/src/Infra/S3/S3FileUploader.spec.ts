import 'reflect-metadata'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'

import { S3FileUploader } from './S3FileUploader'

describe('S3FileUploader', () => {
  let s3Client: S3Client

  const createUploader = () => new S3FileUploader(s3Client, 'bucket')

  const commands = () => (s3Client.send as jest.Mock).mock.calls.map(([command]) => command)

  const chunk = (bytes: number, overrides: Record<string, unknown> = {}) => ({
    uploadId: 'upload-id',
    data: new Uint8Array(bytes),
    filePath: 'user/file',
    chunkId: 1,
    unencryptedFileSize: 100,
    ...overrides,
  })

  beforeEach(() => {
    s3Client = {} as jest.Mocked<S3Client>
    s3Client.send = jest.fn().mockResolvedValue({})
  })

  describe('createUploadSession', () => {
    it('opens a private, intelligent-tiering multipart upload and returns its id', async () => {
      s3Client.send = jest.fn().mockResolvedValue({ UploadId: 'upload-id' })

      expect(await createUploader().createUploadSession('user/file')).toEqual('upload-id')
      expect(commands()[0]).toBeInstanceOf(CreateMultipartUploadCommand)
      expect(commands()[0].input).toEqual({
        Bucket: 'bucket',
        Key: 'user/file',
        ACL: 'private',
        StorageClass: 'INTELLIGENT_TIERING',
      })
    })
  })

  describe('uploadFileChunk', () => {
    it('uploads the chunk as the numbered part and returns its etag', async () => {
      s3Client.send = jest.fn().mockResolvedValue({ ETag: 'etag' })

      const uploader = createUploader()
      const data = new Uint8Array(10)

      expect(await uploader.uploadFileChunk(chunk(0, { data, chunkId: 3 }))).toEqual('etag')
      expect(commands()[0]).toBeInstanceOf(UploadPartCommand)
      expect(commands()[0].input).toEqual({
        Body: data,
        Bucket: 'bucket',
        Key: 'user/file',
        PartNumber: 3,
        UploadId: 'upload-id',
      })
    })

    it('refuses a chunk once the authorized unencrypted file size is already reached', async () => {
      const uploader = createUploader()
      await uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(100), chunkId: 1 }))

      await expect(uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(1), chunkId: 2 }))).rejects.toThrow(
        'Could not upload file chunk. Accumulated encrypted file size (100B) already exceeds the unencrypted file size: 100',
      )

      expect(commands()).toHaveLength(1)
    })

    it('accumulates chunk sizes across chunks of the same upload', async () => {
      const uploader = createUploader()
      await uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(60), chunkId: 1 }))
      await uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(40), chunkId: 2 }))

      await expect(uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(1), chunkId: 3 }))).rejects.toThrow(
        /already exceeds the unencrypted file size/,
      )
    })

    it('does not double count a retried chunk id', async () => {
      const uploader = createUploader()
      await uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(60), chunkId: 1 }))
      await uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(60), chunkId: 1 }))

      await expect(uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(1), chunkId: 2 }))).resolves.toBeUndefined()
    })

    it('keeps the running total of separate uploads apart', async () => {
      const uploader = createUploader()
      await uploader.uploadFileChunk(chunk(0, { uploadId: 'upload-one', data: new Uint8Array(100) }))

      await expect(
        uploader.uploadFileChunk(chunk(0, { uploadId: 'upload-two', data: new Uint8Array(1) })),
      ).resolves.toBeUndefined()
    })
  })

  describe('finishUploadSession', () => {
    it('completes the multipart upload with every part it was given', async () => {
      await createUploader().finishUploadSession('upload-id', 'user/file', [
        { chunkId: 1, tag: 'etag-1' },
        { chunkId: 2, tag: 'etag-2' },
      ])

      expect(commands()[0]).toBeInstanceOf(CompleteMultipartUploadCommand)
      expect(commands()[0].input).toEqual({
        Bucket: 'bucket',
        Key: 'user/file',
        MultipartUpload: {
          Parts: [
            { ETag: 'etag-1', PartNumber: 1 },
            { ETag: 'etag-2', PartNumber: 2 },
          ],
        },
        UploadId: 'upload-id',
      })
    })

    it('aborts the upload and rethrows when completing it failed', async () => {
      const error = new Error('S3 is down')
      s3Client.send = jest.fn().mockRejectedValueOnce(error).mockResolvedValue({})

      await expect(createUploader().finishUploadSession('upload-id', 'user/file', [])).rejects.toThrow(error)

      expect(commands()[1]).toBeInstanceOf(AbortMultipartUploadCommand)
      expect(commands()[1].input).toEqual({ Bucket: 'bucket', Key: 'user/file', UploadId: 'upload-id' })
    })

    it('never masks the original failure with a failure of the cleanup abort', async () => {
      s3Client.send = jest
        .fn()
        .mockRejectedValueOnce(new Error('Completing failed'))
        .mockRejectedValueOnce(new Error('Aborting failed too'))

      await expect(createUploader().finishUploadSession('upload-id', 'user/file', [])).rejects.toThrow(
        'Completing failed',
      )
    })

    it('releases the running byte total so the upload id can be reused', async () => {
      const uploader = createUploader()
      await uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(100), chunkId: 1 }))
      await uploader.finishUploadSession('upload-id', 'user/file', [])

      await expect(uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(1), chunkId: 1 }))).resolves.toBeUndefined()
    })

    it('releases the running byte total even when completing failed', async () => {
      const uploader = createUploader()
      await uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(100), chunkId: 1 }))

      s3Client.send = jest.fn().mockRejectedValueOnce(new Error('S3 is down')).mockResolvedValue({})
      await expect(uploader.finishUploadSession('upload-id', 'user/file', [])).rejects.toThrow('S3 is down')

      s3Client.send = jest.fn().mockResolvedValue({})
      await expect(uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(1), chunkId: 1 }))).resolves.toBeUndefined()
    })
  })

  describe('abortUploadSession', () => {
    it('aborts the multipart upload', async () => {
      await createUploader().abortUploadSession('upload-id', 'user/file')

      expect(commands()[0]).toBeInstanceOf(AbortMultipartUploadCommand)
      expect(commands()[0].input).toEqual({ Bucket: 'bucket', Key: 'user/file', UploadId: 'upload-id' })
    })

    it('releases the running byte total for the aborted upload', async () => {
      const uploader = createUploader()
      await uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(100), chunkId: 1 }))
      await uploader.abortUploadSession('upload-id', 'user/file')

      await expect(uploader.uploadFileChunk(chunk(0, { data: new Uint8Array(1), chunkId: 1 }))).resolves.toBeUndefined()
    })
  })
})
