import { createHash } from 'node:crypto'
import {
  InviteEventReplay,
  InviteEventStore,
  InviteEventStoreError,
  isInviteEventUserUuid,
  namespacedInviteEventPrefix,
} from './inviteEventStore.js'

const DEFAULT_CHANNEL_PREFIX = 'ws:invite-events:available:v1:'
const AVAILABILITY_MESSAGE = 'available'
/**
 * How long one rejected SUBSCRIBE or malformed PUBLISH keeps `ready()` false
 * when no later round trip has proven the bus usable again. Bounds the time a
 * Redis blip can hold the invite lane closed on a replica that sees no invite
 * traffic; a persistent failure is re-observed by the next attempt.
 */
export const INVITE_AVAILABILITY_FAILURE_COOLDOWN_MS = 5_000

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

export type RedisInviteEventAvailabilityBusOptions = {
  /** Base channel prefix; defaults to the fleet-wide constant. */
  channelPrefix?: string
  /** Per-deployment namespace (`WEBSOCKET_REDIS_NAMESPACE`), prepended as `<namespace>:`; empty keeps the current names. */
  namespace?: string
  clock?: () => number
}

type ChannelSubscription = {
  readonly listeners: Set<() => void>
  /**
   * The latest SUBSCRIBE attempt. Resolves `true` once Redis confirmed the
   * subscription (an UNSUBSCRIBE is then owed) and `false` when it was
   * rejected. It never rejects: a rejected SUBSCRIBE used to surface as an
   * unhandled promise rejection, which api-gateway turns into `process.exit(1)`.
   */
  subscribePromise: Promise<boolean>
  subscribed: boolean
  attempting: boolean
}

/** Channel prefix for a deployment namespace; `undefined` or empty keeps the current channel names. */
export function inviteAvailabilityChannelPrefix(namespace?: string): string {
  return namespacedInviteEventPrefix(DEFAULT_CHANNEL_PREFIX, namespace)
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
  private readonly clock: () => number
  private failedAt: number | undefined
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
    options: RedisInviteEventAvailabilityBusOptions = {},
  ) {
    this.channelPrefix = namespacedInviteEventPrefix(options.channelPrefix ?? DEFAULT_CHANNEL_PREFIX, options.namespace)
    if (!/^[a-z0-9:_-]{1,128}$/iu.test(this.channelPrefix)) {
      throw new Error('Invite availability channel prefix is invalid.')
    }
    this.clock = options.clock ?? Date.now
    this.subscriber.on('message', this.handleMessage)
  }

  ready(): boolean {
    return this.usable() && !this.failedRecently()
  }

  async publishAvailability(userUuid: string): Promise<void> {
    this.assertUsable()
    const subscribers = await this.publisher.publish(this.channel(userUuid), AVAILABILITY_MESSAGE)
    if (!Number.isSafeInteger(subscribers) || subscribers < 0) {
      this.markFailed()
      throw unavailable('Invite availability publish result is malformed.')
    }
    // A well-formed round trip proves the bus usable again after an earlier
    // rejected SUBSCRIBE or malformed PUBLISH: the latch never outlives success.
    this.failedAt = undefined
  }

  subscribeAvailability(userUuid: string, onAvailable: () => void): () => void {
    this.assertUsable()
    if (typeof onAvailable !== 'function') {
      throw new Error('Invite availability listener is invalid.')
    }
    const channel = this.channel(userUuid)
    let subscription = this.subscriptions.get(channel)
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        subscribePromise: Promise.resolve(false),
        subscribed: false,
        attempting: false,
      }
      this.subscriptions.set(channel, subscription)
      subscription.subscribePromise = this.subscribeChannel(channel, subscription)
    } else if (!subscription.subscribed && !subscription.attempting) {
      // The earlier SUBSCRIBE for this account was rejected; the next session
      // to subscribe re-issues it on behalf of every listener still waiting.
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
        void this.releaseChannel(channel, subscription)
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
    await Promise.all(subscriptions.map(([channel, subscription]) => this.releaseChannel(channel, subscription)))
  }

  private async subscribeChannel(channel: string, subscription: ChannelSubscription): Promise<boolean> {
    subscription.attempting = true
    let confirmed = false
    try {
      await this.subscriber.subscribe(channel)
      confirmed = true
    } catch {
      // Recorded below; the attempt promise itself must never reject.
    }
    subscription.attempting = false
    if (!confirmed) {
      this.markFailed()
      if (this.subscriptions.get(channel) === subscription) {
        notifyListeners(subscription.listeners)
      }
      return false
    }
    this.failedAt = undefined
    if (this.subscriptions.get(channel) !== subscription || this.closed) {
      return true
    }
    subscription.subscribed = true
    // Closes the subscribe-before-first-read race in the command handler: one
    // reread happens only after Redis confirms this replica is listening.
    notifyListeners(subscription.listeners)
    return true
  }

  private async releaseChannel(channel: string, subscription: ChannelSubscription): Promise<void> {
    const confirmed = await subscription.subscribePromise
    if (!confirmed) {
      return
    }
    try {
      await this.subscriber.unsubscribe(channel)
    } catch {
      // A failed UNSUBSCRIBE on a disposed or closing channel is not actionable.
    }
  }

  private channel(userUuid: string): string {
    if (!isInviteEventUserUuid(userUuid)) {
      throw unavailable('Invite availability account subject is invalid.')
    }
    return `${this.channelPrefix}${createHash('sha256').update(userUuid, 'utf8').digest('hex')}`
  }

  private usable(): boolean {
    return !this.closed && this.publisher.status === 'ready' && this.subscriber.status === 'ready'
  }

  private failedRecently(): boolean {
    return this.failedAt !== undefined && this.clock() - this.failedAt < INVITE_AVAILABILITY_FAILURE_COOLDOWN_MS
  }

  private markFailed(): void {
    this.failedAt = this.clock()
  }

  /**
   * Publishing and subscribing stay permitted while the failure latch is set:
   * they are the only operations that can prove the bus usable and clear it.
   */
  private assertUsable(): void {
    if (!this.usable()) {
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
