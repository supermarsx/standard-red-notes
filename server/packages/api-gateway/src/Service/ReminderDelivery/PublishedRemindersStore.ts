import { promises as fs } from 'fs'
import * as path from 'path'

import { PublishedReminder } from './Types'

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
 * self-contained inside api-gateway, which has no database of its own. Writes are
 * serialized per process via a simple mutex so concurrent publishes don't clobber
 * each other; the file is rewritten atomically (temp file + rename).
 */

interface StoreShape {
  // userUuid -> { reminderId -> PublishedReminder }
  [userUuid: string]: { [id: string]: PublishedReminder }
}

export interface DueReminder {
  userUuid: string
  reminder: PublishedReminder
}

export class PublishedRemindersStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async listForUser(userUuid: string): Promise<PublishedReminder[]> {
    const data = await this.read()
    const reminders = data[userUuid]
    if (!reminders) {
      return []
    }
    return Object.values(reminders)
  }

  async getForUser(userUuid: string, id: string): Promise<PublishedReminder | null> {
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
   */
  async publish(
    userUuid: string,
    reminder: Omit<PublishedReminder, 'createdAt' | 'updatedAt' | 'sent'> &
      Partial<Pick<PublishedReminder, 'sent' | 'createdAt'>>,
  ): Promise<PublishedReminder> {
    const now = Date.now()
    let stored!: PublishedReminder
    await this.mutate((data) => {
      const forUser = data[userUuid] ?? {}
      const existing = forUser[reminder.id]
      stored = {
        ...reminder,
        sent: reminder.sent ?? existing?.sent ?? false,
        createdAt: existing?.createdAt ?? reminder.createdAt ?? now,
        updatedAt: now,
      }
      forUser[reminder.id] = stored
      data[userUuid] = forUser
    })
    return stored
  }

  /** Mark a reminder delivered or terminally failed. No-op if absent. */
  async markSent(userUuid: string, id: string, ok: boolean, error?: string): Promise<void> {
    await this.mutate((data) => {
      const reminder = data[userUuid]?.[id]
      if (!reminder) {
        return
      }
      reminder.sent = ok
      reminder.sentAt = Date.now()
      reminder.updatedAt = Date.now()
      reminder.error = ok ? undefined : error
    })
  }

  /** Remove a single published reminder. No-op if absent. */
  async unpublish(userUuid: string, id: string): Promise<void> {
    await this.mutate((data) => {
      if (data[userUuid]) {
        delete data[userUuid][id]
        if (Object.keys(data[userUuid]).length === 0) {
          delete data[userUuid]
        }
      }
    })
  }

  private async read(): Promise<StoreShape> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreShape
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      throw error
    }
  }

  private async mutate(mutator: (data: StoreShape) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      const data = await this.read()
      mutator(data)
      await this.atomicWrite(data)
    })
    // Keep the chain alive even if a write rejects, so later writes still run.
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async atomicWrite(data: StoreShape): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
