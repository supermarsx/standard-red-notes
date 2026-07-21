import { TimerInterface } from '@standardnotes/time'

import { InMemoryUploadRepository } from './InMemoryUploadRepository'

describe('InMemoryUploadRepository', () => {
  let timer: TimerInterface
  let now: number

  const createRepository = () => new InMemoryUploadRepository(timer)

  beforeEach(() => {
    now = 1_000
    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInSeconds = jest.fn().mockImplementation(() => now)
    // The repository divides the returned Date by 1000 to get seconds.
    timer.getUTCDateNSecondsAhead = jest.fn().mockImplementation((seconds: number) => new Date((now + seconds) * 1000))
  })

  it('returns the upload session id it stored for a file path', async () => {
    const repository = createRepository()
    await repository.storeUploadSession('user/file', 'upload-id')

    expect(await repository.retrieveUploadSessionId('user/file')).toEqual('upload-id')
  })

  it('returns undefined for a file path that has no upload session', async () => {
    expect(await createRepository().retrieveUploadSessionId('user/unknown')).toBeUndefined()
  })

  it('keeps the sessions of different file paths apart', async () => {
    const repository = createRepository()
    await repository.storeUploadSession('user/one', 'upload-one')
    await repository.storeUploadSession('user/two', 'upload-two')

    expect(await repository.retrieveUploadSessionId('user/one')).toEqual('upload-one')
    expect(await repository.retrieveUploadSessionId('user/two')).toEqual('upload-two')
  })

  it('forgets an upload session once its ttl has elapsed', async () => {
    const repository = createRepository()
    await repository.storeUploadSession('user/file', 'upload-id')

    now += 7_201

    expect(await repository.retrieveUploadSessionId('user/file')).toBeUndefined()
  })

  it('returns an empty list for an upload that has no chunk results', async () => {
    expect(await createRepository().retrieveUploadChunkResults('upload-id')).toEqual([])
  })

  it('returns the stored chunk results ordered by chunk id, not by insertion order', async () => {
    const repository = createRepository()
    await repository.storeUploadChunkResult('upload-id', { chunkId: 2, tag: 'two' })
    await repository.storeUploadChunkResult('upload-id', { chunkId: 1, tag: 'one' })
    await repository.storeUploadChunkResult('upload-id', { chunkId: 3, tag: 'three' })

    expect(await repository.retrieveUploadChunkResults('upload-id')).toEqual([
      { chunkId: 1, tag: 'one' },
      { chunkId: 2, tag: 'two' },
      { chunkId: 3, tag: 'three' },
    ])
  })

  it('keeps the chunk results of different uploads apart', async () => {
    const repository = createRepository()
    await repository.storeUploadChunkResult('upload-one', { chunkId: 1, tag: 'one' })
    await repository.storeUploadChunkResult('upload-two', { chunkId: 1, tag: 'two' })

    expect(await repository.retrieveUploadChunkResults('upload-one')).toEqual([{ chunkId: 1, tag: 'one' }])
    expect(await repository.retrieveUploadChunkResults('upload-two')).toEqual([{ chunkId: 1, tag: 'two' }])
  })

  it('forgets the chunk results once their ttl has elapsed', async () => {
    const repository = createRepository()
    await repository.storeUploadChunkResult('upload-id', { chunkId: 1, tag: 'one' })

    now += 7_201

    expect(await repository.retrieveUploadChunkResults('upload-id')).toEqual([])
  })

  it('does not discard entries that are still within their ttl', async () => {
    const repository = createRepository()
    await repository.storeUploadSession('user/file', 'upload-id')
    await repository.storeUploadChunkResult('upload-id', { chunkId: 1, tag: 'one' })

    now += 7_000

    expect(await repository.retrieveUploadSessionId('user/file')).toEqual('upload-id')
    expect(await repository.retrieveUploadChunkResults('upload-id')).toEqual([{ chunkId: 1, tag: 'one' }])
  })
})
