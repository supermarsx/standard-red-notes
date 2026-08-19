import { createHash } from 'node:crypto'
import {
  InviteEventReplay,
  InviteEventStore,
  InviteEventStoreError,
  isInviteEventUserUuid,
} from './inviteEventStore.js'

const DEFAULT_CHANNEL_PREFIX = 'ws:invite-events:available:v1:'
const AVAILABILITY_MESSAGE = 'available'

export interface InviteEventAvailabilityBus {
  readonly distribution: 'process' | 'shared'
  ready(): boolean
  publishAvailability(userUuid: string): Promise<void>
  subscribeAvailability(userUuid: string, onAvailable: () => void): () => void
}

export interface RedisInviteEventPublisher {
  readonly status: string
  publish(channel: string, message: string): Promise<number>
}

export interface RedisInviteEventSubscriber {
  readonly status: string
  subscribe(channel: string): Promise<unknown>
  unsubscribe(channel: string): Promise<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
  off(event: 'message', listener: (channel: string, message: string) => void): unknown
}

type ChannelSubscription = {
  readonly listeners: Set<() => void>
  subscribePromise: Promise<void>
  subscribed: boolean
}

/**
 * Fleet-wide metadata-only wakeups. Channels contain only a SHA-256 account
 * subject and messages contain no cursor or domain data; the durable stream is
 * always reread after a wakeup.
 */
export class RedisInviteEventAvailabilityBus implements InviteEventAvailabilityBus {
  readonly distribution = 'shared' as const
  private readonly subscriptions = new Map<string, ChannelSubscription>()
  private readonly channelPrefix: string
  private failed = false
  private closed = false

  private readonly handleMessage = (channel: string, message: string): void => {
    if (message !== AVAILABILITY_MESSAGE) {
      return
    }
    const subscription = this.subscriptions.get(channel)
    if (!subscription?.subscribed) {
      return
    }
    notifyListeners(subscription.listeners)
  }

  constructor(
    private readonly publisher: RedisInviteEventPublisher,
    private readonly subscriber: RedisInviteEventSubscriber,
    options: { channelPrefix?: string } = {},
  ) {
    this.channelPrefix = options.channelPrefix ?? DEFAULT_CHANNEL_PREFIX
    if (!/^[a-z0-9:_-]{1,128}$/iu.test(this.channelPrefix)) {
      throw new Error('Invite availability channel prefix is invalid.')
    }
    this.subscriber.on('message', this.handleMessage)
  }

  ready(): boolean {
    return !this.closed && !this.failed && this.publisher.status === 'ready' && this.subscriber.status === 'ready'
  }

  async publishAvailability(userUuid: string): Promise<void> {
    this.assertReady()
    const subscribers = await this.publisher.publish(this.channel(userUuid), AVAILABILITY_MESSAGE)
    if (!Number.isSafeInteger(subscribers) || subscribers < 0) {
      this.failed = true
      throw unavailable('Invite availability publish result is malformed.')
    }
  }

  subscribeAvailability(userUuid: string, onAvailable: () => void): () => void {
    this.assertReady()
    if (typeof onAvailable !== 'function') {
      throw new Error('Invite availability listener is invalid.')
    }
    const channel = this.channel(userUuid)
    let subscription = this.subscriptions.get(channel)
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        subscribePromise: Promise.resolve(),
        subscribed: false,
      }
      this.subscriptions.set(channel, subscription)
      subscription.subscribePromise = this.subscribeChannel(channel, subscription)
    }
    subscription.listeners.add(onAvailable)

    let active = true
    return () => {
      if (!active) {
        return
      }
      active = false
      subscription?.listeners.delete(onAvailable)
      if (subscription && subscription.listeners.size === 0 && this.subscriptions.get(channel) === subscription) {
        this.subscriptions.delete(channel)
        void subscription.subscribePromise.then(
          () =>
            this.subscriber.unsubscribe(channel).then(
              () => undefined,
              () => undefined,
            ),
          () => undefined,
        )
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.subscriber.off('message', this.handleMessage)
    const subscriptions = [...this.subscriptions.entries()]
    this.subscriptions.clear()
    await Promise.all(
      subscriptions.map(([channel, subscription]) =>
        subscription.subscribePromise.then(
          () =>
            this.subscriber.unsubscribe(channel).then(
              () => undefined,
              () => undefined,
            ),
          () => undefined,
        ),
      ),
    )
  }

  private async subscribeChannel(channel: string, subscription: ChannelSubscription): Promise<void> {
    try {
      await this.subscriber.subscribe(channel)
    } catch (error) {
      this.failed = true
      if (this.subscriptions.get(channel) === subscription) {
        notifyListeners(subscription.listeners)
      }
      throw unavailable('Could not subscribe to invite availability.', error)
    }
    if (this.subscriptions.get(channel) !== subscription || this.closed) {
      return
    }
    subscription.subscribed = true
    // Closes the subscribe-before-first-read race in the command handler: one
    // reread happens only after Redis confirms this replica is listening.
    notifyListeners(subscription.listeners)
  }

  private channel(userUuid: string): string {
    if (!isInviteEventUserUuid(userUuid)) {
      throw unavailable('Invite availability account subject is invalid.')
    }
    return `${this.channelPrefix}${createHash('sha256').update(userUuid, 'utf8').digest('hex')}`
  }

  private assertReady(): void {
    if (!this.ready()) {
      throw unavailable('Shared invite availability is not ready.')
    }
  }
}

/**
 * Structural `SyncInviteEventsAdapter` implementation for production gateway
 * composition. Both persistence and wakeups must be fleet-shared.
 */
export class SharedInviteEventsAdapter {
  readonly distribution = 'shared' as const

  constructor(
    private readonly store: InviteEventStore,
    private readonly availability: InviteEventAvailabilityBus,
  ) {
    if (store.distribution !== 'shared' || availability.distribution !== 'shared') {
      throw new Error('Production invite events require shared persistence and availability.')
    }
  }

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

function notifyListeners(listeners: ReadonlySet<() => void>): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One session cannot suppress wakeups for other sessions on the account.
    }
  }
}

function aborted(): Error {
  const error = new Error('Invite event operation was aborted.')
  error.name = 'AbortError'
  return error
}

function unavailable(message: string, cause?: unknown): InviteEventStoreError {
  return new InviteEventStoreError('INVITE_STORE_UNAVAILABLE', message, cause === undefined ? undefined : { cause })
}
