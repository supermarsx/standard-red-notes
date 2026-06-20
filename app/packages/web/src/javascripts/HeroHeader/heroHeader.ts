import { AppDataField, SNNote } from '@standardnotes/snjs'

/**
 * Standard Red Notes: per-note hero header (Notion-style cover banner).
 *
 * A note can carry a full-width cover image rendered above the editor. The
 * config lives in the note's encrypted `appData` bag — the exact mechanism used
 * for `pinned`, `archived`, `locked`, our per-note appearance colors, and
 * reminders. We persist a single key (`heroHeader`) under the default app domain
 * via `setAppDataItem`/`getAppDomainValue`.
 *
 * ## Why appData (mirroring reminders/appearance)
 *  - It syncs end-to-end with the note (cover set on one device shows on every
 *    device).
 *  - It is tied to the note's lifecycle (delete the note, the cover goes too).
 *  - It needs ZERO models/server changes: `heroHeader` is not in the published
 *    `AppDataField` enum (which lives in the models package we must not touch),
 *    so we cast our string key to `AppDataField` at the storage boundary, exactly
 *    like the appearance/reminder helpers do — `setAppDataItem`/`getAppDomainValue`
 *    accept any string key.
 *
 * ## E2E / appData-bloat tradeoff (IMPORTANT)
 * The cover image is stored INLINE as a bounded JPEG data URL inside the note's
 * appData. Because appData syncs and is end-to-end encrypted, the image bytes are
 * encrypted and uploaded with every note revision — a large image would bloat the
 * note payload and slow sync. To keep this safe we:
 *  - resize the source down to a banner width (~1600px) and JPEG-compress it
 *    (see heroHeaderService.ts), and
 *  - HARD-REJECT any stored data URL over {@link MAX_HERO_DATA_URL_LENGTH}
 *    (~500KB) with a friendly error.
 * For a truly large/lossless cover a future version could store a reference to an
 * attached file UUID instead; the bounded data URL is the simplest correct
 * approach and is what we ship.
 */

export const NoteHeroHeaderKey = 'heroHeader' as unknown as AppDataField

/** Default banner height (px) when the note doesn't specify one. */
export const HERO_DEFAULT_HEIGHT = 200

/** Allowed banner height range (px) for the adjustable-height control. */
export const HERO_MIN_HEIGHT = 100
export const HERO_MAX_HEIGHT = 480

/** Target max width (px) the picker downsizes a cover to before compressing. */
export const HERO_TARGET_WIDTH = 1600

/**
 * Upper bound (bytes) on the SOURCE file the picker accepts before any DOM work.
 * Generous for a real photo, small enough to reject pathological inputs early.
 */
export const MAX_HERO_SOURCE_BYTES = 15 * 1024 * 1024 // 15 MB

/**
 * Upper bound (chars) on the RESULT data URL we persist into synced+E2E appData.
 * A 1600px-wide JPEG at ~0.72 quality is typically well under this; the cap is the
 * safety net that keeps a cover from bloating the synced note payload (~500KB).
 */
export const MAX_HERO_DATA_URL_LENGTH = 500 * 1024 // ~500 KB of base64

/** Image MIME types the cover picker accepts as a source. */
export const ACCEPTED_HERO_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** The stored hero-header configuration (all fields optional/bounded). */
export type HeroHeader = {
  /** Bounded, compressed cover image as a data URL. Absent = no cover. */
  imageDataUrl?: string
  /** Banner height in px (clamped to [HERO_MIN_HEIGHT, HERO_MAX_HEIGHT]). */
  height?: number
  /** Vertical focal point as a 0..1 fraction (object-position Y). 0 = top. */
  focalY?: number
}

/** True if `type` is an image MIME type the cover picker accepts. */
export function isAcceptedHeroImageType(type: string | undefined | null): boolean {
  return typeof type === 'string' && (ACCEPTED_HERO_IMAGE_TYPES as readonly string[]).includes(type)
}

/**
 * Validate a picked source file's type/size BEFORE any DOM work. Returns an error
 * string to surface to the user, or null when the file is acceptable.
 */
export function validateHeroSourceFile(
  file: { type?: string; size?: number } | null | undefined,
): string | null {
  if (!file) {
    return 'No file selected.'
  }
  if (!isAcceptedHeroImageType(file.type)) {
    return 'Please choose a PNG, JPEG, WebP, or GIF image.'
  }
  if (typeof file.size === 'number' && file.size > MAX_HERO_SOURCE_BYTES) {
    return 'Image is too large. Please choose a file under 15 MB.'
  }
  return null
}

/**
 * Coerce a stored cover data URL into a usable value, or null. Never throws.
 * Rejects non-strings, anything that isn't an image data URL, and values past
 * {@link MAX_HERO_DATA_URL_LENGTH} (the synced-appData bloat guard).
 */
export function normalizeHeroImageDataUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_HERO_DATA_URL_LENGTH) {
    return null
  }
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return null
  }
  return trimmed
}

/** Clamp a height into the allowed banner range, defaulting bad input. */
export function clampHeroHeight(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return HERO_DEFAULT_HEIGHT
  }
  return Math.min(HERO_MAX_HEIGHT, Math.max(HERO_MIN_HEIGHT, Math.round(num)))
}

/** Clamp a focal point into [0, 1], defaulting bad/missing input to 0.5 (center). */
export function clampHeroFocalY(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return 0.5
  }
  return Math.min(1, Math.max(0, num))
}

/**
 * Standard Red Notes: coerce any stored/partial/legacy hero-header value into a
 * sane config, or null when there is no usable cover. NEVER throws — old notes
 * (no heroHeader) and malformed data normalize to null (= current behavior, no
 * banner). A value with no valid image is treated as "no cover" even if it
 * carries height/focal data.
 */
export function normalizeHeroHeader(value: unknown): HeroHeader | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const imageDataUrl = normalizeHeroImageDataUrl(candidate.imageDataUrl)
  if (!imageDataUrl) {
    return null
  }
  return {
    imageDataUrl,
    height: clampHeroHeight(candidate.height),
    focalY: clampHeroFocalY(candidate.focalY),
  }
}

/** Read the (normalized) hero header stored on a note, or null. Never throws. */
export function getNoteHeroHeader(note: SNNote): HeroHeader | null {
  const raw = note.getAppDomainValue<unknown>(NoteHeroHeaderKey)
  return normalizeHeroHeader(raw)
}

/** True if the note has a usable cover image. */
export function noteHasHeroHeader(note: SNNote): boolean {
  return getNoteHeroHeader(note) !== null
}
