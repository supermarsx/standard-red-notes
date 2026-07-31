import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as v8 from 'v8'
import { Logger } from 'winston'

import { HeapProfiler } from './HeapProfiler'

jest.mock('v8', () => ({ writeHeapSnapshot: jest.fn() }))
jest.mock('fs', () => ({ readFileSync: jest.fn(), unlinkSync: jest.fn() }))

describe('HeapProfiler', () => {
  let logger: Logger
  let s3Client: S3Client

  const snapshotBuffer = Buffer.from('heap')

  const createProfiler = () => new HeapProfiler(logger, s3Client, 'snapshots')

  // The interval is 15 minutes; nothing here waits on real time.
  const FIFTEEN_MINUTES = 15 * 60 * 1000

  // Lets the queued `void this.takeHeapSnapshot()` promise settle.
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    ;(v8.writeHeapSnapshot as jest.Mock).mockReset()
    ;(fs.readFileSync as jest.Mock).mockReset().mockReturnValue(snapshotBuffer)
    ;(fs.unlinkSync as jest.Mock).mockReset()

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.error = jest.fn()

    s3Client = {} as jest.Mocked<S3Client>
    s3Client.send = jest.fn().mockResolvedValue({})
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should take a snapshot immediately on start and upload it, then delete the local file', async () => {
    createProfiler().start()
    await flush()

    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(1)
    expect(s3Client.send).toHaveBeenCalledTimes(1)

    const command = (s3Client.send as jest.Mock).mock.calls[0][0] as PutObjectCommand
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command.input.Bucket).toEqual('snapshots')
    expect(command.input.Body).toBe(snapshotBuffer)
    expect(command.input.ContentType).toEqual('application/octet-stream')
    expect(command.input.Key).toEqual(expect.stringMatching(/^heap-snapshot-.+\.heapsnapshot$/))

    expect(fs.unlinkSync).toHaveBeenCalledTimes(1)
  })

  it('should keep taking snapshots on the 15 minute interval until stopped', async () => {
    const profiler = createProfiler()
    profiler.start()
    await flush()

    jest.advanceTimersByTime(FIFTEEN_MINUTES)
    await flush()
    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(2)

    profiler.stop()
    jest.advanceTimersByTime(FIFTEEN_MINUTES * 3)
    await flush()
    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith('Stopped heap profiler')
  })

  it('should be a no-op to stop a profiler that never started', () => {
    createProfiler().stop()

    expect(logger.info).not.toHaveBeenCalledWith('Stopped heap profiler')
  })

  it('should not upload or delete anything when no bucket is configured', async () => {
    new HeapProfiler(logger, s3Client, undefined).start()
    await flush()

    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(1)
    expect(s3Client.send).not.toHaveBeenCalled()
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  it('should swallow a snapshot write failure instead of crashing the process', async () => {
    ;(v8.writeHeapSnapshot as jest.Mock).mockImplementation(() => {
      throw new Error('out of disk')
    })

    createProfiler().start()
    await flush()

    expect(s3Client.send).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to take or send heap snapshot.',
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('out of disk')
  })

  it('should log the upload failure and leave the local file in place', async () => {
    s3Client.send = jest.fn().mockRejectedValue(new Error('s3 refused'))

    createProfiler().start()
    await flush()

    expect(fs.unlinkSync).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to upload heap snapshot to S3.',
      expect.objectContaining({ bucketName: 'snapshots' }),
    )
    // The rethrown error is caught by takeHeapSnapshot's own handler.
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to take or send heap snapshot.',
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('s3 refused')
  })

  it('should tag each profiler instance with its own uuid in the snapshot filename', async () => {
    createProfiler().start()
    await flush()
    const firstKey = ((s3Client.send as jest.Mock).mock.calls[0][0] as PutObjectCommand).input.Key as string

    ;(s3Client.send as jest.Mock).mockClear()
    createProfiler().start()
    await flush()
    const secondKey = ((s3Client.send as jest.Mock).mock.calls[0][0] as PutObjectCommand).input.Key as string

    expect(firstKey).not.toEqual(secondKey)
  })
})
