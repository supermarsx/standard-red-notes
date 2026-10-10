import { isJsonObject, isSafeRecordKey, SecureJsonFileStore } from '../../Infra/SecureJsonFileStore'
import {
  CalendarProjectionSettings,
  DEFAULT_CALENDAR_PROJECTION,
  normalizeCalendarProjectionSettings,
} from './CalendarProjection'

/**
 * Standard Red Notes: per-user settings for the due-date-to-event projection.
 *
 * WHY A SERVER-SIDE STORE: the CalDAV feed is read with a Basic-auth calendar
 * token and has no session, no settings service and no way to decrypt anything.
 * The projection's shape therefore has to be readable from the token's
 * `userUuid` alone. It is written only through the authenticated management API
 * (`/v1/caldav/projection`), so the session is what proves ownership.
 *
 * Putting it here rather than in the client also means every axis changes the
 * SERVED FEED for records already in the store: a user flipping "all-day" does
 * not have to republish anything, and a polling client notices because the
 * strong ETag is computed over the serialization.
 *
 * STORAGE: the same single-JSON-file idiom and shared secure-file primitive as
 * `PublishedCalendarStore`, which bounds and validates reads, rejects unsafe
 * link/type targets, and serializes durable atomic writes.
 */

interface StoreShape {
  // userUuid -> settings
  [userUuid: string]: CalendarProjectionSettings
}

const MAX_USERS = 10_000

/**
 * The file is validated only STRUCTURALLY here — a map of safe user keys to
 * objects. Field-level coercion is `normalizeCalendarProjectionSettings`'s job
 * and happens on read, so a settings file written by an older build (one field
 * short, or one field ahead) keeps working instead of failing validation and
 * reverting every user to defaults at once.
 */
function isStoreShape(value: unknown): value is StoreShape {
  if (!isJsonObject(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_USERS &&
    entries.every(([userUuid, settings]) => isSafeRecordKey(userUuid) && isJsonObject(settings))
  )
}

export class CalendarProjectionStore {
  private readonly store: SecureJsonFileStore<StoreShape>

  constructor(filePath: string) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isStoreShape,
    })
  }

  /**
   * The user's settings, or the defaults.
   *
   * Never throws and never returns a partial set: a caller must be able to read
   * `settings.enabled` without a guard, and the defaults are OFF, so an
   * unreadable store fails CLOSED — no events rather than events nobody asked
   * for.
   */
  async getForUser(userUuid: string): Promise<CalendarProjectionSettings> {
    if (!isSafeRecordKey(userUuid)) {
      return { ...DEFAULT_CALENDAR_PROJECTION }
    }
    let data: StoreShape = {}
    try {
      data = (await this.store.read()) ?? {}
    } catch {
      // The DAV router calls this on EVERY request that touches the events
      // collection, so a read that throws would turn an unreadable settings
      // file into a 500 on a feature that is otherwise working. The defaults
      // are OFF, so failing closed here means "no events" — which empties the
      // user's projected calendar and is therefore visible to them, rather
      // than silent. The write path still surfaces its errors.
      return { ...DEFAULT_CALENDAR_PROJECTION }
    }
    return normalizeCalendarProjectionSettings(data[userUuid])
  }

  /**
   * Replace the user's settings with the normalized form of `settings` and
   * return what was actually stored, so the caller echoes the effective values
   * rather than the submitted ones.
   */
  async setForUser(userUuid: string, settings: unknown): Promise<CalendarProjectionSettings> {
    const normalized = normalizeCalendarProjectionSettings(settings)
    if (!isSafeRecordKey(userUuid)) {
      return normalized
    }
    await this.store.update((current) => {
      const data = current ?? {}
      data[userUuid] = normalized
      return data
    })
    return normalized
  }

  /** Forget a user's settings, reverting them to the OFF defaults. */
  async resetForUser(userUuid: string): Promise<boolean> {
    if (!isSafeRecordKey(userUuid)) {
      return false
    }
    let removed = false
    await this.store.update((current) => {
      const data = current ?? {}
      if (data[userUuid] !== undefined) {
        delete data[userUuid]
        removed = true
      }
      return data
    })
    return removed
  }
}
