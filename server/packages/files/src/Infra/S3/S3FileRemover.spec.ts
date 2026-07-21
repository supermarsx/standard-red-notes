import 'reflect-metadata'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'

import { S3FileRemover } from './S3FileRemover'

describe('S3FileRemover', () => {
  let s3Client: S3Client

  const createRemover = () => new S3FileRemover(s3Client, 'bucket')

  const commands = () => (s3Client.send as jest.Mock).mock.calls.map(([command]) => command)

  beforeEach(() => {
    s3Client = {} as jest.Mocked<S3Client>
    s3Client.send = jest.fn()
  })

  describe('markFilesToBeRemoved', () => {
    it("lists only the objects under the owner's prefix", async () => {
      s3Client.send = jest.fn().mockResolvedValue({ Contents: undefined })

      await createRemover().markFilesToBeRemoved('user')

      expect(commands()[0]).toBeInstanceOf(ListObjectsV2Command)
      expect(commands()[0].input).toEqual({ Bucket: 'bucket', Prefix: 'user/' })
    })

    it('removes nothing and describes nothing when the owner has no objects', async () => {
      s3Client.send = jest.fn().mockResolvedValue({})

      expect(await createRemover().markFilesToBeRemoved('user')).toEqual([])
      expect(commands()).toHaveLength(1)
    })

    it('archives each object into the expiration chamber before deleting it', async () => {
      s3Client.send = jest
        .fn()
        .mockResolvedValueOnce({ Contents: [{ Key: 'user/file', Size: 123 }] })
        .mockResolvedValue({})

      await createRemover().markFilesToBeRemoved('user')

      const [, copy, remove] = commands()
      expect(copy).toBeInstanceOf(CopyObjectCommand)
      expect(copy.input).toEqual({
        Bucket: 'bucket',
        Key: 'expiration-chamber/user/file',
        CopySource: 'bucket/user/file',
        StorageClass: 'DEEP_ARCHIVE',
      })
      expect(remove).toBeInstanceOf(DeleteObjectCommand)
      expect(remove.input).toEqual({ Bucket: 'bucket', Key: 'user/file' })
    })

    it('describes each removed file with its size and its name relative to the owner', async () => {
      s3Client.send = jest
        .fn()
        .mockResolvedValueOnce({
          Contents: [
            { Key: 'user/one', Size: 1 },
            { Key: 'user/nested/two', Size: 2 },
          ],
        })
        .mockResolvedValue({})

      expect(await createRemover().markFilesToBeRemoved('user')).toEqual([
        { fileByteSize: 1, fileName: 'one', filePath: 'user/one', userOrSharedVaultUuid: 'user' },
        {
          fileByteSize: 2,
          fileName: 'nested/two',
          filePath: 'user/nested/two',
          userOrSharedVaultUuid: 'user',
        },
      ])
    })

    it('skips an object that has no key rather than archiving it', async () => {
      s3Client.send = jest
        .fn()
        .mockResolvedValueOnce({ Contents: [{ Size: 1 }, { Key: 'user/two', Size: 2 }] })
        .mockResolvedValue({})

      const descriptions = await createRemover().markFilesToBeRemoved('user')

      expect(descriptions).toHaveLength(1)
      expect(descriptions[0].filePath).toEqual('user/two')
    })
  })

  describe('remove', () => {
    it('returns the size the object had before deleting it', async () => {
      s3Client.send = jest.fn().mockResolvedValueOnce({ ContentLength: 4096 }).mockResolvedValue({})

      expect(await createRemover().remove('user/file')).toEqual(4096)

      const [head, remove] = commands()
      expect(head).toBeInstanceOf(HeadObjectCommand)
      expect(head.input).toEqual({ Bucket: 'bucket', Key: 'user/file' })
      expect(remove).toBeInstanceOf(DeleteObjectCommand)
      expect(remove.input).toEqual({ Bucket: 'bucket', Key: 'user/file' })
    })

    it('does not delete the object when its size could not be read', async () => {
      s3Client.send = jest.fn().mockRejectedValueOnce(new Error('S3 is down'))

      await expect(createRemover().remove('user/file')).rejects.toThrow('S3 is down')

      expect(commands()).toHaveLength(1)
    })
  })
})
