import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { CleanupSyncCommands } from './CleanupSyncCommands'
import { SYNC_COMMAND_OUTBOX_MAX_ATTEMPTS_DEFAULT, SyncCommandOutboxDispatcher } from './SyncCommandOutboxDispatcher'
import {
  ClaimedSyncCommandOutboxEvent,
  SyncCommandOutboxRepositoryInterface,
} from './SyncCommandOutboxRepositoryInterface'
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
  markDead: jest.fn(),
  deletePublishedBefore: jest.fn(),
})

const claimedEvent = (attempts: number, uuid = 'outbox-1'): ClaimedSyncCommandOutboxEvent => ({
  uuid,
  lockToken: 'lock-1',
  attempts,
  event: {
    type: 'SYNC_ITEMS_PUSHED',
    createdAt: new Date(1),
    payload: {},
    meta: { correlation: { userIdentifier: 'user-uuid', userIdentifierType: 'uuid' }, origin: 'syncing-server' },
  } as unknown as DomainEventInterface,
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
      expect.objectContaining({ codeTag: 'SyncCommandOutboxDispatcher', errorType: 'Error' }),
    )
    // Safe logging: the failure's raw message must never reach the log.
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('database unavailable')
  })

  /**
   * Attempt cap (t90 R12). Without it a poison event — one the broker rejects
   * every time, e.g. an oversized SYNC_ITEMS_PUSHED — is retried on every
   * maintenance sweep forever, logging an error each time.
   */
  describe('outbox attempt cap', () => {
    it('caps delivery at 20 attempts by default', () => {
      expect(SYNC_COMMAND_OUTBOX_MAX_ATTEMPTS_DEFAULT).toBe(20)
    })

    it('releases a failed event for retry while attempts remain, naming the event type', async () => {
      const repository = createOutboxRepository()
      repository.claimNext.mockResolvedValueOnce(claimedEvent(19)).mockResolvedValue(null)
      const publisher: jest.Mocked<DomainEventPublisherInterface> = {
        publish: jest.fn().mockRejectedValue(new Error('broker down')),
      }
      const logger = { error: jest.fn() } as unknown as Logger
      const dispatcher = new SyncCommandOutboxDispatcher(repository, publisher, logger)

      await expect(dispatcher.dispatchAvailable()).resolves.toBe(0)

      expect(repository.releaseForRetry).toHaveBeenCalledWith('outbox-1', 'lock-1', expect.any(Number))
      expect(repository.markDead).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledWith(
        'Sync command outbox dispatch failed; event remains durable for retry.',
        expect.objectContaining({
          codeTag: 'SyncCommandOutboxDispatcher',
          outboxEventId: 'outbox-1',
          eventType: 'SYNC_ITEMS_PUSHED',
          attempts: 19,
          maxAttempts: 20,
        }),
      )
    })

    it('marks the event dead on the 20th failed attempt and stops retrying it', async () => {
      const repository = createOutboxRepository()
      repository.claimNext.mockResolvedValueOnce(claimedEvent(20)).mockResolvedValue(null)
      const publisher: jest.Mocked<DomainEventPublisherInterface> = {
        publish: jest.fn().mockRejectedValue(new Error('MessageTooLong')),
      }
      const logger = { error: jest.fn() } as unknown as Logger
      const dispatcher = new SyncCommandOutboxDispatcher(repository, publisher, logger)

      await expect(dispatcher.dispatchAvailable()).resolves.toBe(0)

      expect(repository.markDead).toHaveBeenCalledWith('outbox-1', 'lock-1', expect.any(Number))
      expect(repository.releaseForRetry).not.toHaveBeenCalled()
      expect(repository.markPublished).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledWith(
        'Sync command outbox event exhausted its delivery attempts and was marked dead.',
        expect.objectContaining({
          codeTag: 'SyncCommandOutboxDispatcher',
          outboxEventId: 'outbox-1',
          eventType: 'SYNC_ITEMS_PUSHED',
          attempts: 20,
          maxAttempts: 20,
          errorType: 'Error',
        }),
      )
      // Safe logging: the broker's raw message must never reach the log.
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('MessageTooLong')
      // The drain carries on past the dead row rather than aborting the sweep.
      expect(repository.claimNext).toHaveBeenCalledTimes(2)
    })

    it('keeps publishing healthy events after a dead one in the same sweep', async () => {
      const repository = createOutboxRepository()
      repository.claimNext
        .mockResolvedValueOnce(claimedEvent(20, 'poison'))
        .mockResolvedValueOnce(claimedEvent(1, 'healthy'))
        .mockResolvedValue(null)
      const publisher: jest.Mocked<DomainEventPublisherInterface> = {
        publish: jest.fn().mockRejectedValueOnce(new Error('MessageTooLong')).mockResolvedValueOnce(undefined),
      }
      const logger = { error: jest.fn() } as unknown as Logger
      const dispatcher = new SyncCommandOutboxDispatcher(repository, publisher, logger)

      await expect(dispatcher.dispatchAvailable()).resolves.toBe(1)

      expect(repository.markDead).toHaveBeenCalledWith('poison', 'lock-1', expect.any(Number))
      expect(repository.markPublished).toHaveBeenCalledWith('healthy', 'lock-1', expect.any(Number))
      expect(repository.releaseForRetry).not.toHaveBeenCalled()
    })

    it('honours a custom cap and classifies non-Error rejections safely in the dead log', async () => {
      const repository = createOutboxRepository()
      repository.claimNext
        .mockResolvedValueOnce(claimedEvent(2, 'retry-me'))
        .mockResolvedValueOnce(claimedEvent(3, 'give-up'))
        .mockResolvedValue(null)
      const publisher: jest.Mocked<DomainEventPublisherInterface> = { publish: jest.fn().mockRejectedValue('nope') }
      const logger = { error: jest.fn() } as unknown as Logger
      const dispatcher = new SyncCommandOutboxDispatcher(repository, publisher, logger, 1_000, 30_000, 3)

      await expect(dispatcher.dispatchAvailable()).resolves.toBe(0)

      expect(repository.releaseForRetry).toHaveBeenCalledWith('retry-me', 'lock-1', expect.any(Number))
      expect(repository.markDead).toHaveBeenCalledWith('give-up', 'lock-1', expect.any(Number))
      expect(logger.error).toHaveBeenLastCalledWith(
        'Sync command outbox event exhausted its delivery attempts and was marked dead.',
        expect.objectContaining({ outboxEventId: 'give-up', attempts: 3, maxAttempts: 3, errorType: 'Error' }),
      )
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('nope')
    })
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
