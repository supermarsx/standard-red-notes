import { WebApplication } from '@/Application/WebApplication'
import {
  AVATAR_SIZE,
  AvatarStorageKey,
  MAX_STORED_DATA_URL_LENGTH,
  normalizeStoredAvatar,
  validateSourceFile,
} from './avatarCore'

/**
 * Standard Red Notes: Profile picture (avatar) — application-bound side effects.
 *
 * This module is the impure counterpart to `avatar.ts`: it reads/writes the
 * avatar data URL in the app storage K/V and does the DOM/canvas work of turning
 * a picked image file into a small, square, compressed data URL.
 *
 * Storage choice (web-only, no `@standardnotes/models` changes): the data URL is
 * stored via `application.getValue`/`setValue` under {@link AvatarStorageKey} —
 * the same local-store precedent used by the diary / app-lock-passkey features.
 * It is therefore on THIS DEVICE ONLY and is NOT synced across devices.
 *
 * Live updates: storage K/V doesn't emit change events the UI can subscribe to,
 * so whenever the avatar is set/removed we dispatch a window event
 * ({@link AvatarChangedEvent}) that the reusable Avatar component listens to, so
 * the footer account-menu button updates the moment the photo changes.
 */

/** Window event dispatched whenever the stored avatar changes (set or removed). */
export const AvatarChangedEvent = 'standard-red-notes:avatar-changed'

/** Read the persisted avatar data URL (validated), or null. Never throws. */
export function getStoredAvatar(application: WebApplication): string | null {
  try {
    const raw = application.getValue<unknown>(AvatarStorageKey)
    return normalizeStoredAvatar(raw)
  } catch {
    return null
  }
}

/** Notify listeners (the Avatar component) that the stored avatar changed. */
function notifyAvatarChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(AvatarChangedEvent))
  } catch {
    // No window (tests/SSR) — listeners simply won't be notified.
  }
}

/** Persist a (already normalized) avatar data URL and notify listeners. */
export function setStoredAvatar(application: WebApplication, dataUrl: string): void {
  application.setValue(AvatarStorageKey, dataUrl)
  notifyAvatarChanged()
}

/** Remove the stored avatar (fall back to initials/icon) and notify listeners. */
export function removeStoredAvatar(application: WebApplication): void {
  application.setValue(AvatarStorageKey, undefined)
  notifyAvatarChanged()
}

/**
 * Decode a File into an HTMLImageElement via an object URL, revoking it after.
 * Rejects if the image can't be decoded.
 */
function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read the selected image.'))
    }
    image.src = url
  })
}

/**
 * Draw `image` center-cropped to a square and scaled to {@link AVATAR_SIZE},
 * returning a compressed JPEG data URL. Center-crop keeps faces centered for
 * non-square inputs; JPEG at 0.8 keeps a 128px avatar to a few KB.
 */
function drawToSquareDataUrl(image: HTMLImageElement, size: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not process the image on this device.')
  }

  const sourceSize = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height)
  const sourceX = ((image.naturalWidth || image.width) - sourceSize) / 2
  const sourceY = ((image.naturalHeight || image.height) - sourceSize) / 2

  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size)
  return canvas.toDataURL('image/jpeg', 0.8)
}

/**
 * Full picker pipeline for a chosen file: validate type/size, decode, center-crop
 * to a square, scale to {@link AVATAR_SIZE}, compress to JPEG, validate the
 * resulting size, persist locally, and notify listeners.
 *
 * Resolves with the stored data URL. Rejects with a user-facing Error on invalid
 * input or a processing failure (the caller surfaces the message).
 */
export async function processAndStoreAvatar(application: WebApplication, file: File): Promise<string> {
  const validationError = validateSourceFile(file)
  if (validationError) {
    throw new Error(validationError)
  }

  const image = await loadImageFromFile(file)
  const dataUrl = drawToSquareDataUrl(image, AVATAR_SIZE)

  const normalized = normalizeStoredAvatar(dataUrl)
  if (!normalized) {
    throw new Error('The processed image was invalid. Please try a different photo.')
  }
  if (normalized.length > MAX_STORED_DATA_URL_LENGTH) {
    throw new Error('The processed image was too large. Please try a different photo.')
  }

  setStoredAvatar(application, normalized)
  return normalized
}
