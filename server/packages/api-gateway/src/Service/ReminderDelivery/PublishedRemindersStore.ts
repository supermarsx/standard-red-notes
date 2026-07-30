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

interface StoreShape {
  // userUuid -> { reminderId -> PublishedReminder }
  [userUuid: string]: { [id: string]: PublishedReminder }
}

export interface DueReminder {
  userUuid: string
  reminder: PublishedReminder
}

const MAX_USERS = 10_000
const MAX_REMINDERS_PER_USER = 10_000
const MAX_REMINDER_ID_LENGTH = 512
const MAX_MESSAGE_LENGTH = 65_536
const MAX_DESTINATION_LENGTH = 8_192
const MAX_ERROR_LENGTH = 16_384
const ISO_UTC_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:[Zz]|[+-][0-2]\d:[0-5]\d)$/

function isOptionalEpochMilliseconds(value: unknown): value is number | undefined {
  return value === undefined || isEpochMilliseconds(value)
}

function isPublishedReminder(value: unknown, id: string): value is PublishedReminder {
  return (
    hasOnlyKeys(value, [
      'id',
      'message',
      'dueAtUtc',
      'channel',
      'destination',
      'sent',
      'sentAt',
      'error',
      'createdAt',
      'updatedAt',
    ]) &&
    isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH) &&
    value.id === id &&
    isBoundedString(value.message, 0, MAX_MESSAGE_LENGTH) &&
    isBoundedString(value.dueAtUtc, 1, 64) &&
    ISO_UTC_DATE_TIME_PATTERN.test(value.dueAtUtc) &&
    !Number.isNaN(Date.parse(value.dueAtUtc)) &&
    (value.channel === undefined || isDeliveryChannel(value.channel)) &&
    (value.destination === undefined || isBoundedString(value.destination, 0, MAX_DESTINATION_LENGTH)) &&
    typeof value.sent === 'boolean' &&
    isOptionalEpochMilliseconds(value.sentAt) &&
    (value.error === undefined || isBoundedString(value.error, 0, MAX_ERROR_LENGTH)) &&
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

export class PublishedRemindersStore {
  private readonly store: SecureJsonFileStore<StoreShape>

  constructor(filePath: string) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isStoreShape,
    })
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
    return Object.values(reminders)
  }

  async getForUser(userUuid: string, id: string): Promise<PublishedReminder | null> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH)) {
      return null
    }
    const data = await this.read()
    return data[userUuid]?.[id] ?? null
  }

  /**
   * Cross-user scan used by the scheduler: every UNSENT reminder, paired with its
   * owner. Due-selection itself is the caller's concern (see `isDue`) so this
   * stays a cheap read.
   */
  async listAllUnsent(): Promise<DueReminder[]> {
    const data = await this.read()
    const out: DueReminder[] = []
    for (const userUuid of Object.keys(data)) {
      for (const reminder of Object.values(data[userUuid])) {
        if (!reminder.sent) {
          out.push({ userUuid, reminder })
        }
      }
    }
    return out
  }

  /**
   * Upsert a published reminder for a user. Used by the publish endpoint.
   * Returns the stored reminder with normalized timestamps.
   *
   * RE-ARM SEMANTICS: when the caller does not pass `sent` explicitly and an
   * existing reminder is re-published with a NEW `dueAtUtc`, `sent` resets to
   * false. This is how the web client updates an edited reminder or advances a
   * recurring one to its next occurrence under the same stable id — the new
   * occurrence must be delivered even though the previous one already was.
   * Re-publishing with the SAME `dueAtUtc` preserves `sent` (an unchanged,
   * already-delivered reminder is not delivered twice).
   */
  async publish(
    userUuid: string,
    reminder: Omit<PublishedReminder, 'createdAt' | 'updatedAt' | 'sent'> &
      Partial<Pick<PublishedReminder, 'sent' | 'createdAt'>>,
  ): Promise<PublishedReminder> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(reminder.id, MAX_REMINDER_ID_LENGTH)) {
      throw new Error('A valid user identifier and reminder id are required to publish a reminder.')
    }
    const now = Date.now()
    let stored!: PublishedReminder
    await this.mutate((data) => {
      const forUser = data[userUuid] ?? {}
      const existing = forUser[reminder.id]
      const dueChanged = existing !== undefined && existing.dueAtUtc !== reminder.dueAtUtc
      stored = {
        ...reminder,
        sent: reminder.sent ?? (dueChanged ? false : (existing?.sent ?? false)),
        createdAt: existing?.createdAt ?? reminder.createdAt ?? now,
        updatedAt: now,
      }
      if (!isPublishedReminder(stored, reminder.id)) {
        throw new Error('Refusing to publish an invalid reminder.')
      }
      forUser[reminder.id] = stored
      data[userUuid] = forUser
    })
    return stored
  }

  /** Mark a reminder delivered or terminally failed. No-op if absent. */
  async markSent(userUuid: string, id: string, ok: boolean, error?: string): Promise<void> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(id, MAX_REMINDER_ID_LENGTH)) {
      return
    }
    await this.mutate((data) => {
      const reminder = data[userUuid]?.[id]
      if (!reminder) {
        return
      }
      reminder.sent = ok
      reminder.sentAt = Date.now()
      reminder.updatedAt = Date.now()
      reminder.error = ok ? undefined : error?.slice(0, MAX_ERROR_LENGTH)
    })
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
}
