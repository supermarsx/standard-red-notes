import {
  hasOnlyKeys,
  isBoundedString,
  isEpochMilliseconds,
  isJsonObject,
  isSafeRecordKey,
  SecureJsonFileStore,
} from '../../Infra/SecureJsonFileStore'
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
 * database of its own. The shared secure-file primitive bounds and validates
 * reads, rejects unsafe link/type targets, and serializes durable atomic writes
 * across local store instances.
 *
 * NOTE (first slice): there is no publish API/UI yet — populating this store is a
 * deferred item. The store + read path exist so the CalDAV surface is testable
 * and a publish endpoint can be added without reworking the read side.
 */

interface StoreShape {
  // userUuid -> { todoUid -> PublishedTodo }
  [userUuid: string]: { [uid: string]: PublishedTodo }
}

const MAX_USERS = 10_000
const MAX_TODOS_PER_USER = 10_000
const MAX_UID_LENGTH = 1_024
const MAX_SUMMARY_LENGTH = 4_096
const MAX_DESCRIPTION_LENGTH = 65_536
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:[Zz]|[+-][0-2]\d:[0-5]\d)?)?$/

function isOptionalBoundedString(value: unknown, maximumLength: number): value is string | undefined {
  return value === undefined || isBoundedString(value, 0, maximumLength)
}

function isOptionalIsoDate(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (isBoundedString(value, 1, 64) && ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value)))
  )
}

function isOptionalEpochMilliseconds(value: unknown): value is number | undefined {
  return value === undefined || isEpochMilliseconds(value)
}

function isPublishedTodo(value: unknown, uid: string): value is PublishedTodo {
  return (
    hasOnlyKeys(value, [
      'uid',
      'summary',
      'description',
      'due',
      'start',
      'completed',
      'completedAt',
      'priority',
      'createdAt',
      'updatedAt',
    ]) &&
    isSafeRecordKey(uid, MAX_UID_LENGTH) &&
    value.uid === uid &&
    isBoundedString(value.summary, 0, MAX_SUMMARY_LENGTH) &&
    isOptionalBoundedString(value.description, MAX_DESCRIPTION_LENGTH) &&
    isOptionalIsoDate(value.due) &&
    isOptionalIsoDate(value.start) &&
    (value.completed === undefined || typeof value.completed === 'boolean') &&
    isOptionalIsoDate(value.completedAt) &&
    (value.priority === undefined ||
      (typeof value.priority === 'number' &&
        Number.isSafeInteger(value.priority) &&
        value.priority >= 0 &&
        value.priority <= 9)) &&
    isOptionalEpochMilliseconds(value.createdAt) &&
    isOptionalEpochMilliseconds(value.updatedAt)
  )
}

function isStoreShape(value: unknown): value is StoreShape {
  if (!isJsonObject(value)) {
    return false
  }
  const users = Object.entries(value)
  return (
    users.length <= MAX_USERS &&
    users.every(([userUuid, todos]) => {
      if (!isSafeRecordKey(userUuid) || !isJsonObject(todos)) {
        return false
      }
      const entries = Object.entries(todos)
      return entries.length <= MAX_TODOS_PER_USER && entries.every(([uid, todo]) => isPublishedTodo(todo, uid))
    })
  )
}

export class PublishedCalendarStore {
  private readonly store: SecureJsonFileStore<StoreShape>

  constructor(filePath: string) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isStoreShape,
    })
  }

  async listForUser(userUuid: string): Promise<PublishedTodo[]> {
    if (!isSafeRecordKey(userUuid)) {
      return []
    }
    const data = await this.read()
    const todos = data[userUuid]
    if (!todos) {
      return []
    }
    return Object.values(todos)
  }

  async getForUser(userUuid: string, uid: string): Promise<PublishedTodo | null> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(uid, MAX_UID_LENGTH)) {
      return null
    }
    const data = await this.read()
    return data[userUuid]?.[uid] ?? null
  }

  /**
   * Upsert a published todo for a user. Used by a (future) publish endpoint.
   * Returns the stored todo with normalized timestamps.
   */
  async publish(userUuid: string, todo: PublishedTodo): Promise<PublishedTodo> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(todo.uid, MAX_UID_LENGTH)) {
      throw new Error('A valid user identifier and todo uid are required to publish a calendar item.')
    }
    const now = Date.now()
    const normalized: PublishedTodo = {
      ...todo,
      createdAt: todo.createdAt ?? now,
      updatedAt: now,
    }
    if (!isPublishedTodo(normalized, todo.uid)) {
      throw new Error('Refusing to publish an invalid calendar item.')
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
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(uid, MAX_UID_LENGTH)) {
      return
    }
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
