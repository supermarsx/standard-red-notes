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

  /**
   * The scheduling lifecycle of both maintenance jobs. These run unattended for
   * the life of the process, so the properties that matter are that starting is
   * idempotent (a second start must not double the dispatch rate), that stopping
   * actually stops, and that a stop before any start is harmless during a failed
   * boot.
   */
  describe('background scheduling', () => {
    afterEach(() => {
      jest.useRealTimers()
    })

    it('dispatches once immediately on start and then on every interval', async () => {
      jest.useFakeTimers()
      const repository = createOutboxRepository()
      repository.claimNext.mockResolvedValue(null)
      const publisher: jest.Mocked<DomainEventPublisherInterface> = { publish: jest.fn() }
      const logger = { error: jest.fn() } as unknown as Logger
      const dispatcher = new SyncCommandOutboxDispatcher(repository, publisher, logger)

      dispatcher.start(5_000)
      // Waiting a full interval before the first drain would leave events
      // sitting in a durable outbox for no reason.
      expect(repository.claimNext).toHaveBeenCalledTimes(1)
      await dispatcher.waitForIdle()

      jest.advanceTimersByTime(5_000)
      expect(repository.claimNext).toHaveBeenCalledTimes(2)
      await dispatcher.waitForIdle()

      jest.advanceTimersByTime(5_000)
      expect(repository.claimNext).toHaveBeenCalledTimes(3)
      await dispatcher.waitForIdle()

      dispatcher.stop()
      jest.advanceTimersByTime(60_000)
      expect(repository.claimNext).toHaveBeenCalledTimes(3)
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('ignores a second start rather than installing a faster second timer', async () => {
      jest.useFakeTimers()
      const repository = createOutboxRepository()
      repository.claimNext.mockResolvedValue(null)
      const publisher: jest.Mocked<DomainEventPublisherInterface> = { publish: jest.fn() }
      const dispatcher = new SyncCommandOutboxDispatcher(repository, publisher, {
        error: jest.fn(),
      } as unknown as Logger)

      dispatcher.start(5_000)
      await dispatcher.waitForIdle()
      expect(repository.claimNext).toHaveBeenCalledTimes(1)

      dispatcher.start(100)
      await dispatcher.waitForIdle()

      // The second start must be inert: no extra immediate dispatch, and no
      // 100ms timer racing the 5s one.
      expect(repository.claimNext).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(4_000)
      expect(repository.claimNext).toHaveBeenCalledTimes(1)

      dispatcher.stop()
    })

    it('runs cleanup on start and stops scheduling once stopped', async () => {
      jest.useFakeTimers()
      const commandRepository = createCommandRepository()
      const outboxRepository = createOutboxRepository()
      commandRepository.deleteExpired.mockResolvedValue(0)
      outboxRepository.deletePublishedBefore.mockResolvedValue(0)
      const logger = { error: jest.fn() } as unknown as Logger
      const cleanup = new CleanupSyncCommands(commandRepository, outboxRepository, 1_000, logger)

      cleanup.start(30_000)
      expect(commandRepository.deleteExpired).toHaveBeenCalledTimes(1)
      await cleanup.waitForIdle()

      jest.advanceTimersByTime(30_000)
      expect(commandRepository.deleteExpired).toHaveBeenCalledTimes(2)
      await cleanup.waitForIdle()

      cleanup.stop()
      jest.advanceTimersByTime(300_000)
      expect(commandRepository.deleteExpired).toHaveBeenCalledTimes(2)
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('ignores a second cleanup start', async () => {
      jest.useFakeTimers()
      const commandRepository = createCommandRepository()
      const outboxRepository = createOutboxRepository()
      commandRepository.deleteExpired.mockResolvedValue(0)
      outboxRepository.deletePublishedBefore.mockResolvedValue(0)
      const cleanup = new CleanupSyncCommands(commandRepository, outboxRepository, 1_000)

      cleanup.start(30_000)
      await cleanup.waitForIdle()
      cleanup.start(50)
      await cleanup.waitForIdle()

      expect(commandRepository.deleteExpired).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(1_000)
      expect(commandRepository.deleteExpired).toHaveBeenCalledTimes(1)

      cleanup.stop()
    })

    it('tolerates a stop that was never started', () => {
      jest.useFakeTimers()
      const dispatcher = new SyncCommandOutboxDispatcher(createOutboxRepository(), { publish: jest.fn() }, {
        error: jest.fn(),
      } as unknown as Logger)
      const cleanup = new CleanupSyncCommands(createCommandRepository(), createOutboxRepository(), 1_000)

      // Reached whenever boot fails partway and shutdown stops everything.
      expect(() => dispatcher.stop()).not.toThrow()
      expect(() => cleanup.stop()).not.toThrow()

      // Still restartable afterwards.
      dispatcher.stop()
      cleanup.stop()
    })

    it('does not hold the process open with its maintenance timers', () => {
      jest.useFakeTimers()
      const unrefCalls: number[] = []
      const realSetInterval = global.setInterval
      const spy = jest.spyOn(global, 'setInterval').mockImplementation(((handler: () => void, timeout?: number) => {
        const timer = realSetInterval(handler, timeout)
        const originalUnref = timer.unref.bind(timer)
        timer.unref = () => {
          unrefCalls.push(timeout ?? 0)
          return originalUnref()
        }
        return timer
      }) as unknown as typeof setInterval)

      const repository = createOutboxRepository()
      repository.claimNext.mockResolvedValue(null)
      const dispatcher = new SyncCommandOutboxDispatcher(repository, { publish: jest.fn() }, {
        error: jest.fn(),
      } as unknown as Logger)
      const cleanup = new CleanupSyncCommands(createCommandRepository(), createOutboxRepository(), 1_000)

      dispatcher.start(5_000)
      cleanup.start(30_000)

      // A referenced interval keeps the event loop alive and stops the server
      // exiting on SIGTERM, so both maintenance timers must be unref'd.
      expect(unrefCalls).toEqual([5_000, 30_000])

      dispatcher.stop()
      cleanup.stop()
      spy.mockRestore()
    })
  })
})
