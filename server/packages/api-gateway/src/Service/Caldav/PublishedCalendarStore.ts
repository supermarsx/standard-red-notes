import { promises as fs } from 'fs'
import * as path from 'path'

import { PublishedTodo } from './ICalendarSerializer'

/**
 * Standard Red Notes: a per-user, server-READABLE "published calendar" store.
 *
 * WHY THIS EXISTS: notes/reminders are end-to-end encrypted, so the server
 * cannot read them. The CalDAV feed therefore serves ONLY the small set of
 * reminders/todos a user has EXPLICITLY published into THIS store. The data here
 * is plaintext by design (that is the cost of exposing it to stock CalDAV
 * clients) and is empty until the user publishes something.
 *
 * STORAGE: a single JSON file (default empty object). This is the lightest idiom
 * that keeps the feature fully self-contained inside api-gateway, which has no
 * database of its own. Writes are serialized per process via a simple mutex so
 * concurrent publishes don't clobber each other; the file is rewritten
 * atomically (temp file + rename).
 *
 * NOTE (first slice): there is no publish API/UI yet — populating this store is a
 * deferred item. The store + read path exist so the CalDAV surface is testable
 * and a publish endpoint can be added without reworking the read side.
 */

interface StoreShape {
  // userUuid -> { todoUid -> PublishedTodo }
  [userUuid: string]: { [uid: string]: PublishedTodo }
}

export class PublishedCalendarStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async listForUser(userUuid: string): Promise<PublishedTodo[]> {
    const data = await this.read()
    const todos = data[userUuid]
    if (!todos) {
      return []
    }
    return Object.values(todos)
  }

  async getForUser(userUuid: string, uid: string): Promise<PublishedTodo | null> {
    const data = await this.read()
    return data[userUuid]?.[uid] ?? null
  }

  /**
   * Upsert a published todo for a user. Used by a (future) publish endpoint.
   * Returns the stored todo with normalized timestamps.
   */
  async publish(userUuid: string, todo: PublishedTodo): Promise<PublishedTodo> {
    const now = Date.now()
    const normalized: PublishedTodo = {
      ...todo,
      createdAt: todo.createdAt ?? now,
      updatedAt: now,
    }
    await this.mutate((data) => {
      const forUser = data[userUuid] ?? {}
      forUser[todo.uid] = normalized
      data[userUuid] = forUser
    })
    return normalized
  }

  /** Remove a single published todo. No-op if absent. */
  async unpublish(userUuid: string, uid: string): Promise<void> {
    await this.mutate((data) => {
      if (data[userUuid]) {
        delete data[userUuid][uid]
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
