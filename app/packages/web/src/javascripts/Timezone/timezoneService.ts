import { WebApplication } from '@/Application/WebApplication'
import {
  TimeZoneSettings,
  getConfiguredTimeZone as getConfiguredTimeZoneFromSettings,
  normalizeTimeZoneSettings,
} from './timezone'

/**
 * Standard Red Notes: Timezone awareness — application-bound side effects.
 *
 * The impure counterpart to `timezone.ts`: reads/writes the preferred-timezone
 * setting from the app storage K/V (via `application.getValue`/`setValue`) under
 * {@link TimeZoneSettingKey}, mirroring the local-store precedent used by Diary
 * mode (no `@standardnotes/models` / `PrefKey` changes).
 */

export const TimeZoneSettingKey = 'PreferredTimeZone'

/**
 * Read the persisted timezone settings (normalized, never throws).
 *
 * `application.getValue` THROWS "Attempting to get storage key … before loading
 * local storage" if called before the app's local data has loaded. This getter
 * defends itself so it can never crash a caller (the clock widget renders after
 * launch, but a read failure of any kind safely falls back to the default
 * "follow the system zone").
 */
export function getTimeZoneSettings(application: WebApplication): TimeZoneSettings {
  try {
    const raw = application.getValue<Partial<TimeZoneSettings> | undefined>(TimeZoneSettingKey)
    return normalizeTimeZoneSettings(raw)
  } catch {
    return normalizeTimeZoneSettings(undefined)
  }
}

/** Persist the timezone settings. */
export function setTimeZoneSettings(application: WebApplication, settings: TimeZoneSettings): void {
  application.setValue(TimeZoneSettingKey, normalizeTimeZoneSettings(settings))
}

/**
 * The user's configured zone resolved to a concrete IANA id (the "follow
 * system" sentinel resolves to the live system zone). This is the app-bound
 * `getConfiguredTimeZone` the clock widget defaults to.
 */
export function getConfiguredTimeZone(application: WebApplication): string {
  return getConfiguredTimeZoneFromSettings(getTimeZoneSettings(application))
}
