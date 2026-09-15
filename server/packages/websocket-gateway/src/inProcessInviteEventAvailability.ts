import type { InviteEventAvailabilityBus } from './inviteEventAvailability.js'
import {
  InviteEventStoreError,
  isInviteEventUserUuid,
  type InviteEventReplay,
  type InviteEventStore,
} from './inviteEventStore.js'
import { InviteEventOutboxDispatcher, InviteLifecycleEventProducer } from './inviteEventOutbox.js'

// ---------------------------------------------------------------------------
// Single-process invite availability.
//
// The Redis bus exists to wake sessions held by OTHER replicas: it carries no
// cursor and no domain data, only "account X has something new", and the
// durable stream is reread afterwards either way. With one gateway process the
// waiter is already here, so the wakeup is a function call.
//
// `distribution` stays `'process'`, which is the honest answer and also what
// keeps `requireSharedState` composition refusing it: a fleet MUST use the
// Redis bus, and the gateway enforces that rather than trusting the caller.
// ---------------------------------------------------------------------------

export class InProcessInviteEventAvailabilityBus implements InviteEventAvailabilityBus {
  readonly distribution = 'process' as const
  private readonly listenersByUser = new Map<string, Set<() => void>>()
  private closed = false

  ready(): boolean {
    return !this.closed
  }

  async publishAvailability(userUuid: string): Promise<void> {
    this.assertUsable()
    const listeners = this.listenersByUser.get(this.subject(userUuid))
    if (!listeners) {
      return
    }
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // One session cannot suppress wakeups for other sessions on the account.
      }
    }
  }

  subscribeAvailability(userUuid: string, onAvailable: () => void): () => void {
    this.assertUsable()
    if (typeof onAvailable !== 'function') {
      throw new Error('Invite availability listener is invalid.')
    }
    const subject = this.subject(userUuid)
    const listeners = this.listenersByUser.get(subject) ?? new Set<() => void>()
    listeners.add(onAvailable)
    this.listenersByUser.set(subject, listeners)

    let active = true
    // The Redis bus notifies once the SUBSCRIBE is confirmed, which closes the
    // subscribe-before-first-read race in the command handler. The subscription
    // is already live here, so the same single wakeup is delivered on the next
    // microtask -- never synchronously, so the caller holds its unsubscribe
    // handle before its listener can run, exactly as on the Redis path.
    queueMicrotask(() => {
      if (!active || this.closed) {
        return
      }
      try {
        onAvailable()
      } catch {
        // A throwing listener must not affect its own registration.
      }
    })

    return () => {
      if (!active) {
        return
      }
      active = false
      const current = this.listenersByUser.get(subject)
      current?.delete(onAvailable)
      if (current && current.size === 0) {
        this.listenersByUser.delete(subject)
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.listenersByUser.clear()
  }

  private subject(userUuid: string): string {
    if (!isInviteEventUserUuid(userUuid)) {
      throw new InviteEventStoreError('INVITE_STORE_UNAVAILABLE', 'Invite availability account subject is invalid.')
    }
    return userUuid
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new InviteEventStoreError('INVITE_STORE_UNAVAILABLE', 'In-process invite availability is closed.')
    }
  }
}

/**
 * The `SyncInviteEventsAdapter` for a single-process deployment. Deliberately a
 * sibling of `SharedInviteEventsAdapter` rather than a relaxation of it: that
 * one asserts fleet-shared persistence and wakeups, and must keep doing so.
 */
export class InProcessInviteEventsAdapter {
  readonly distribution = 'process' as const

  constructor(
    private readonly store: InviteEventStore,
    private readonly availability: InviteEventAvailabilityBus,
  ) {}

  ready(): boolean {
    return this.store.ready() && this.availability.ready()
  }

  tail(userUuid: string, signal: AbortSignal): Promise<string> {
    return withAbort(this.store.tail(userUuid), signal)
  }

  readAfter(userUuid: string, cursor: string, limit: number, signal: AbortSignal): Promise<InviteEventReplay> {
    return withAbort(this.store.readAfter(userUuid, cursor, limit), signal)
  }

  subscribeAvailability(userUuid: string, onAvailable: () => void): () => void {
    return this.availability.subscribeAvailability(userUuid, onAvailable)
  }
}

export type InProcessInviteEventComposition = {
  /** Pass directly as the gateway command handler's `inviteEvents` adapter. */
  gatewayAdapter: InProcessInviteEventsAdapter
  /** Use only with the mutation-scoped transactional outbox interface. */
  producer: InviteLifecycleEventProducer
  /** Invoke from the outbox worker before marking its record delivered. */
  dispatcher: InviteEventOutboxDispatcher
}

/** The single-process counterpart of `createSharedInviteEventComposition`. */
export function createInProcessInviteEventComposition(input: {
  store: InviteEventStore
  availability: InviteEventAvailabilityBus
  clock?: () => number
}): InProcessInviteEventComposition {
  return {
    gatewayAdapter: new InProcessInviteEventsAdapter(input.store, input.availability),
    producer: new InviteLifecycleEventProducer(input.clock),
    dispatcher: new InviteEventOutboxDispatcher(input.store, input.availability),
  }
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw aborted()
  }
  let removeAbortListener = (): void => undefined
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const handleAbort = (): void => reject(aborted())
    signal.addEventListener('abort', handleAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', handleAbort)
  })
  try {
    return await Promise.race([operation, abortPromise])
  } finally {
    removeAbortListener()
  }
}

function aborted(): Error {
  const error = new Error('Invite event operation was aborted.')
  error.name = 'AbortError'
  return error
}
