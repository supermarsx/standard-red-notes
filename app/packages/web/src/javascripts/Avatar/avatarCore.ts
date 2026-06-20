/**
 * Standard Red Notes: Profile picture (avatar) — pure, dependency-free core.
 *
 * The avatar feature lets a user pick a profile picture that is shown wherever
 * the account is represented (the footer account-menu button and the Account
 * preferences pane). When none is set we fall back to the user's initials, and
 * then to the existing account icon.
 *
 * This module holds ONLY the pure logic so it can be unit-tested without a DOM
 * or a running application:
 *
 *  - validating/normalizing a stored avatar data URL into a bounded value,
 *  - deriving display initials from an email/name, and
 *  - the constants (max bytes, target square size) the picker enforces.
 *
 * Where the avatar lives (web-only, no `@standardnotes/models` changes):
 *  - The data URL is stored via the app's storage K/V
 *    (`application.getValue`/`setValue`) under a local key — the same local-store
 *    precedent used by the diary / email-backup / app-lock-passkey features,
 *    which deliberately avoided adding keys to the published `PrefKey` enum.
 *  - It is therefore stored on THIS DEVICE ONLY and is NOT synced across devices.
 *    See avatarService.ts.
 */

/** Storage key for the locally-stored avatar data URL (this device only). */
export const AvatarStorageKey = 'ProfileAvatar'

/**
 * Edge length (px) of the square the picker downsizes the picked image to.
 * Small on purpose so the resulting data URL stays a few KB.
 */
export const AVATAR_SIZE = 128

/**
 * Upper bound (bytes) on the SOURCE file the picker will accept before it ever
 * touches the DOM. Generous enough for any reasonable photo, small enough to
 * reject pathological inputs gracefully.
 */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024 // 10 MB

/**
 * Upper bound (chars) on the RESULT data URL we persist. After resize+compress a
 * 128px JPEG is typically a few KB; this is a safety net so a stored value can
 * never bloat local storage.
 */
export const MAX_STORED_DATA_URL_LENGTH = 200 * 1024 // ~200 KB of base64

/** Image MIME types the picker accepts as a source. */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** True if `type` is an image MIME type the picker accepts. */
export function isAcceptedImageType(type: string | undefined | null): boolean {
  return typeof type === 'string' && (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type)
}

/**
 * Validate a picked source file's type/size BEFORE doing any DOM work. Returns
 * an error string to surface to the user, or null when the file is acceptable.
 */
export function validateSourceFile(file: { type?: string; size?: number } | null | undefined): string | null {
  if (!file) {
    return 'No file selected.'
  }
  if (!isAcceptedImageType(file.type)) {
    return 'Please choose a PNG, JPEG, WebP, or GIF image.'
  }
  if (typeof file.size === 'number' && file.size > MAX_SOURCE_BYTES) {
    return 'Image is too large. Please choose a file under 10 MB.'
  }
  return null
}

/**
 * Coerce any stored value into a usable avatar data URL, or null. Never throws.
 * Rejects non-strings, anything that isn't an image data URL, and values past
 * {@link MAX_STORED_DATA_URL_LENGTH} (corrupt/oversized storage).
 */
export function normalizeStoredAvatar(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_STORED_DATA_URL_LENGTH) {
    return null
  }
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return null
  }
  return trimmed
}

/**
 * Derive up-to-two-character display initials from an email address (or a free
 * text name). Falls back to '?' when nothing usable is present.
 *
 *  - "ada.lovelace@example.com"      -> "AL"
 *  - "ada_lovelace@example.com"      -> "AL"
 *  - "ada@example.com"               -> "A"
 *  - "Ada Lovelace"                  -> "AL"
 *  - ""                              -> "?"
 */
export function initialsForUser(emailOrName: string | undefined | null): string {
  if (typeof emailOrName !== 'string') {
    return '?'
  }
  const trimmed = emailOrName.trim()
  if (trimmed.length === 0) {
    return '?'
  }
  // Use the local part for emails; the whole string otherwise.
  const local = trimmed.includes('@') ? trimmed.slice(0, trimmed.indexOf('@')) : trimmed
  // Split on common name separators (space, dot, underscore, hyphen, plus).
  const parts = local.split(/[\s._+-]+/).filter((part) => part.length > 0)
  if (parts.length === 0) {
    return '?'
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 1).toUpperCase()
  }
  return (parts[0].slice(0, 1) + parts[parts.length - 1].slice(0, 1)).toUpperCase()
}
