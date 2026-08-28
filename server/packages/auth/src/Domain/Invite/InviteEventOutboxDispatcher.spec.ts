import { DomainEventPublisherInterface, InviteRealtimeInvalidationRequestedEvent } from '@standardnotes/domain-events'

import { InviteEventOutboxDispatcher } from './InviteEventOutboxDispatcher'
import { InviteEventOutboxRepositoryInterface } from './InviteEventOutboxRepositoryInterface'

describe('InviteEventOutboxDispatcher lifecycle', () => {
  let repository: jest.Mocked<InviteEventOutboxRepositoryInterface>
  let publisher: DomainEventPublisherInterface
  let logger: { error: jest.Mock; warn: jest.Mock; info: jest.Mock; debug: jest.Mock }

  const claimed = (uuid: string) => ({
    uuid,
    lockToken: 'lock',
    attempts: 1,
    event: {
      type: 'INVITE_REALTIME_INVALIDATION_REQUESTED',
      createdAt: new Date(),
      meta: {},
    } as unknown as InviteRealtimeInvalidationRequestedEvent,
  })

  beforeEach(() => {
    jest.useFakeTimers()
    repository = {
      enqueue: jest.fn(),
      claimNext: jest.fn().mockResolvedValue(null),
      markPublished: jest.fn(),
      markFailed: jest.fn(),
      releaseForRetry: jest.fn(),
      requeueFailed: jest.fn(),
      deletePublishedBefore: jest.fn(),
    } as unknown as jest.Mocked<InviteEventOutboxRepositoryInterface>
    publisher = { publish: jest.fn() }
    logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const flush = async (): Promise<void> => {
    for (let index = 0; index < 10; index++) {
      await Promise.resolve()
    }
  }

  it('leaves no pending timer after start then stop', async () => {
    const dispatcher = new InviteEventOutboxDispatcher(repository, publisher)

    dispatcher.start(50)
    expect(jest.getTimerCount()).toBe(1)

    jest.advanceTimersByTime(0)
    await flush()
    expect(jest.getTimerCount()).toBe(1)

    await dispatcher.stop()

    expect(jest.getTimerCount()).toBe(0)
    await flush()
    jest.advanceTimersByTime(10_000)
    await flush()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('does not re-arm the maintenance timer when a drain settles after stop', async () => {
    let releaseClaim: (() => void) | undefined
    repository.claimNext
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseClaim = () => resolve(claimed('first'))
          }),
      )
      .mockResolvedValue(null)

    const dispatcher = new InviteEventOutboxDispatcher(repository, publisher)
    dispatcher.start(50)
    jest.advanceTimersByTime(0)
    await flush()

    // Drain is parked inside claimNext, so stop() must wait for it rather than
    // clearing a timer that the in-flight pass is about to replace.
    const stopped = dispatcher.stop()
    expect(jest.getTimerCount()).toBe(0)

    releaseClaim?.()
    await stopped

    expect(publisher.publish).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(10_000)
    await flush()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('awaits the in-flight publish before stop() resolves', async () => {
    let releasePublish: (() => void) | undefined
    repository.claimNext.mockResolvedValueOnce(claimed('first')).mockResolvedValue(null)
    publisher.publish = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePublish = resolve
        }),
    )

    const dispatcher = new InviteEventOutboxDispatcher(repository, publisher)
    dispatcher.start(50)
    jest.advanceTimersByTime(0)
    await flush()

    let resolved = false
    const stopped = dispatcher.stop().then(() => {
      resolved = true
    })
    await flush()
    expect(resolved).toBe(false)
    expect(repository.markPublished).not.toHaveBeenCalled()

    releasePublish?.()
    await stopped

    expect(resolved).toBe(true)
    expect(repository.markPublished).toHaveBeenCalledTimes(1)
  })

  // A container-load `start()` must not be a reason the process stays up. Every
  // armed handle is unref-ed, so the event loop drains on its own and `stop()` is
  // about not writing through a torn-down connection, not about letting Node exit.
  it('arms only unref-ed timers, so a started dispatcher never holds the event loop open', async () => {
    jest.useRealTimers()
    const handles: NodeJS.Timeout[] = []
    const realSetTimeout = global.setTimeout
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      const handle = realSetTimeout(callback, delay)
      handles.push(handle)
      return handle
    }) as unknown as typeof global.setTimeout)

    const dispatcher = new InviteEventOutboxDispatcher(repository, publisher)
    dispatcher.start(5)
    await new Promise((resolve) => realSetTimeout(resolve, 30))
    await dispatcher.stop()
    spy.mockRestore()

    expect(handles.length).toBeGreaterThan(1)
    expect(handles.filter((handle) => handle.hasRef())).toEqual([])
  })

  // A dropped table or a MySQL blip used to reject drain(), and dispatch()'s bare
  // `void drained.finally(...)` let that reach the process-level unhandledRejection
  // handler in bin/server.ts, which exits(1). Re-armed every second, one transient
  // fault crash-looped a healthy auth process.
  describe('repository failures', () => {
    const dispatcherWithLogger = (options: Record<string, unknown> = {}) =>
      new InviteEventOutboxDispatcher(repository, publisher, {
        logger: logger as unknown as never,
        ...options,
      })

    it('does not produce an unhandled rejection when the repository throws in the poller', async () => {
      jest.useRealTimers()
      const unhandled: unknown[] = []
      const captureUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      // Jest installs its own handler; capture directly so a real rejection is visible.
      process.on('unhandledRejection', captureUnhandled)
      repository.claimNext.mockRejectedValue(new Error('no such table: invite_event_outbox'))

      const dispatcher = dispatcherWithLogger()
      dispatcher.start(5)
      await new Promise((resolve) => setTimeout(resolve, 60))
      await dispatcher.stop()
      process.off('unhandledRejection', captureUnhandled)

      expect(unhandled).toEqual([])
      expect(logger.error).toHaveBeenCalled()
      expect(logger.error.mock.calls[0][0]).toContain('Invite event outbox dispatch pass failed')
    })

    it('logs and ends the pass instead of rejecting when claimNext fails', async () => {
      repository.claimNext.mockRejectedValueOnce(new Error('lock wait timeout'))
      const dispatcher = dispatcherWithLogger()

      await expect(dispatcher.drain()).resolves.toEqual({ published: 0, failed: 0, retried: 0 })
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    // markPublished sits inside the publish try/catch, so its failure is already
    // absorbed as a publish failure and the record is released for retry. The calls
    // that genuinely escaped are claimNext and the release/fail bookkeeping itself.
    it('treats a markPublished failure as a publish failure and releases for retry', async () => {
      repository.claimNext.mockResolvedValueOnce(claimed('first')).mockResolvedValue(null)
      repository.markPublished.mockRejectedValueOnce(new Error('connection reset'))
      const dispatcher = dispatcherWithLogger()

      await expect(dispatcher.drain()).resolves.toEqual({ published: 0, failed: 0, retried: 1 })
      expect(publisher.publish).toHaveBeenCalledTimes(1)
      expect(repository.releaseForRetry).toHaveBeenCalledTimes(1)
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('logs and ends the pass when the retry bookkeeping itself fails', async () => {
      repository.claimNext.mockResolvedValueOnce(claimed('first')).mockResolvedValue(null)
      publisher.publish = jest.fn().mockRejectedValue(new Error('broker unavailable'))
      repository.releaseForRetry.mockRejectedValueOnce(new Error('deadlock found when trying to get lock'))
      const dispatcher = dispatcherWithLogger()

      await expect(dispatcher.drain()).resolves.toEqual({ published: 0, failed: 0, retried: 0 })
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('marks a record failed once it has exhausted its attempts', async () => {
      repository.claimNext.mockResolvedValueOnce({ ...claimed('exhausted'), attempts: 8 }).mockResolvedValue(null)
      publisher.publish = jest.fn().mockRejectedValue(new Error('broker unavailable'))
      const dispatcher = dispatcherWithLogger({ maximumAttempts: 8 })

      await expect(dispatcher.drain()).resolves.toEqual({ published: 0, failed: 1, retried: 0 })
      expect(repository.markFailed).toHaveBeenCalledWith('exhausted', 'lock', 'ERROR', expect.any(Number))
      expect(repository.releaseForRetry).not.toHaveBeenCalled()
    })

    it('does not log or count a publish failure as a repository failure', async () => {
      repository.claimNext.mockResolvedValueOnce(claimed('first')).mockResolvedValue(null)
      publisher.publish = jest.fn().mockRejectedValue(new Error('broker unavailable'))
      const dispatcher = dispatcherWithLogger()

      await expect(dispatcher.drain()).resolves.toEqual({ published: 0, failed: 0, retried: 1 })
      expect(repository.releaseForRetry).toHaveBeenCalledTimes(1)
      expect(logger.error).not.toHaveBeenCalled()
    })

    // Worker-mode corollary: Container.ts builds the data source with
    // `runMigrations: this.mode === 'server'` but gates the dispatcher only on
    // `mode !== 'cli'`, so a worker started before the server has migrated polls an
    // absent table. It must ride that out and pick up once migrations land, rather
    // than exiting and crash-looping.
    it('survives an un-migrated schema and recovers once the table appears', async () => {
      const missingTable = new Error('SQLITE_ERROR: no such table: invite_event_outbox')
      repository.claimNext.mockRejectedValue(missingTable)
      const dispatcher = dispatcherWithLogger({ pollBackoffMaximumMilliseconds: 200 })

      dispatcher.start(50)
      jest.advanceTimersByTime(0)
      await flush()
      jest.advanceTimersByTime(1_000)
      await flush()

      expect(logger.error).toHaveBeenCalled()
      expect(repository.claimNext.mock.calls.length).toBeGreaterThan(1)

      // Migrations land: the table exists and a record is waiting.
      repository.claimNext.mockResolvedValueOnce(claimed('after-migration')).mockResolvedValue(null)
      jest.advanceTimersByTime(200)
      await flush()

      expect(publisher.publish).toHaveBeenCalledTimes(1)
      expect(repository.markPublished).toHaveBeenCalledTimes(1)

      await dispatcher.stop()
    })

    // drain() absorbs repository faults itself, so this only fires when the error
    // handling raises — a logger transport that is down, say. It still has to hold:
    // an escape here reaches process-level unhandledRejection and exits the server.
    it('survives a logger that throws while reporting a repository failure', async () => {
      jest.useRealTimers()
      const unhandled: unknown[] = []
      const captureUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', captureUnhandled)
      repository.claimNext.mockRejectedValue(new Error('lock wait timeout'))
      logger.error.mockImplementation(() => {
        throw new Error('logger transport unavailable')
      })

      const dispatcher = dispatcherWithLogger()
      dispatcher.start(5)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await dispatcher.stop()
      process.off('unhandledRejection', captureUnhandled)

      expect(unhandled).toEqual([])
      expect(logger.error).toHaveBeenCalled()
    })

    // drain() is written so that it cannot reject, so nothing reaches dispatch()'s
    // catch today. It is kept as the containment boundary: this exact escape is what
    // exited the process before, and a future edit to drain() must not be able to
    // reintroduce it. The test pins that contract through drain()'s public seam
    // rather than pretending some caller drives it.
    it('contains a rejecting drain instead of letting it reach the process', async () => {
      jest.useRealTimers()
      const unhandled: unknown[] = []
      const captureUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', captureUnhandled)

      const dispatcher = dispatcherWithLogger()
      jest.spyOn(dispatcher, 'drain').mockRejectedValue(new Error('drain contract broken'))
      dispatcher.start(5)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await dispatcher.stop()
      process.off('unhandledRejection', captureUnhandled)

      expect(unhandled).toEqual([])
      expect(logger.error).toHaveBeenCalledWith(
        'Invite event outbox dispatcher failed unexpectedly.',
        expect.anything(),
      )
    })

    it('backs off exponentially while failing and returns to cadence once healthy', async () => {
      repository.claimNext.mockRejectedValue(new Error('down'))
      const dispatcher = dispatcherWithLogger({ pollBackoffMaximumMilliseconds: 400 })

      dispatcher.start(50)
      jest.advanceTimersByTime(0)
      await flush()
      // Failure 1 -> 100ms, failure 2 -> 200ms, then capped at 400ms.
      const expectedDelays = [100, 200, 400, 400]
      for (let step = 0; step < expectedDelays.length; step++) {
        expect(jest.getTimerCount()).toBe(1)
        jest.advanceTimersByTime(expectedDelays[step] - 1)
        await flush()
        // Still parked one tick short of the backoff: no new poll yet.
        expect(repository.claimNext).toHaveBeenCalledTimes(step + 1)
        jest.advanceTimersByTime(1)
        await flush()
        expect(repository.claimNext).toHaveBeenCalledTimes(step + 2)
      }

      repository.claimNext.mockResolvedValue(null)
      jest.advanceTimersByTime(400)
      await flush()
      // A clean pass clears the backoff, so the next poll is back on cadence.
      jest.advanceTimersByTime(49)
      await flush()
      const beforeCadence = repository.claimNext.mock.calls.length
      jest.advanceTimersByTime(1)
      await flush()
      expect(repository.claimNext.mock.calls.length).toBe(beforeCadence + 1)

      await dispatcher.stop()
    })
  })

  it('refuses to run a second concurrent drain', async () => {
    let releaseClaim: (() => void) | undefined
    repository.claimNext
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseClaim = () => resolve(null)
          }),
      )
      .mockResolvedValue(null)

    const dispatcher = new InviteEventOutboxDispatcher(repository, publisher)
    const first = dispatcher.drain()
    await flush()

    // The re-entrancy guard keeps a wake() during an active pass from
    // double-claiming: the second call returns empty totals immediately.
    await expect(dispatcher.drain()).resolves.toEqual({ published: 0, failed: 0, retried: 0 })
    expect(repository.claimNext).toHaveBeenCalledTimes(1)

    releaseClaim?.()
    await first
  })

  it('redacts a non-Error rejection to UNKNOWN_ERROR', async () => {
    repository.claimNext.mockResolvedValueOnce(claimed('first')).mockResolvedValue(null)
    publisher.publish = jest.fn().mockRejectedValue('a bare string carrying secret@example.com')

    const dispatcher = new InviteEventOutboxDispatcher(repository, publisher)
    await expect(dispatcher.drain()).resolves.toEqual({ published: 0, failed: 0, retried: 1 })

    expect(repository.releaseForRetry).toHaveBeenCalledWith(
      'first',
      'lock',
      expect.any(Number),
      'UNKNOWN_ERROR',
      expect.any(Number),
    )
  })

  it('ignores wake() after stop but resumes on a fresh start', async () => {
    const dispatcher = new InviteEventOutboxDispatcher(repository, publisher)

    dispatcher.start(50)
    await dispatcher.stop()

    dispatcher.wake()
    expect(jest.getTimerCount()).toBe(0)

    dispatcher.start(50)
    expect(jest.getTimerCount()).toBe(1)
    await dispatcher.stop()
    expect(jest.getTimerCount()).toBe(0)
  })
})
