import {
  DomainEventPublisherInterface,
  InviteRealtimeInvalidationRequestedEvent,
} from '@standardnotes/domain-events'

import { InviteEventOutboxDispatcher } from './InviteEventOutboxDispatcher'
import { InviteEventOutboxRepositoryInterface } from './InviteEventOutboxRepositoryInterface'

describe('InviteEventOutboxDispatcher lifecycle', () => {
  let repository: jest.Mocked<InviteEventOutboxRepositoryInterface>
  let publisher: DomainEventPublisherInterface

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
