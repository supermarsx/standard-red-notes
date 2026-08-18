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
})
