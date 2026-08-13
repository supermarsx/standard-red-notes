import { randomUUID } from 'crypto'

import {
  hasOnlyKeys,
  isBoundedString,
  isEpochMilliseconds,
  isJsonObject,
  isSafeRecordKey,
  SecureJsonFileStore,
} from '../../Infra/SecureJsonFileStore'
import { isDeliveryChannel, PublishedReminder } from './Types'

/**
 * Standard Red Notes: a per-user, server-READABLE "published reminders" store.
 *
 * WHY THIS EXISTS: notes/reminders are end-to-end encrypted, so the server
 * cannot read them. To DELIVER a due reminder (Telegram / Email / WhatsApp) the
 * server can only act on reminders the user has EXPLICITLY published into THIS
 * store. The data here is plaintext by design and is empty until the user
 * publishes something. This is the exact same model as the CalDAV
 * PublishedCalendarStore.
 *
 * STORAGE: a single JSON file (default empty object). Keeps the feature fully
 * self-contained inside api-gateway, which has no database of its own. The
 * shared secure-file primitive bounds and validates reads, rejects unsafe
 * link/type targets, and serializes durable atomic writes across local store
 * instances.
 */

interface StoredPublishedReminder extends PublishedReminder {
  deliveryClaim?: ReminderDeliveryClaim
}

interface StoreShape {
  // userUuid -> { reminderId -> PublishedReminder }
  [userUuid: string]: { [id: string]: StoredPublishedReminder }
}

export interface DueReminder {
  userUuid: string
  reminder: PublishedReminder
}

export interface ReminderDeliveryClaim {
  id: string
  owner: string
  claimedAt: number
  leaseExpiresAt: number
}

export interface ClaimedReminder extends DueReminder {
  claim: ReminderDeliveryClaim
}

export interface PublishedRemindersStoreOptions {
  clock?: () => number
  randomId?: () => string
  claimLeaseMs?: number
  claimBatchSize?: number
  retryBaseMs?: number
  retryMaxMs?: number
}

export interface PublishReminderOptions {
  /** Keep the receipt/claim when a representation-only edit has the same effective delivery. */
  preserveDeliveryState?: boolean
  /** A durable provider fence permits invalidating an otherwise live claim. */
  allowClaimInvalidation?: boolean
}

export type PublishedReminderRemovalResult = 'removed' | 'not-found' | 'in-flight'

const MAX_USERS = 10_000
const MAX_REMINDERS_PER_USER = 10_000
const MAX_REMINDER_ID_LENGTH = 512
const MAX_MESSAGE_LENGTH = 65_536
const MAX_DESTINATION_LENGTH = 8_192
const MAX_ERROR_LENGTH = 16_384
const MAX_EPOCH_MILLISECONDS = 8_640_000_000_000_000
const MAX_CLAIM_BATCH_SIZE = 500
const MAX_CLAIM_LEASE_MS = 24 * 60 * 60 * 1_000
const MAX_RETRY_DELAY_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_CLAIM_BATCH_SIZE = 100
// Every bundled provider is fenced at 30 seconds. The larger lease also covers
// durable-queue status checks, local store contention, and orderly shutdown.
const DEFAULT_CLAIM_LEASE_MS = 10 * 60 * 1_000
const DEFAULT_RETRY_BASE_MS = 60 * 1_000
const DEFAULT_RETRY_MAX_MS = 6 * 60 * 60 * 1_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_UTC_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:[Zz]|[+-][0-2]\d:[0-5]\d)$/

function isOptionalEpochMilliseconds(value: unknown): value is number | undefined {
  return value === undefined || isEpochMilliseconds(value)
}

function isOptionalAttemptCount(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function isReminderDeliveryClaim(value: unknown): value is ReminderDeliveryClaim {
  return (
    hasOnlyKeys(value, ['id', 'owner', 'claimedAt', 'leaseExpiresAt']) &&
    typeof value.id === 'string' &&
    UUID_PATTERN.test(value.id) &&
    typeof value.owner === 'string' &&
    UUID_PATTERN.test(value.owner) &&
    isEpochMilliseconds(value.claimedAt) &&
    isEpochMilliseconds(value.leaseExpiresAt) &&
    value.leaseExpiresAt > value.claimedAt
  )
}

function isPublishedReminder(value: unknown, id: string): value is StoredPublishedReminder {
  return (
    hasOnlyKeys(value, [
      'id',
      'message',
      'dueAtUtc',
      'deliveryRevision',
      'channel',
      'destination',
      'sent',
      'sentAt',
      'error',
      'attemptCount',
      'lastAttemptAt',
      'nextAttemptAt',
      'deliveryClaim',
      'createdAt',
      'updatedAt',
    ]) &&
    isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH) &&
    value.id === id &&
    isBoundedString(value.message, 0, MAX_MESSAGE_LENGTH) &&
    isBoundedString(value.dueAtUtc, 1, 64) &&
    ISO_UTC_DATE_TIME_PATTERN.test(value.dueAtUtc) &&
    !Number.isNaN(Date.parse(value.dueAtUtc)) &&
    (value.deliveryRevision === undefined ||
      (typeof value.deliveryRevision === 'string' && UUID_PATTERN.test(value.deliveryRevision))) &&
    (value.channel === undefined || isDeliveryChannel(value.channel)) &&
    (value.destination === undefined || isBoundedString(value.destination, 0, MAX_DESTINATION_LENGTH)) &&
    typeof value.sent === 'boolean' &&
    isOptionalEpochMilliseconds(value.sentAt) &&
    (value.error === undefined || isBoundedString(value.error, 0, MAX_ERROR_LENGTH)) &&
    isOptionalAttemptCount(value.attemptCount) &&
    isOptionalEpochMilliseconds(value.lastAttemptAt) &&
    isOptionalEpochMilliseconds(value.nextAttemptAt) &&
    (value.deliveryClaim === undefined || isReminderDeliveryClaim(value.deliveryClaim)) &&
    isEpochMilliseconds(value.createdAt) &&
    isEpochMilliseconds(value.updatedAt)
  )
}

function isStoreShape(value: unknown): value is StoreShape {
  if (!isJsonObject(value)) {
    return false
  }
  const users = Object.entries(value)
  return (
    users.length <= MAX_USERS &&
    users.every(([userUuid, reminders]) => {
      if (!isSafeRecordKey(userUuid) || !isJsonObject(reminders)) {
        return false
      }
      const entries = Object.entries(reminders)
      return (
        entries.length <= MAX_REMINDERS_PER_USER && entries.every(([id, reminder]) => isPublishedReminder(reminder, id))
      )
    })
  )
}

function toPublishedReminder(stored: StoredPublishedReminder): PublishedReminder {
  const reminder = { ...stored }
  delete reminder.deliveryClaim
  return reminder
}

export class PublishedRemindersStore {
  private readonly store: SecureJsonFileStore<StoreShape>
  private readonly clock: () => number
  private readonly randomId: () => string
  private readonly claimLeaseMs: number
  private readonly claimBatchSize: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number

  constructor(filePath: string, options: PublishedRemindersStoreOptions = {}) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isStoreShape,
    })
    this.clock = options.clock ?? (() => Date.now())
    this.randomId = options.randomId ?? (() => randomUUID())
    this.claimLeaseMs = this.boundedPositiveInteger(
      options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
      MAX_CLAIM_LEASE_MS,
      'claimLeaseMs',
    )
    this.claimBatchSize = this.boundedPositiveInteger(
      options.claimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE,
      MAX_CLAIM_BATCH_SIZE,
      'claimBatchSize',
    )
    this.retryBaseMs = this.boundedPositiveInteger(
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      MAX_RETRY_DELAY_MS,
      'retryBaseMs',
    )
    this.retryMaxMs = this.boundedPositiveInteger(
      options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      MAX_RETRY_DELAY_MS,
      'retryMaxMs',
    )
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new Error('retryMaxMs must be greater than or equal to retryBaseMs.')
    }
  }

  async listForUser(userUuid: string): Promise<PublishedReminder[]> {
    if (!isSafeRecordKey(userUuid)) {
      return []
    }
    const data = await this.read()
    const reminders = data[userUuid]
    if (!reminders) {
      return []
    }
    return Object.values(reminders).map(toPublishedReminder)
  }

  async getForUser(userUuid: string, id: string): Promise<PublishedReminder | null> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH)) {
      return null
    }
    const data = await this.read()
    const reminder = data[userUuid]?.[id]
    return reminder ? toPublishedReminder(reminder) : null
  }

  /** Read-only diagnostic view of every unsent reminder across users. */
  async listAllUnsent(): Promise<DueReminder[]> {
    const data = await this.read()
    const out: DueReminder[] = []
    for (const userUuid of Object.keys(data)) {
      for (const reminder of Object.values(data[userUuid])) {
        if (!reminder.sent) {
          out.push({ userUuid, reminder: toPublishedReminder(reminder) })
        }
      }
    }
    return out
  }

  /**
   * Atomically leases a bounded batch of due reminders. The secure store's
   * cross-instance file transaction means only one worker can own an occurrence
   * while its lease is live. Expired leases are eligible again after a crash.
   */
  async claimDue(
    owner: string,
    now: number = this.clock(),
    limit: number = this.claimBatchSize,
  ): Promise<ClaimedReminder[]> {
    if (!UUID_PATTERN.test(owner)) {
      throw new Error('Reminder delivery claim owners must be UUIDs.')
    }
    this.assertEpochMilliseconds(now, 'claim time')
    const boundedLimit = this.boundedPositiveInteger(limit, MAX_CLAIM_BATCH_SIZE, 'claim limit')
    if (now > MAX_EPOCH_MILLISECONDS - this.claimLeaseMs) {
      throw new Error('The reminder delivery claim lease exceeds the supported timestamp range.')
    }

    const claimed: ClaimedReminder[] = []
    await this.mutate((data) => {
      const candidates: Array<{ userUuid: string; reminder: StoredPublishedReminder }> = []
      const existingClaimIds = new Set<string>()

      for (const [userUuid, reminders] of Object.entries(data)) {
        for (const reminder of Object.values(reminders)) {
          if (reminder.deliveryClaim) {
            existingClaimIds.add(reminder.deliveryClaim.id)
          }
          const dueAt = Date.parse(reminder.dueAtUtc)
          const retryAt = reminder.nextAttemptAt ?? 0
          const hasLiveClaim = reminder.deliveryClaim !== undefined && reminder.deliveryClaim.leaseExpiresAt > now
          if (!reminder.sent && dueAt <= now && retryAt <= now && !hasLiveClaim) {
            candidates.push({ userUuid, reminder })
          }
        }
      }

      candidates.sort(
        (left, right) =>
          Date.parse(left.reminder.dueAtUtc) - Date.parse(right.reminder.dueAtUtc) ||
          left.reminder.createdAt - right.reminder.createdAt ||
          left.userUuid.localeCompare(right.userUuid) ||
          left.reminder.id.localeCompare(right.reminder.id),
      )

      for (const { userUuid, reminder } of candidates.slice(0, boundedLimit)) {
        const claim: ReminderDeliveryClaim = {
          id: this.uniqueClaimId(existingClaimIds),
          owner,
          claimedAt: now,
          leaseExpiresAt: now + this.claimLeaseMs,
        }
        existingClaimIds.add(claim.id)
        reminder.attemptCount = Math.min(Number.MAX_SAFE_INTEGER, (reminder.attemptCount ?? 0) + 1)
        reminder.lastAttemptAt = now
        reminder.updatedAt = now
        reminder.deliveryClaim = claim
        delete reminder.nextAttemptAt
        if (!reminder.sent) {
          delete reminder.sentAt
        }
        claimed.push({
          userUuid,
          reminder: toPublishedReminder(reminder),
          claim: { ...claim },
        })
      }
    })
    return claimed
  }

  /**
   * Confirm delivery only when the caller still owns the live lease. Returning
   * false tells a stale worker that it must not alter the occurrence.
   */
  async markClaimSucceeded(
    userUuid: string,
    id: string,
    claim: Pick<ReminderDeliveryClaim, 'id' | 'owner'>,
    now: number = this.clock(),
  ): Promise<boolean> {
    if (!this.validCompletionIdentity(userUuid, id, claim)) {
      return false
    }
    this.assertEpochMilliseconds(now, 'delivery completion time')
    let completed = false
    await this.mutate((data) => {
      const reminder = data[userUuid]?.[id]
      if (!reminder || !this.hasMatchingLiveClaim(reminder, claim, now)) {
        return
      }
      reminder.sent = true
      reminder.sentAt = now
      reminder.updatedAt = now
      delete reminder.error
      delete reminder.nextAttemptAt
      delete reminder.deliveryClaim
      completed = true
    })
    return completed
  }

  /**
   * Release a live claim into persisted exponential backoff. The attempt count
   * was incremented when the claim was acquired, so attempt one waits the base
   * delay, attempt two waits twice that, and so on up to retryMaxMs.
   */
  async scheduleClaimRetry(
    userUuid: string,
    id: string,
    claim: Pick<ReminderDeliveryClaim, 'id' | 'owner'>,
    error: unknown,
    now: number = this.clock(),
  ): Promise<boolean> {
    if (!this.validCompletionIdentity(userUuid, id, claim)) {
      return false
    }
    this.assertEpochMilliseconds(now, 'delivery failure time')
    let scheduled = false
    await this.mutate((data) => {
      const reminder = data[userUuid]?.[id]
      if (!reminder || !this.hasMatchingLiveClaim(reminder, claim, now)) {
        return
      }
      const delay = this.retryDelay(reminder.attemptCount ?? 1)
      reminder.sent = false
      reminder.error = this.errorMessage(error)
      reminder.nextAttemptAt = Math.min(MAX_EPOCH_MILLISECONDS, now + delay)
      reminder.updatedAt = now
      delete reminder.sentAt
      delete reminder.deliveryClaim
      scheduled = true
    })
    return scheduled
  }

  /**
   * Upsert a published reminder for a user. Used by the publish endpoint.
   * Returns the stored reminder with normalized timestamps.
   *
   * RE-ARM SEMANTICS: changing any delivery payload field (message, due time,
   * channel, or destination) starts a new revision and clears all delivery
   * state, including a live claim. That claim can no longer complete the edited
   * revision. Re-publishing an identical payload preserves delivery state so an
   * unchanged, already-delivered occurrence is not delivered twice.
   */
  async publish(
    userUuid: string,
    reminder: Pick<PublishedReminder, 'id' | 'message' | 'dueAtUtc'> &
      Partial<Pick<PublishedReminder, 'channel' | 'destination'>>,
    options: PublishReminderOptions = {},
  ): Promise<PublishedReminder> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(reminder.id, MAX_REMINDER_ID_LENGTH)) {
      throw new Error('A valid user identifier and reminder id are required to publish a reminder.')
    }
    const now = this.clock()
    this.assertEpochMilliseconds(now, 'publish time')
    let stored!: StoredPublishedReminder
    await this.mutate((data) => {
      const forUser = data[userUuid] ?? {}
      const existing = forUser[reminder.id]
      const payloadChanged =
        existing !== undefined &&
        (existing.message !== reminder.message ||
          existing.dueAtUtc !== reminder.dueAtUtc ||
          existing.channel !== reminder.channel ||
          existing.destination !== reminder.destination)
      if (
        existing &&
        payloadChanged &&
        !options.preserveDeliveryState &&
        !options.allowClaimInvalidation &&
        existing.deliveryClaim &&
        existing.deliveryClaim.leaseExpiresAt > now
      ) {
        throw new Error('The reminder is already in flight and cannot be changed safely.')
      }
      const retainedState =
        existing && (!payloadChanged || options.preserveDeliveryState)
          ? {
              sent: existing.sent,
              ...(existing.sentAt === undefined ? {} : { sentAt: existing.sentAt }),
              ...(existing.error === undefined ? {} : { error: existing.error }),
              ...(existing.attemptCount === undefined ? {} : { attemptCount: existing.attemptCount }),
              ...(existing.lastAttemptAt === undefined ? {} : { lastAttemptAt: existing.lastAttemptAt }),
              ...(existing.nextAttemptAt === undefined ? {} : { nextAttemptAt: existing.nextAttemptAt }),
              ...(existing.deliveryClaim === undefined ? {} : { deliveryClaim: existing.deliveryClaim }),
            }
          : { sent: false }
      const preservePublicationGeneration = existing !== undefined && (!payloadChanged || options.preserveDeliveryState)
      stored = {
        ...reminder,
        ...(preservePublicationGeneration && existing.deliveryRevision
          ? { deliveryRevision: existing.deliveryRevision }
          : { deliveryRevision: randomUUID() }),
        ...retainedState,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      if (!isPublishedReminder(stored, reminder.id)) {
        throw new Error('Refusing to publish an invalid reminder.')
      }
      forUser[reminder.id] = stored
      data[userUuid] = forUser
    })
    return toPublishedReminder(stored)
  }

  /** Remove a single published reminder. Returns whether anything was removed. */
  async unpublish(userUuid: string, id: string): Promise<boolean> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH)) {
      return false
    }
    let removed = false
    await this.mutate((data) => {
      if (data[userUuid] && data[userUuid][id]) {
        delete data[userUuid][id]
        removed = true
        if (Object.keys(data[userUuid]).length === 0) {
          delete data[userUuid]
        }
      }
    })
    return removed
  }

  /**
   * Atomically removes a reminder only when no uncancelled provider call can
   * own it. `allowActiveClaim` is reserved for a durable provider whose queue
   * cancellation fence was persisted before this transaction.
   */
  async unpublishSafely(
    userUuid: string,
    id: string,
    allowActiveClaim = false,
  ): Promise<PublishedReminderRemovalResult> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH)) {
      return 'not-found'
    }
    const now = this.clock()
    this.assertEpochMilliseconds(now, 'unpublish time')
    let result: PublishedReminderRemovalResult = 'not-found'
    await this.mutate((data) => {
      const reminder = data[userUuid]?.[id]
      if (!reminder) {
        return
      }
      if (!allowActiveClaim && reminder.deliveryClaim && reminder.deliveryClaim.leaseExpiresAt > now) {
        result = 'in-flight'
        return
      }
      delete data[userUuid][id]
      if (Object.keys(data[userUuid]).length === 0) {
        delete data[userUuid]
      }
      result = 'removed'
    })
    return result
  }

  /** Atomically removes a bounded set after every non-fenced live claim is checked. */
  async unpublishManySafely(
    userUuid: string,
    ids: string[],
    allowActiveClaimIds: string[] = [],
  ): Promise<PublishedReminderRemovalResult> {
    if (
      !isSafeRecordKey(userUuid) ||
      ids.some((id) => !isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH)) ||
      allowActiveClaimIds.some((id) => !isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH))
    ) {
      return 'not-found'
    }
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) {
      return 'not-found'
    }
    const allowed = new Set(allowActiveClaimIds)
    const now = this.clock()
    this.assertEpochMilliseconds(now, 'bulk unpublish time')
    let result: PublishedReminderRemovalResult = 'not-found'
    await this.mutate((data) => {
      const reminders = data[userUuid]
      if (!reminders) {
        return
      }
      const existing = uniqueIds.filter((id) => reminders[id] !== undefined)
      if (existing.length === 0) {
        return
      }
      if (
        existing.some((id) => {
          const claim = reminders[id].deliveryClaim
          return claim !== undefined && claim.leaseExpiresAt > now && !allowed.has(id)
        })
      ) {
        result = 'in-flight'
        return
      }
      for (const id of existing) {
        delete reminders[id]
      }
      if (Object.keys(reminders).length === 0) {
        delete data[userUuid]
      }
      result = 'removed'
    })
    return result
  }

  /** Erases all opted-in plaintext, including already delivered history. */
  async clearForUserSafely(
    userUuid: string,
    allowActiveClaimIds: string[] = [],
  ): Promise<PublishedReminderRemovalResult> {
    if (!isSafeRecordKey(userUuid) || allowActiveClaimIds.some((id) => !isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH))) {
      return 'not-found'
    }
    const allowed = new Set(allowActiveClaimIds)
    const now = this.clock()
    this.assertEpochMilliseconds(now, 'opt-out time')
    let result: PublishedReminderRemovalResult = 'not-found'
    await this.mutate((data) => {
      const reminders = data[userUuid]
      if (!reminders) {
        return
      }
      if (
        Object.values(reminders).some((reminder) => {
          const claim = reminder.deliveryClaim
          return claim !== undefined && claim.leaseExpiresAt > now && !allowed.has(reminder.id)
        })
      ) {
        result = 'in-flight'
        return
      }
      delete data[userUuid]
      result = 'removed'
    })
    return result
  }

  private async read(): Promise<StoreShape> {
    return (await this.store.read()) ?? {}
  }

  private async mutate(mutator: (data: StoreShape) => void): Promise<void> {
    await this.store.update((current) => {
      const data = current ?? {}
      mutator(data)
      return data
    })
  }

  private validCompletionIdentity(
    userUuid: string,
    id: string,
    claim: Pick<ReminderDeliveryClaim, 'id' | 'owner'>,
  ): boolean {
    return (
      isSafeRecordKey(userUuid) &&
      isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH) &&
      UUID_PATTERN.test(claim.id) &&
      UUID_PATTERN.test(claim.owner)
    )
  }

  private hasMatchingLiveClaim(
    reminder: StoredPublishedReminder,
    claim: Pick<ReminderDeliveryClaim, 'id' | 'owner'>,
    now: number,
  ): boolean {
    return (
      reminder.deliveryClaim !== undefined &&
      reminder.deliveryClaim.id === claim.id &&
      reminder.deliveryClaim.owner === claim.owner &&
      reminder.deliveryClaim.leaseExpiresAt > now
    )
  }

  private uniqueClaimId(existingClaimIds: Set<string>): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.randomId()
      if (!UUID_PATTERN.test(id)) {
        throw new Error('The reminder delivery claim id generator must return a UUID.')
      }
      if (!existingClaimIds.has(id)) {
        return id
      }
    }
    throw new Error('Unable to generate a unique reminder delivery claim id.')
  }

  private retryDelay(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(52, attemptCount - 1))
    const multiplier = 2 ** exponent
    if (multiplier >= this.retryMaxMs / this.retryBaseMs) {
      return this.retryMaxMs
    }
    return Math.min(this.retryMaxMs, this.retryBaseMs * multiplier)
  }

  private errorMessage(error: unknown): string {
    let message = 'Reminder delivery failed without an error message.'
    try {
      if (error instanceof Error) {
        message = error.message
      } else if (typeof error === 'string') {
        message = error
      } else if (error !== undefined && error !== null) {
        message = String(error)
      }
    } catch {
      message = 'Reminder delivery failed with an unreadable error.'
    }
    return message.slice(0, MAX_ERROR_LENGTH)
  }

  private assertEpochMilliseconds(value: number, name: string): void {
    if (!isEpochMilliseconds(value)) {
      throw new Error(`${name} must be a supported epoch-millisecond timestamp.`)
    }
  }

  private boundedPositiveInteger(value: number, maximum: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`${name} must be a positive integer no greater than ${maximum}.`)
    }
    return value
  }
}
