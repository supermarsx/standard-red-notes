import 'reflect-metadata'
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { S3FileMover } from './S3FileMover'

describe('S3FileMover', () => {
  let s3Client: S3Client

  const createMover = () => new S3FileMover(s3Client, 'bucket')

  const commands = () => (s3Client.send as jest.Mock).mock.calls.map(([command]) => command)

  beforeEach(() => {
    s3Client = {} as jest.Mocked<S3Client>
    s3Client.send = jest.fn()
  })

  it('copies the object to the destination before deleting the source', async () => {
    await createMover().moveFile('user/source', 'vault/destination')

    const [copy, remove] = commands()
    expect(copy).toBeInstanceOf(CopyObjectCommand)
    expect(copy.input).toEqual({
      Bucket: 'bucket',
      CopySource: 'bucket/user/source',
      Key: 'vault/destination',
    })
    expect(remove).toBeInstanceOf(DeleteObjectCommand)
    expect(remove.input).toEqual({ Bucket: 'bucket', Key: 'user/source' })
  })

  it('does not delete the source when the copy failed', async () => {
    s3Client.send = jest.fn().mockRejectedValueOnce(new Error('S3 is down'))

    await expect(createMover().moveFile('user/source', 'vault/destination')).rejects.toThrow('S3 is down')

    expect(commands()).toHaveLength(1)
    expect(commands()[0]).toBeInstanceOf(CopyObjectCommand)
  })
})
