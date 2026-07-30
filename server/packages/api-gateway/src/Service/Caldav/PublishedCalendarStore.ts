import {
  hasOnlyKeys,
  isBoundedString,
  isEpochMilliseconds,
  isJsonObject,
  isSafeRecordKey,
  SecureJsonFileStore,
} from '../../Infra/SecureJsonFileStore'
import { CaldavInputError } from './CaldavInputError'
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
 * The authenticated CalDAV management API and Security preferences UI populate
 * this store. Users can list, edit, and unpublish the retained plaintext fields.
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
const DATE_PATTERN = /^\d{4}-(\d{2})-(\d{2})$/
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const ILLEGAL_CALENDAR_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export interface PublishedCalendarStoreOptions {
  clock?: () => number
  maxTodosPerUser?: number
}

function isOptionalIsoDate(value: unknown): value is string | undefined {
  return value === undefined || isCalendarDate(value)
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
    isNonBlankCalendarText(value.summary, MAX_SUMMARY_LENGTH) &&
    (value.description === undefined || isBoundedCalendarText(value.description, 0, MAX_DESCRIPTION_LENGTH)) &&
    isOptionalIsoDate(value.due) &&
    isOptionalIsoDate(value.start) &&
    (value.completed === undefined || typeof value.completed === 'boolean') &&
    (value.completedAt === undefined || isCalendarDateTime(value.completedAt)) &&
    (value.priority === undefined ||
      (typeof value.priority === 'number' &&
        Number.isSafeInteger(value.priority) &&
        value.priority >= 0 &&
        value.priority <= 9)) &&
    isOptionalEpochMilliseconds(value.createdAt) &&
    isOptionalEpochMilliseconds(value.updatedAt)
  )
}

function isBoundedCalendarText(value: unknown, minimumLength: number, maximumLength: number): value is string {
  return isBoundedString(value, minimumLength, maximumLength) && !ILLEGAL_CALENDAR_TEXT.test(value)
}

function isNonBlankCalendarText(value: unknown, maximumLength: number): value is string {
  return isBoundedCalendarText(value, 1, maximumLength) && value.trim().length > 0
}

function hasValidDateParts(year: string, month: string, day: string): boolean {
  const numericYear = Number(year)
  const numericMonth = Number(month)
  const numericDay = Number(day)
  const leapYear = numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return numericMonth >= 1 && numericMonth <= 12 && numericDay >= 1 && numericDay <= daysInMonth[numericMonth - 1]
}

function isCalendarDateTime(value: unknown): value is string {
  if (!isBoundedString(value, 1, 64)) {
    return false
  }
  const match = DATE_TIME_PATTERN.exec(value)
  return match !== null && hasValidDateParts(match[1], match[2], match[3]) && !Number.isNaN(Date.parse(value))
}

function isCalendarDate(value: unknown): value is string {
  if (!isBoundedString(value, 1, 64)) {
    return false
  }
  const dateMatch = DATE_PATTERN.exec(value)
  if (dateMatch) {
    return hasValidDateParts(value.slice(0, 4), dateMatch[1], dateMatch[2])
  }
  return isCalendarDateTime(value)
}

function hasValidTemporalSemantics(todo: PublishedTodo): boolean {
  if (todo.completedAt !== undefined && todo.completed !== true) {
    return false
  }
  if (todo.start === undefined || todo.due === undefined) {
    return true
  }
  const startIsDate = DATE_PATTERN.test(todo.start)
  const dueIsDate = DATE_PATTERN.test(todo.due)
  return startIsDate === dueIsDate && Date.parse(todo.due) > Date.parse(todo.start)
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
      return (
        entries.length <= MAX_TODOS_PER_USER &&
        entries.every(([uid, todo]) => isPublishedTodo(todo, uid) && hasValidTemporalSemantics(todo))
      )
    })
  )
}

export class PublishedCalendarStore {
  private readonly store: SecureJsonFileStore<StoreShape>
  private readonly clock: () => number
  private readonly maxTodosPerUser: number

  constructor(filePath: string, options: PublishedCalendarStoreOptions = {}) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isStoreShape,
    })
    this.clock = options.clock ?? Date.now
    this.maxTodosPerUser = options.maxTodosPerUser ?? MAX_TODOS_PER_USER
    if (
      !Number.isSafeInteger(this.maxTodosPerUser) ||
      this.maxTodosPerUser <= 0 ||
      this.maxTodosPerUser > MAX_TODOS_PER_USER
    ) {
      throw new Error(`maxTodosPerUser must be an integer between 1 and ${MAX_TODOS_PER_USER}.`)
    }
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
    return Object.values(todos).sort((left, right) => left.uid.localeCompare(right.uid))
  }

  async getForUser(userUuid: string, uid: string): Promise<PublishedTodo | null> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(uid, MAX_UID_LENGTH)) {
      return null
    }
    const data = await this.read()
    return data[userUuid]?.[uid] ?? null
  }

  /**
   * Upsert a published todo for a user through the authenticated management API.
   * Returns the stored todo with normalized timestamps.
   */
  async publish(userUuid: string, todo: PublishedTodo): Promise<PublishedTodo> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(todo.uid, MAX_UID_LENGTH)) {
      throw new CaldavInputError('A valid user identifier and todo uid are required to publish a calendar item.')
    }
    if (!isPublishedTodo(todo, todo.uid) || !hasValidTemporalSemantics(todo)) {
      throw new CaldavInputError('Refusing to publish an invalid calendar item.')
    }

    let stored: PublishedTodo | undefined
    await this.mutate((data) => {
      const forUser = data[userUuid] ?? {}
      const existing = forUser[todo.uid]
      if (!existing && Object.keys(forUser).length >= this.maxTodosPerUser) {
        throw new CaldavInputError(`A user may not publish more than ${this.maxTodosPerUser} calendar items.`)
      }
      const now = this.clock()
      const updatedAt = Math.max(now, (existing?.updatedAt ?? -1) + 1)
      stored = {
        uid: todo.uid,
        summary: todo.summary,
        ...(todo.description !== undefined ? { description: todo.description } : {}),
        ...(todo.due !== undefined ? { due: todo.due } : {}),
        ...(todo.start !== undefined ? { start: todo.start } : {}),
        ...(todo.completed !== undefined ? { completed: todo.completed } : {}),
        ...(todo.completedAt !== undefined ? { completedAt: todo.completedAt } : {}),
        ...(todo.priority !== undefined ? { priority: todo.priority } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt,
      }
      forUser[todo.uid] = stored
      data[userUuid] = forUser
    })
    return stored as PublishedTodo
  }

  /** Remove a single published todo. No-op if absent. */
  async unpublish(userUuid: string, uid: string): Promise<boolean> {
    if (!isSafeRecordKey(userUuid) || !isSafeRecordKey(uid, MAX_UID_LENGTH)) {
      return false
    }
    let removed = false
    await this.mutate((data) => {
      if (data[userUuid]?.[uid]) {
        delete data[userUuid][uid]
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
