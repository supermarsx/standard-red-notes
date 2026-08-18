import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { CleanupSyncCommands } from './CleanupSyncCommands'
import { SyncCommandOutboxDispatcher } from './SyncCommandOutboxDispatcher'
import { SyncCommandOutboxRepositoryInterface } from './SyncCommandOutboxRepositoryInterface'
import { SyncCommandRepositoryInterface } from './SyncCommandRepositoryInterface'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const createOutboxRepository = (): jest.Mocked<SyncCommandOutboxRepositoryInterface> => ({
  enqueue: jest.fn(),
  claimNext: jest.fn(),
  markPublished: jest.fn(),
  releaseForRetry: jest.fn(),
  deletePublishedBefore: jest.fn(),
})

const createCommandRepository = (): jest.Mocked<SyncCommandRepositoryInterface> => ({
  insertAcceptedIfAbsent: jest.fn(),
  find: jest.fn(),
  claimAccepted: jest.fn(),
  commit: jest.fn(),
  deleteExpired: jest.fn(),
})

describe('sync command maintenance jobs', () => {
  it('keeps outbox dispatch single-flight when multiple wakeups overlap', async () => {
    const repository = createOutboxRepository()
    const claim = deferred<null>()
    repository.claimNext.mockReturnValue(claim.promise)
    const publisher: jest.Mocked<DomainEventPublisherInterface> = { publish: jest.fn() }
    const logger = { error: jest.fn() } as unknown as Logger
    const dispatcher = new SyncCommandOutboxDispatcher(repository, publisher, logger)

    dispatcher.wake()
    dispatcher.wake()

    expect(repository.claimNext).toHaveBeenCalledTimes(1)
    claim.resolve(null)
    await dispatcher.waitForIdle()
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('catches and logs a rejected background outbox wakeup', async () => {
    const repository = createOutboxRepository()
    const failure = new Error('database unavailable')
    repository.claimNext.mockRejectedValue(failure)
    const publisher: jest.Mocked<DomainEventPublisherInterface> = { publish: jest.fn() }
    const logger = { error: jest.fn() } as unknown as Logger
    const dispatcher = new SyncCommandOutboxDispatcher(repository, publisher, logger)

    dispatcher.wake()
    await expect(dispatcher.waitForIdle()).rejects.toBe(failure)
    await Promise.resolve()

    expect(logger.error).toHaveBeenCalledWith(
      'Sync command outbox background dispatch failed.',
      expect.objectContaining({ codeTag: 'SyncCommandOutboxDispatcher', error: 'database unavailable' }),
    )
  })

  it('keeps cleanup single-flight when multiple scheduled wakeups overlap', async () => {
    const commandRepository = createCommandRepository()
    const outboxRepository = createOutboxRepository()
    const deletion = deferred<number>()
    commandRepository.deleteExpired.mockReturnValue(deletion.promise)
    outboxRepository.deletePublishedBefore.mockResolvedValue(3)
    const logger = { error: jest.fn() } as unknown as Logger
    const cleanup = new CleanupSyncCommands(commandRepository, outboxRepository, 1_000, logger)

    cleanup.wake()
    cleanup.wake()

    expect(commandRepository.deleteExpired).toHaveBeenCalledTimes(1)
    expect(outboxRepository.deletePublishedBefore).not.toHaveBeenCalled()
    deletion.resolve(2)
    await cleanup.waitForIdle()
    expect(outboxRepository.deletePublishedBefore).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('catches and logs a rejected background cleanup wakeup', async () => {
    const commandRepository = createCommandRepository()
    const outboxRepository = createOutboxRepository()
    const failure = new Error('cleanup query failed')
    commandRepository.deleteExpired.mockRejectedValue(failure)
    const logger = { error: jest.fn() } as unknown as Logger
    const cleanup = new CleanupSyncCommands(commandRepository, outboxRepository, 1_000, logger)

    cleanup.wake()
    await expect(cleanup.waitForIdle()).rejects.toBe(failure)
    await Promise.resolve()

    expect(logger.error).toHaveBeenCalledWith(
      'Sync command cleanup background run failed.',
      expect.objectContaining({ codeTag: 'CleanupSyncCommands', errorType: 'Error' }),
    )
  })
})
