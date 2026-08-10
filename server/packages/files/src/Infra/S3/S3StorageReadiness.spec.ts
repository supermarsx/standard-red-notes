import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'

import { S3StorageReadiness } from './S3StorageReadiness'

describe('S3StorageReadiness', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses the non-mutating authenticated bucket capability probe', async () => {
    const send = jest.fn().mockResolvedValue({})
    const client = { send } as unknown as S3Client

    await new S3StorageReadiness(client, 'uploads').check()

    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0]
    expect(command).toBeInstanceOf(HeadBucketCommand)
    expect(command.input).toEqual({ Bucket: 'uploads' })
    expect(send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('fails closed when the credential lacks the required HeadBucket/ListBucket permission', async () => {
    const client = {
      send: jest.fn().mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' })),
    } as unknown as S3Client

    await expect(new S3StorageReadiness(client, 'uploads').check()).rejects.toMatchObject({ name: 'AccessDenied' })
  })

  it('propagates an unavailable or unauthorized bucket', async () => {
    const client = { send: jest.fn().mockRejectedValue(new Error('forbidden')) } as unknown as S3Client

    await expect(new S3StorageReadiness(client, 'uploads').check()).rejects.toThrow('forbidden')
  })

  it('aborts a stalled S3 request at its own bound and clears the timer', async () => {
    jest.useFakeTimers()
    let signal: AbortSignal | undefined
    const client = {
      send: jest.fn((_command, options: { abortSignal: AbortSignal }) => {
        signal = options.abortSignal

        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }),
    } as unknown as S3Client
    const check = new S3StorageReadiness(client, 'uploads', 25).check()
    const result = check.catch((error: Error) => error)

    await jest.advanceTimersByTimeAsync(25)

    expect(await result).toMatchObject({ message: 'aborted' })
    expect(signal?.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })
})
