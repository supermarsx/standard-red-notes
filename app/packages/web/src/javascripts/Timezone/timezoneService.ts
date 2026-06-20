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

/** Read the persisted timezone settings (normalized, never throws). */
export function getTimeZoneSettings(application: WebApplication): TimeZoneSettings {
  const raw = application.getValue<Partial<TimeZoneSettings> | undefined>(TimeZoneSettingKey)
  return normalizeTimeZoneSettings(raw)
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
