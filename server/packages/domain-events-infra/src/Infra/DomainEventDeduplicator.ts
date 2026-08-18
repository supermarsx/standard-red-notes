import { DomainEventInterface } from '@standardnotes/domain-events'

/**
 * Suppresses immediate broker redelivery after a handler completed but before
 * the transport acknowledgement became durable. This is intentionally a
 * bounded, process-local safeguard: durable transports remain at-least-once
 * across process restarts and consumers must still make external side effects
 * idempotent when they need stronger guarantees.
 */
export class DomainEventDeduplicator {
  private readonly completed = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly retentionMilliseconds = 10 * 60 * 1_000,
    private readonly maxCompletedEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(event: DomainEventInterface, operation: () => Promise<void>): Promise<void> {
    if (!event.eventId) {
      await operation()
      return
    }

    this.prune()
    const key = `${event.type}:${event.eventId}`
    if (this.completed.has(key)) {
      return
    }

    const existing = this.inFlight.get(key)
    if (existing) {
      await existing
      return
    }

    const execution = Promise.resolve().then(operation)
    this.inFlight.set(key, execution)

    try {
      await execution
      this.completed.set(key, this.now())
      this.enforceCapacity()
    } finally {
      if (this.inFlight.get(key) === execution) {
        this.inFlight.delete(key)
      }
    }
  }

  private prune(): void {
    const oldestAllowed = this.now() - this.retentionMilliseconds
    for (const [key, completedAt] of this.completed) {
      if (completedAt >= oldestAllowed) {
        continue
      }
      this.completed.delete(key)
    }
  }

  private enforceCapacity(): void {
    while (this.completed.size > this.maxCompletedEntries) {
      const oldestKey = this.completed.keys().next().value as string | undefined
      if (!oldestKey) {
        return
      }
      this.completed.delete(oldestKey)
    }
  }
}
