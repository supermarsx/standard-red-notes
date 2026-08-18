import 'reflect-metadata'
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'stream'

import { S3FileDownloader } from './S3FileDownloader'

describe('S3FileDownloader', () => {
  let s3Client: S3Client

  const createDownloader = () => new S3FileDownloader(s3Client, 'bucket')

  const lastCommand = () => (s3Client.send as jest.Mock).mock.calls[0][0]
  const lastOptions = () => (s3Client.send as jest.Mock).mock.calls[0][1]

  beforeEach(() => {
    s3Client = {} as jest.Mocked<S3Client>
    s3Client.send = jest.fn()
  })

  describe('createDownloadStream', () => {
    it('requests exactly the byte range asked for and returns the response body', async () => {
      const body = new Readable()
      const abortController = new AbortController()
      s3Client.send = jest.fn().mockResolvedValue({ Body: body })

      const stream = await createDownloader().createDownloadStream('user/file', 10, 20, abortController.signal)

      expect(lastCommand()).toBeInstanceOf(GetObjectCommand)
      expect(lastCommand().input).toEqual({ Bucket: 'bucket', Key: 'user/file', Range: 'bytes=10-20' })
      expect(lastOptions()).toEqual({ abortSignal: abortController.signal })
      expect(stream).toBe(body)
    })
  })

  describe('getFileSize', () => {
    it('returns the content length reported by a HEAD of the object', async () => {
      s3Client.send = jest.fn().mockResolvedValue({ ContentLength: 4096 })
      const abortController = new AbortController()

      expect(await createDownloader().getFileSize('user/file', abortController.signal)).toEqual(4096)
      expect(lastCommand()).toBeInstanceOf(HeadObjectCommand)
      expect(lastCommand().input).toEqual({ Bucket: 'bucket', Key: 'user/file' })
      expect(lastOptions()).toEqual({ abortSignal: abortController.signal })
    })
  })

  describe('listFiles', () => {
    it("lists the objects under the user's prefix with their sizes", async () => {
      s3Client.send = jest.fn().mockResolvedValue({
        Contents: [
          { Key: 'user/one', Size: 1 },
          { Key: 'user/two', Size: 2 },
        ],
      })

      expect(await createDownloader().listFiles('user')).toEqual([
        { name: 'user/one', size: 1 },
        { name: 'user/two', size: 2 },
      ])
      expect(lastCommand()).toBeInstanceOf(ListObjectsV2Command)
      expect(lastCommand().input).toEqual({ Bucket: 'bucket', Prefix: 'user' })
    })

    it('returns an empty list when the bucket holds nothing for the user', async () => {
      s3Client.send = jest.fn().mockResolvedValue({})

      expect(await createDownloader().listFiles('user')).toEqual([])
    })

    it('skips objects that have no key', async () => {
      s3Client.send = jest.fn().mockResolvedValue({ Contents: [{ Size: 1 }, { Key: 'user/two', Size: 2 }] })

      expect(await createDownloader().listFiles('user')).toEqual([{ name: 'user/two', size: 2 }])
    })

    it('reports an object with no reported size as zero bytes', async () => {
      s3Client.send = jest.fn().mockResolvedValue({ Contents: [{ Key: 'user/one' }] })

      expect(await createDownloader().listFiles('user')).toEqual([{ name: 'user/one', size: 0 }])
    })
  })
})
