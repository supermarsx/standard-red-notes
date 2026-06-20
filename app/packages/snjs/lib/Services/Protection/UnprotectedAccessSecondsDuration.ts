export enum UnprotectedAccessSecondsDuration {
  OneMinute = 60,
  FiveMinutes = 300,
  OneHour = 3600,
}

/**
 * The longest a protection (unprotected-access) session may last. Protected
 * content must never remain viewable longer than this without re-challenging.
 * This is intentionally short-lived and well below an app-restart horizon so
 * that a protected note cannot be read after the device has been rebooted
 * (see forum issue #4063). Any persisted expiry beyond this is clamped.
 */
export const MaxUnprotectedAccessSecondsDuration = UnprotectedAccessSecondsDuration.OneHour
