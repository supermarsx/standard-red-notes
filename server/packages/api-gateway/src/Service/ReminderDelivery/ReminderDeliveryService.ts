import { DeliveryConfigStore } from './DeliveryConfigStore'
import { ProviderRegistry } from './Providers/ProviderRegistry'
import { PublishedRemindersStore } from './PublishedRemindersStore'
import { DeliveryConfig, PublishedReminder, formatReminderMessage, isDue } from './Types'

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

export class ReminderDeliveryService {
  constructor(
    private readonly enabled: boolean,
    private readonly remindersStore: PublishedRemindersStore,
    private readonly configStore: DeliveryConfigStore,
    private readonly registry: ProviderRegistry,
  ) {}

  isEnabled(): boolean {
    return this.enabled
  }

  // ---- published-reminders API (used by the controller) ----

  async publish(
    userUuid: string,
    reminder: Pick<PublishedReminder, 'id' | 'message' | 'dueAtUtc'> &
      Partial<Pick<PublishedReminder, 'channel' | 'destination'>>,
  ): Promise<PublishedReminder> {
    return this.remindersStore.publish(userUuid, reminder)
  }

  async listReminders(userUuid: string): Promise<PublishedReminder[]> {
    return this.remindersStore.listForUser(userUuid)
  }

  async markSent(userUuid: string, id: string, ok: boolean, error?: string): Promise<void> {
    return this.remindersStore.markSent(userUuid, id, ok, error)
  }

  // ---- delivery config API (used by the controller) ----

  async getConfig(userUuid: string): Promise<DeliveryConfig | null> {
    return this.configStore.getForUser(userUuid)
  }

  async setConfig(userUuid: string, config: DeliveryConfig): Promise<DeliveryConfig> {
    return this.configStore.setForUser(userUuid, config)
  }

  // ---- the scan (used by the scheduler) ----

  /**
   * Scan every published, unsent, DUE reminder and deliver each via the owner's
   * configured channel (or a per-reminder channel/destination override), marking
   * it sent on success and recording the failure reason otherwise.
   *
   * Returns a summary for logging. Never throws: a single reminder's failure is
   * recorded and the scan continues.
   */
  async deliverDueReminders(now: Date = new Date()): Promise<DeliverySummary> {
    const summary: DeliverySummary = { scanned: 0, due: 0, sent: 0, failed: 0, skipped: 0 }
    if (!this.enabled) {
      return summary
    }

    const unsent = await this.remindersStore.listAllUnsent()
    summary.scanned = unsent.length

    // Cache per-user config across the scan so we don't re-read the file per item.
    const configCache = new Map<string, DeliveryConfig | null>()

    for (const { userUuid, reminder } of unsent) {
      if (!isDue(reminder, now)) {
        continue
      }
      summary.due++

      let config = configCache.get(userUuid)
      if (config === undefined) {
        config = await this.getConfig(userUuid)
        configCache.set(userUuid, config)
      }

      const channel = reminder.channel ?? config?.channel
      const destination = reminder.destination ?? config?.destination

      // Skip (do NOT mark sent) when the user hasn't opted in / configured a
      // usable channel — they may configure it before the reminder is purged.
      if (!config || !config.enabled || !channel || !destination) {
        summary.skipped++
        continue
      }

      const provider = this.registry.get(channel)
      if (!provider) {
        summary.skipped++
        continue
      }

      const message = formatReminderMessage(reminder)
      const result = await provider.send(destination, message)

      if (result.ok) {
        await this.remindersStore.markSent(userUuid, reminder.id, true)
        summary.sent++
      } else {
        // Unconfigured adapter / transient failure: record the reason, leave it
        // UNSENT so a later tick (once creds are present) can retry.
        await this.remindersStore.markSent(userUuid, reminder.id, false, result.reason)
        summary.failed++
      }
    }

    return summary
  }
}
