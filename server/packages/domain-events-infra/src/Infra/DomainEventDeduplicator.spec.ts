import { DomainEventInterface } from '@standardnotes/domain-events'

import { DomainEventDeduplicator } from './DomainEventDeduplicator'

const event = (eventId?: string): DomainEventInterface => ({ eventId, type: 'TEST' }) as unknown as DomainEventInterface

describe('DomainEventDeduplicator', () => {
  it('joins concurrent deliveries and skips a completed redelivery', async () => {
    let release!: () => void
    const operation = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const deduplicator = new DomainEventDeduplicator()

    const first = deduplicator.handle(event('event-1'), operation)
    const concurrent = deduplicator.handle(event('event-1'), operation)
    await Promise.resolve()
    expect(operation).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, concurrent])
    await deduplicator.handle(event('event-1'), operation)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('does not mark a failed delivery complete', async () => {
    const operation = jest.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined)
    const deduplicator = new DomainEventDeduplicator()

    await expect(deduplicator.handle(event('event-1'), operation)).rejects.toThrow('failed')
    await deduplicator.handle(event('event-1'), operation)

    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('does not deduplicate legacy events without an event id', async () => {
    const operation = jest.fn().mockResolvedValue(undefined)
    const deduplicator = new DomainEventDeduplicator()

    await deduplicator.handle(event(), operation)
    await deduplicator.handle(event(), operation)

    expect(operation).toHaveBeenCalledTimes(2)
  })

  /**
   * The suppression window is deliberately bounded — this is a redelivery
   * smoother, not a durable exactly-once store. These cover the two ways an
   * entry leaves it, both of which restore at-least-once delivery rather than
   * silently dropping an event forever.
   */
  describe('bounded retention', () => {
    it('suppresses a redelivery inside the retention window and stops once it lapses', async () => {
      const operation = jest.fn().mockResolvedValue(undefined)
      let clock = 1_000
      const deduplicator = new DomainEventDeduplicator(10_000, 10_000, () => clock)

      await deduplicator.handle(event('event-1'), operation)

      // Still inside the window: the redelivery is absorbed.
      clock += 10_000
      await deduplicator.handle(event('event-1'), operation)
      expect(operation).toHaveBeenCalledTimes(1)

      // One millisecond past it, the safeguard lets the event through again
      // rather than suppressing it for the life of the process.
      clock += 1
      await deduplicator.handle(event('event-1'), operation)
      expect(operation).toHaveBeenCalledTimes(2)
    })

    it('evicts the oldest completions once the entry cap is reached', async () => {
      const operation = jest.fn().mockResolvedValue(undefined)
      const deduplicator = new DomainEventDeduplicator(10 * 60 * 1_000, 2, () => 1_000)

      await deduplicator.handle(event('event-1'), operation)
      await deduplicator.handle(event('event-2'), operation)
      await deduplicator.handle(event('event-3'), operation)
      expect(operation).toHaveBeenCalledTimes(3)

      // event-1 was pushed out to make room, so it is no longer suppressed.
      await deduplicator.handle(event('event-1'), operation)
      expect(operation).toHaveBeenCalledTimes(4)

      // The newest two are still remembered.
      await deduplicator.handle(event('event-3'), operation)
      expect(operation).toHaveBeenCalledTimes(4)
    })

    it('terminates instead of spinning when configured with a nonsensical capacity', async () => {
      // A negative cap makes `size > max` true even when the map is empty. Without
      // the empty-key guard this loop would never exit and would hang the consumer.
      const operation = jest.fn().mockResolvedValue(undefined)
      const deduplicator = new DomainEventDeduplicator(10 * 60 * 1_000, -1, () => 1_000)

      await deduplicator.handle(event('event-1'), operation)

      expect(operation).toHaveBeenCalledTimes(1)
      // Nothing was retained, so the next delivery runs again.
      await deduplicator.handle(event('event-1'), operation)
      expect(operation).toHaveBeenCalledTimes(2)
    })
  })
})
