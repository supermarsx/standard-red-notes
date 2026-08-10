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

    it('archives every object across more than one thousand paginated results', async () => {
      const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
        Key: `user/file-${index}`,
        Size: index,
      }))

      s3Client.send = jest.fn().mockImplementation((command) => {
        if (command instanceof ListObjectsV2Command) {
          if (command.input.ContinuationToken === undefined) {
            return Promise.resolve({
              Contents: firstPage,
              IsTruncated: true,
              NextContinuationToken: 'page-2',
            })
          }

          return Promise.resolve({
            Contents: [{ Key: 'user/file-1000', Size: 1_000 }],
            IsTruncated: false,
          })
        }

        return Promise.resolve({})
      })

      const descriptions = await createRemover().markFilesToBeRemoved('user')

      expect(descriptions).toHaveLength(1_001)
      expect(descriptions.at(-1)).toEqual({
        fileByteSize: 1_000,
        fileName: 'file-1000',
        filePath: 'user/file-1000',
        userOrSharedVaultUuid: 'user',
      })

      const listCommands = commands().filter((command) => command instanceof ListObjectsV2Command)
      expect(listCommands).toHaveLength(2)
      expect(listCommands[1].input).toEqual({
        Bucket: 'bucket',
        Prefix: 'user/',
        ContinuationToken: 'page-2',
      })
      expect(commands().filter((command) => command instanceof CopyObjectCommand)).toHaveLength(1_001)
      expect(commands().filter((command) => command instanceof DeleteObjectCommand)).toHaveLength(1_001)
    })

    it('continues after an empty page when S3 provides a continuation token', async () => {
      s3Client.send = jest.fn().mockImplementation((command) => {
        if (command instanceof ListObjectsV2Command) {
          if (command.input.ContinuationToken === undefined) {
            return Promise.resolve({ Contents: [], IsTruncated: true, NextContinuationToken: 'next-page' })
          }

          return Promise.resolve({ Contents: [{ Key: 'user/file', Size: 123 }], IsTruncated: false })
        }

        return Promise.resolve({})
      })

      await expect(createRemover().markFilesToBeRemoved('user')).resolves.toEqual([
        { fileByteSize: 123, fileName: 'file', filePath: 'user/file', userOrSharedVaultUuid: 'user' },
      ])
    })

    it('rejects an incomplete traversal before changing any object', async () => {
      s3Client.send = jest.fn().mockResolvedValue({
        Contents: [{ Key: 'user/file', Size: 123 }],
        IsTruncated: true,
      })

      await expect(createRemover().markFilesToBeRemoved('user')).rejects.toThrow(
        'Could not completely list files marked for removal',
      )

      expect(commands().filter((command) => command instanceof CopyObjectCommand)).toHaveLength(0)
      expect(commands().filter((command) => command instanceof DeleteObjectCommand)).toHaveLength(0)
    })

    it('rejects a repeated continuation token before changing any object', async () => {
      s3Client.send = jest.fn().mockResolvedValue({
        Contents: [{ Key: 'user/file', Size: 123 }],
        IsTruncated: true,
        NextContinuationToken: 'same-page',
      })

      await expect(createRemover().markFilesToBeRemoved('user')).rejects.toThrow(
        'Could not completely list files marked for removal',
      )

      expect(commands().filter((command) => command instanceof CopyObjectCommand)).toHaveLength(0)
      expect(commands().filter((command) => command instanceof DeleteObjectCommand)).toHaveLength(0)
    })

    it('deduplicates the same object key across pages', async () => {
      s3Client.send = jest.fn().mockImplementation((command) => {
        if (command instanceof ListObjectsV2Command && command.input.ContinuationToken === undefined) {
          return Promise.resolve({
            Contents: [{ Key: 'user/file', Size: 123 }],
            IsTruncated: true,
            NextContinuationToken: 'page-2',
          })
        }
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [{ Key: 'user/file', Size: 123 }], IsTruncated: false })
        }

        return Promise.resolve({})
      })

      await expect(createRemover().markFilesToBeRemoved('user')).resolves.toEqual([
        { fileByteSize: 123, fileName: 'file', filePath: 'user/file', userOrSharedVaultUuid: 'user' },
      ])
      expect(commands().filter((command) => command instanceof CopyObjectCommand)).toHaveLength(1)
      expect(commands().filter((command) => command instanceof DeleteObjectCommand)).toHaveLength(1)
    })

    it('rejects a failed archive copy without deleting its source object', async () => {
      s3Client.send = jest.fn().mockImplementation((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({
            Contents: [
              { Key: 'user/one', Size: 123 },
              { Key: 'user/two', Size: 456 },
            ],
          })
        }
        if (command instanceof CopyObjectCommand && command.input.Key === 'expiration-chamber/user/two') {
          return Promise.reject(new Error('copy failed'))
        }

        return Promise.resolve({})
      })

      await expect(createRemover().markFilesToBeRemoved('user')).rejects.toThrow('copy failed')

      expect(commands().filter((command) => command instanceof DeleteObjectCommand)).toHaveLength(0)
    })

    it('rejects a failed source deletion so the account cleanup can be retried', async () => {
      s3Client.send = jest.fn().mockImplementation((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [{ Key: 'user/file', Size: 123 }] })
        }
        if (command instanceof DeleteObjectCommand) {
          return Promise.reject(new Error('delete failed'))
        }

        return Promise.resolve({})
      })

      await expect(createRemover().markFilesToBeRemoved('user')).rejects.toThrow('delete failed')
    })

    it('safely retries an object when its first deletion failed after archiving', async () => {
      let sourceExists = true
      let deleteAttempts = 0

      s3Client.send = jest.fn().mockImplementation((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({
            Contents: sourceExists ? [{ Key: 'user/file', Size: 123 }] : [],
          })
        }
        if (command instanceof DeleteObjectCommand) {
          deleteAttempts += 1
          if (deleteAttempts === 1) {
            return Promise.reject(new Error('transient delete failure'))
          }

          sourceExists = false
        }

        return Promise.resolve({})
      })

      const remover = createRemover()
      await expect(remover.markFilesToBeRemoved('user')).rejects.toThrow('transient delete failure')
      await expect(remover.markFilesToBeRemoved('user')).resolves.toEqual([
        { fileByteSize: 123, fileName: 'file', filePath: 'user/file', userOrSharedVaultUuid: 'user' },
      ])
      await expect(remover.markFilesToBeRemoved('user')).resolves.toEqual([])

      expect(commands().filter((command) => command instanceof CopyObjectCommand)).toHaveLength(2)
      expect(commands().filter((command) => command instanceof DeleteObjectCommand)).toHaveLength(2)
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
