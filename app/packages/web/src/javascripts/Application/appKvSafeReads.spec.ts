import { WebApplication } from '@/Application/WebApplication'
import { getDiarySettings } from '@/Diary/diaryService'
import { DEFAULT_DIARY_SETTINGS } from '@/Diary/diary'
import { getStoredAvatar } from '@/Avatar/avatarService'
import { getTimeZoneSettings } from '@/Timezone/timezoneService'
import { DEFAULT_TIMEZONE_SETTINGS } from '@/Timezone/timezone'
import { getAppLockPasskeyCredential, isAppLockPasskeyRegistered } from '@/AppLockPasskey/appLockPasskeyService'

/**
 * Standard Red Notes: SAFE-READ guarantees for every fork app-KV getter.
 *
 * The root cause this audit targets: `application.getValue` THROWS
 *   "Attempting to get storage key <X> before loading local storage."
 * when called before the app's local data has loaded (e.g. during launch). A
 * getter that lets that throw propagate crashes the React render (the diary boot
 * crash). Every fork getter that reads app-KV must therefore NEVER throw — on the
 * early-load error, on undefined/null, or on malformed junk — and must return its
 * documented default instead.
 *
 * Each getter is exercised against all three hostile inputs below.
 */

const EARLY_LOAD_ERROR = (key: string) =>
  new Error(`Attempting to get storage key ${key} before loading local storage.`)

/** Build a fake application whose `getValue` behaves per the scenario. */
const appThatThrowsOnGet = (key: string): WebApplication =>
  ({
    getValue: () => {
      throw EARLY_LOAD_ERROR(key)
    },
  }) as unknown as WebApplication

const appReturning = (value: unknown): WebApplication =>
  ({
    getValue: () => value,
  }) as unknown as WebApplication

const JUNK_VALUES: unknown[] = [
  undefined,
  null,
  42,
  'a string',
  true,
  [],
  { unexpected: 'shape' },
  { enabled: 'yes', hour: 999, minute: -7 },
  NaN,
]

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('getDiarySettings — never throws, returns defaults', () => {
  it('returns the default settings when the store throws the early-load error', () => {
    const application = appThatThrowsOnGet('DiaryMode')
    expect(() => getDiarySettings(application)).not.toThrow()
    expect(getDiarySettings(application)).toEqual(DEFAULT_DIARY_SETTINGS)
  })

  it('returns defaults for undefined/null', () => {
    expect(getDiarySettings(appReturning(undefined))).toEqual(DEFAULT_DIARY_SETTINGS)
    expect(getDiarySettings(appReturning(null))).toEqual(DEFAULT_DIARY_SETTINGS)
  })

  it('normalizes any malformed junk without throwing', () => {
    for (const junk of JUNK_VALUES) {
      expect(() => getDiarySettings(appReturning(junk))).not.toThrow()
      const result = getDiarySettings(appReturning(junk))
      expect(typeof result.enabled).toBe('boolean')
      expect(result.hour).toBeGreaterThanOrEqual(0)
      expect(result.hour).toBeLessThanOrEqual(23)
      expect(result.minute).toBeGreaterThanOrEqual(0)
      expect(result.minute).toBeLessThanOrEqual(59)
    }
  })
})

describe('getTimeZoneSettings — never throws, returns defaults', () => {
  it('returns the default settings when the store throws the early-load error', () => {
    const application = appThatThrowsOnGet('PreferredTimeZone')
    expect(() => getTimeZoneSettings(application)).not.toThrow()
    expect(getTimeZoneSettings(application)).toEqual(DEFAULT_TIMEZONE_SETTINGS)
  })

  it('returns defaults for undefined/null', () => {
    expect(getTimeZoneSettings(appReturning(undefined))).toEqual(DEFAULT_TIMEZONE_SETTINGS)
    expect(getTimeZoneSettings(appReturning(null))).toEqual(DEFAULT_TIMEZONE_SETTINGS)
  })

  it('normalizes any malformed junk to a string timeZone without throwing', () => {
    for (const junk of JUNK_VALUES) {
      expect(() => getTimeZoneSettings(appReturning(junk))).not.toThrow()
      expect(typeof getTimeZoneSettings(appReturning(junk)).timeZone).toBe('string')
    }
  })
})

describe('getStoredAvatar — never throws, returns null on failure', () => {
  it('returns null when the store throws the early-load error', () => {
    const application = appThatThrowsOnGet('ProfileAvatar')
    expect(() => getStoredAvatar(application)).not.toThrow()
    expect(getStoredAvatar(application)).toBeNull()
  })

  it('returns null for undefined/null', () => {
    expect(getStoredAvatar(appReturning(undefined))).toBeNull()
    expect(getStoredAvatar(appReturning(null))).toBeNull()
  })

  it('returns null for malformed junk (non data-url values)', () => {
    for (const junk of JUNK_VALUES) {
      expect(() => getStoredAvatar(appReturning(junk))).not.toThrow()
      expect(getStoredAvatar(appReturning(junk))).toBeNull()
    }
  })
})

describe('getAppLockPasskeyCredential / isAppLockPasskeyRegistered — never throw', () => {
  it('return null/false when the store throws the early-load error', () => {
    const application = appThatThrowsOnGet('AppLockPasskey')
    expect(() => getAppLockPasskeyCredential(application)).not.toThrow()
    expect(() => isAppLockPasskeyRegistered(application)).not.toThrow()
    expect(getAppLockPasskeyCredential(application)).toBeNull()
    expect(isAppLockPasskeyRegistered(application)).toBe(false)
  })

  it('return null/false for undefined/null', () => {
    expect(getAppLockPasskeyCredential(appReturning(undefined))).toBeNull()
    expect(isAppLockPasskeyRegistered(appReturning(null))).toBe(false)
  })

  it('return null/false for malformed junk', () => {
    for (const junk of JUNK_VALUES) {
      expect(() => getAppLockPasskeyCredential(appReturning(junk))).not.toThrow()
      expect(getAppLockPasskeyCredential(appReturning(junk))).toBeNull()
      expect(isAppLockPasskeyRegistered(appReturning(junk))).toBe(false)
    }
  })
})
