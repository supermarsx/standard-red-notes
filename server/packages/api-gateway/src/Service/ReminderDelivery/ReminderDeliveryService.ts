import { createHash, randomUUID } from 'crypto'

import { DeliveryConfigStore } from './DeliveryConfigStore'
import { ProviderRegistry } from './Providers/ProviderRegistry'
import { ClaimedReminder, PublishedRemindersStore } from './PublishedRemindersStore'
import { DeliveryConfig, DeliveryResult, PublishedReminder, formatReminderMessage } from './Types'

/**
 * Standard Red Notes: facade tying together the published-reminders store, the
 * per-user delivery config, and the provider registry. Holds the env master
 * switch so callers (controller + scheduler) ask ONE place "is this feature on?".
 *
 * Mirrors CalDAV's CaldavService gating model (off by default, two gates):
 *   1. env master switch REMINDER_DELIVERY_ENABLED (this.enabled) — operator opt-in.
 *   2. per-user opt-in — the controller checks the REMINDER_DELIVERY_ENABLED
 *      setting before publishing/configuring; the scheduler additionally requires
 *      an ENABLED DeliveryConfig for the user, so nothing is ever sent for a user
 *      who has not opted in and configured a channel.
 *
 * E2E NOTE: this service only ever touches the explicit published store + the
 * user's own delivery config. It cannot read any other (encrypted) data.
 */

export interface DeliverySummary {
  scanned: number
  due: number
  sent: number
  failed: number
  skipped: number
}

export interface ReminderDeliveryOptOutResult {
  /** A provider had already accepted at least one occurrence before revocation. */
  alreadyDispatched: boolean
}

type EmailCancellationOutcome = 'not-durable' | 'cancelled' | 'provider-accepted'

export interface ReminderDeliveryServiceOptions {
  ownerId?: string
  clock?: () => number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createPublishedReminderDeliveryId(
  userUuid: string,
  reminder: Pick<PublishedReminder, 'id' | 'dueAtUtc' | 'deliveryRevision'>,
  destination: string,
  message: string,
): string {
  const digest = createHash('sha256')
  for (const value of [
    userUuid,
    reminder.id,
    reminder.deliveryRevision ?? 'legacy',
    reminder.dueAtUtc,
    destination,
    message,
  ]) {
    digest.update(`${Buffer.byteLength(value, 'utf8')}:`, 'utf8')
    digest.update(value, 'utf8')
  }
  return `published-reminder-${digest.digest('hex')}`
}

type ReminderDeliveryIdentityInput = Pick<PublishedReminder, 'id' | 'message' | 'dueAtUtc' | 'deliveryRevision'> &
  Partial<Pick<PublishedReminder, 'channel' | 'destination'>>

function effectiveEmailDeliveryId(
  userUuid: string,
  reminder: ReminderDeliveryIdentityInput,
  config: DeliveryConfig | null,
): string | undefined {
  const channel = reminder.channel ?? config?.channel
  const destination = reminder.destination ?? config?.destination
  if (channel !== 'email' || !destination) {
    return undefined
  }
  return createPublishedReminderDeliveryId(userUuid, reminder, destination, formatReminderMessage(reminder))
}

function effectiveDeliveryIdentity(
  reminder: ReminderDeliveryIdentityInput,
  config: DeliveryConfig | null,
): string | undefined {
  const channel = reminder.channel ?? config?.channel
  const destination = reminder.destination ?? config?.destination
  if (!channel || !destination) {
    return undefined
  }
  return `${channel}\0${destination}\0${formatReminderMessage(reminder)}`
}

function isDeliveryResult(value: unknown): value is DeliveryResult {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'ok' in value &&
      typeof value.ok === 'boolean' &&
      (!('notConfigured' in value) || value.notConfigured === undefined || typeof value.notConfigured === 'boolean') &&
      (!('pending' in value) || value.pending === undefined || typeof value.pending === 'boolean') &&
      (!('reason' in value) || value.reason === undefined || typeof value.reason === 'string')
    )
  } catch {
    return false
  }
}

function deliveryConfigChanged(previous: DeliveryConfig, replacement: DeliveryConfig): boolean {
  return previous.channel !== replacement.channel || previous.destination !== replacement.destination
}

export class ReminderDeliveryService {
  private readonly ownerId: string
  private readonly clock: () => number

  constructor(
    private readonly enabled: boolean,
    private readonly remindersStore: PublishedRemindersStore,
    private readonly configStore: DeliveryConfigStore,
    private readonly registry: ProviderRegistry,
    options: ReminderDeliveryServiceOptions = {},
  ) {
    this.ownerId = options.ownerId ?? randomUUID()
    this.clock = options.clock ?? (() => Date.now())
    if (!UUID_PATTERN.test(this.ownerId)) {
      throw new Error('Reminder delivery worker owners must be UUIDs.')
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  // ---- published-reminders API (used by the controller) ----

  async publish(
    userUuid: string,
    reminder: Pick<PublishedReminder, 'id' | 'message' | 'dueAtUtc'> &
      Partial<Pick<PublishedReminder, 'channel' | 'destination'>>,
  ): Promise<PublishedReminder> {
    const existing = await this.remindersStore.getForUser(userUuid, reminder.id)
    if (existing && !existing.sent) {
      const config = await this.configStore.getForUser(userUuid)
      const oldDeliveryId = effectiveEmailDeliveryId(userUuid, existing, config)
      const replacement = { ...reminder, deliveryRevision: existing.deliveryRevision }
      const newDeliveryId = effectiveEmailDeliveryId(userUuid, replacement, config)
      const sameEffectiveDelivery =
        effectiveDeliveryIdentity(existing, config) === effectiveDeliveryIdentity(replacement, config)
      let durableCancellationPersisted = false
      if (oldDeliveryId && oldDeliveryId !== newDeliveryId) {
        const cancellation = await this.cancelQueuedEmail(oldDeliveryId)
        this.assertNotProviderAccepted(cancellation)
        durableCancellationPersisted = cancellation === 'cancelled'
      }
      return this.remindersStore.publish(userUuid, reminder, {
        preserveDeliveryState: sameEffectiveDelivery,
        allowClaimInvalidation: durableCancellationPersisted,
      })
    }
    return this.remindersStore.publish(userUuid, reminder)
  }

  async listReminders(userUuid: string): Promise<PublishedReminder[]> {
    return this.remindersStore.listForUser(userUuid)
  }

  /** Remove a published reminder so it will never be delivered. */
  async unpublish(userUuid: string, id: string): Promise<boolean> {
    const existing = await this.remindersStore.getForUser(userUuid, id)
    if (!existing) {
      return false
    }
    let durableCancellationPersisted = false
    if (!existing.sent) {
      const config = await this.configStore.getForUser(userUuid)
      const deliveryId = effectiveEmailDeliveryId(userUuid, existing, config)
      if (deliveryId) {
        const cancellation = await this.cancelQueuedEmail(deliveryId)
        this.assertNotProviderAccepted(cancellation)
        durableCancellationPersisted = cancellation === 'cancelled'
      }
    }
    const removed = await this.remindersStore.unpublishSafely(userUuid, id, durableCancellationPersisted)
    if (removed === 'in-flight') {
      throw new Error('The reminder is already in flight and cannot be unpublished safely.')
    }
    return removed === 'removed'
  }

  // ---- delivery config API (used by the controller) ----

  async getConfig(userUuid: string): Promise<DeliveryConfig | null> {
    return this.configStore.getForUser(userUuid)
  }

  async setConfig(userUuid: string, config: DeliveryConfig): Promise<DeliveryConfig> {
    const previous = await this.configStore.getForUser(userUuid)
    if (previous?.enabled && (!config.enabled || deliveryConfigChanged(previous, config))) {
      const affected: PublishedReminder[] = []
      const durableCancellationIds: string[] = []
      for (const reminder of (await this.remindersStore.listForUser(userUuid)).filter((item) => !item.sent)) {
        const oldIdentity = effectiveDeliveryIdentity(reminder, previous)
        const newIdentity = config.enabled ? effectiveDeliveryIdentity(reminder, config) : undefined
        if (config.enabled && oldIdentity === newIdentity) {
          continue
        }
        affected.push(reminder)
        const oldDeliveryId = effectiveEmailDeliveryId(userUuid, reminder, previous)
        if (oldDeliveryId) {
          const cancellation = await this.cancelQueuedEmail(oldDeliveryId)
          this.assertNotProviderAccepted(cancellation)
          if (cancellation === 'cancelled') {
            durableCancellationIds.push(reminder.id)
          }
        }
      }
      const removed = await this.remindersStore.unpublishManySafely(
        userUuid,
        affected.map((reminder) => reminder.id),
        durableCancellationIds,
      )
      if (removed === 'in-flight') {
        throw new Error('A reminder is already in flight, so delivery configuration cannot change safely.')
      }
    }
    return this.configStore.setForUser(userUuid, config)
  }

  /** Authoritative account opt-out; deliberately remains callable after the synced gate turns off. */
  async optOut(userUuid: string): Promise<ReminderDeliveryOptOutResult> {
    const config = await this.configStore.getForUser(userUuid)
    const durableCancellationIds: string[] = []
    let alreadyDispatched = false
    for (const reminder of await this.remindersStore.listForUser(userUuid)) {
      if (!reminder.sent) {
        const deliveryId = effectiveEmailDeliveryId(userUuid, reminder, config)
        if (deliveryId) {
          const cancellation = await this.cancelQueuedEmail(deliveryId)
          if (cancellation === 'provider-accepted') {
            alreadyDispatched = true
          }
          if (cancellation !== 'not-durable') {
            durableCancellationIds.push(reminder.id)
          }
        }
      }
    }
    const removed = await this.remindersStore.clearForUserSafely(userUuid, durableCancellationIds)
    if (removed === 'in-flight') {
      throw new Error('A reminder is already in flight, so account delivery cannot be disabled safely yet.')
    }
    await this.configStore.deleteForUser(userUuid)
    return { alreadyDispatched }
  }

  // ---- the scan (used by the scheduler) ----

  /**
   * Atomically claim a bounded batch of published, unsent, DUE reminders and
   * deliver each via the owner's configured channel (or a per-reminder
   * channel/destination override). Successful and failed completion are both
   * conditional on this worker still owning a live claim.
   *
   * Provider and per-reminder configuration failures are isolated and persisted
   * with backoff so the scan continues. Store-wide failures still propagate to
   * the scheduler, which logs them without crashing the process.
   */
  async deliverDueReminders(now?: Date): Promise<DeliverySummary> {
    const summary: DeliverySummary = { scanned: 0, due: 0, sent: 0, failed: 0, skipped: 0 }
    if (!this.enabled) {
      return summary
    }

    const fixedNow = now?.getTime()
    const claimTime = fixedNow ?? this.clock()
    const claimed = await this.remindersStore.claimDue(this.ownerId, claimTime)
    summary.scanned = claimed.length
    summary.due = claimed.length

    // Cache per-user config across the scan so we don't re-read the file per item.
    const configCache = new Map<string, DeliveryConfig | null>()

    for (const dueReminder of claimed) {
      const { userUuid, reminder } = dueReminder
      let config = configCache.get(userUuid)
      try {
        if (config === undefined) {
          config = await this.getConfig(userUuid)
          configCache.set(userUuid, config)
        }
      } catch (error) {
        await this.recordRetry(dueReminder, error, fixedNow, summary, 'failed')
        continue
      }

      const channel = reminder.channel ?? config?.channel
      const destination = reminder.destination ?? config?.destination

      if (!config) {
        await this.recordRetry(
          dueReminder,
          'Reminder delivery is not configured for this user.',
          fixedNow,
          summary,
          'skipped',
        )
        continue
      }
      if (!config.enabled) {
        await this.recordRetry(
          dueReminder,
          'Reminder delivery is disabled for this user.',
          fixedNow,
          summary,
          'skipped',
        )
        continue
      }
      if (!channel || !destination) {
        await this.recordRetry(
          dueReminder,
          'Reminder delivery requires a channel and destination.',
          fixedNow,
          summary,
          'skipped',
        )
        continue
      }

      const provider = this.registry.get(channel)
      if (!provider) {
        await this.recordRetry(
          dueReminder,
          `No reminder delivery provider is registered for ${channel}.`,
          fixedNow,
          summary,
          'skipped',
        )
        continue
      }

      const message = formatReminderMessage(reminder)
      let result
      try {
        result =
          channel === 'email'
            ? await provider.send(destination, message, {
                deliveryId: createPublishedReminderDeliveryId(userUuid, reminder, destination, message),
              })
            : await provider.send(destination, message)
      } catch (error) {
        await this.recordRetry(dueReminder, error, fixedNow, summary, 'failed')
        continue
      }

      if (!isDeliveryResult(result)) {
        await this.recordRetry(
          dueReminder,
          'The reminder delivery provider returned an invalid result.',
          fixedNow,
          summary,
          'failed',
        )
        continue
      }

      if (result.ok) {
        const completed = await this.remindersStore.markClaimSucceeded(
          userUuid,
          reminder.id,
          dueReminder.claim,
          fixedNow ?? this.clock(),
        )
        if (completed) {
          summary.sent++
        } else {
          summary.skipped++
        }
      } else {
        await this.recordRetry(
          dueReminder,
          result.reason ?? 'The reminder delivery provider reported a failure.',
          fixedNow,
          summary,
          result.pending ? 'skipped' : 'failed',
        )
      }
    }

    return summary
  }

  private async cancelQueuedEmail(deliveryId: string): Promise<EmailCancellationOutcome> {
    const provider = this.registry.get('email')
    if (!provider?.cancel) {
      // Direct SMTP has no stored job to revoke. The published-store removal
      // below is atomic with its live-claim check, so future sends are stopped
      // and an already-started send is reported as in flight.
      return 'not-durable'
    }
    const result = await provider.cancel({ deliveryId })
    if (!result.ok) {
      throw new Error(result.reason ?? 'The pending reminder email could not be cancelled safely.')
    }
    return result.providerAccepted ? 'provider-accepted' : 'cancelled'
  }

  private assertNotProviderAccepted(outcome: EmailCancellationOutcome): void {
    if (outcome === 'provider-accepted') {
      throw new Error('The reminder email was already accepted by its provider and cannot be cancelled.')
    }
  }

  private async recordRetry(
    dueReminder: ClaimedReminder,
    error: unknown,
    fixedNow: number | undefined,
    summary: DeliverySummary,
    outcome: 'failed' | 'skipped',
  ): Promise<void> {
    const scheduled = await this.remindersStore.scheduleClaimRetry(
      dueReminder.userUuid,
      dueReminder.reminder.id,
      dueReminder.claim,
      error,
      fixedNow ?? this.clock(),
    )
    if (scheduled) {
      summary[outcome]++
    } else {
      summary.skipped++
    }
  }
}
