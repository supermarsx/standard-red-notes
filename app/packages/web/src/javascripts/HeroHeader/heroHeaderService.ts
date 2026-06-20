import {
  HERO_TARGET_WIDTH,
  MAX_HERO_DATA_URL_LENGTH,
  normalizeHeroImageDataUrl,
  validateHeroSourceFile,
} from './heroHeader'

/**
 * Standard Red Notes: hero header (cover image) — DOM/canvas side effects.
 *
 * This is the impure counterpart to `heroHeader.ts`: it turns a picked image file
 * into a small, banner-shaped, JPEG-compressed data URL suitable for storing
 * inline in the note's synced+E2E appData. It mirrors the avatar pipeline
 * (`avatarService.ts`) but downsizes to a banner WIDTH (keeping aspect ratio)
 * rather than cropping to a square.
 *
 * The bounded data URL it produces is then persisted by the NotesController into
 * the note's appData — see heroHeader.ts for the E2E/appData-bloat tradeoff.
 */

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
 * Draw `image` scaled (preserving aspect ratio) so its width is at most
 * `targetWidth`, returning a compressed JPEG data URL at `quality`. We never
 * upscale (small sources stay their natural size).
 */
function drawToBannerDataUrl(image: HTMLImageElement, targetWidth: number, quality: number): string {
  const naturalWidth = image.naturalWidth || image.width
  const naturalHeight = image.naturalHeight || image.height
  if (!naturalWidth || !naturalHeight) {
    throw new Error('The selected image has no dimensions.')
  }

  const scale = Math.min(1, targetWidth / naturalWidth)
  const width = Math.max(1, Math.round(naturalWidth * scale))
  const height = Math.max(1, Math.round(naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not process the image on this device.')
  }

  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * Full picker pipeline for a chosen cover file: validate type/size, decode, scale
 * to a banner width, JPEG-compress, and validate the resulting size. If the first
 * pass is still over the synced-appData bound we retry at progressively lower
 * quality before giving up with a friendly error.
 *
 * Resolves with the bounded data URL (the caller persists it into the note's
 * appData). Rejects with a user-facing Error on invalid input / processing
 * failure / an image that won't fit under the bound.
 */
export async function processCoverImageFile(file: File): Promise<string> {
  const validationError = validateHeroSourceFile(file)
  if (validationError) {
    throw new Error(validationError)
  }

  const image = await loadImageFromFile(file)

  // Try decreasing quality (and finally a narrower width) so a busy photo still
  // fits under the appData bound without forcing the user to pre-resize.
  const attempts: { width: number; quality: number }[] = [
    { width: HERO_TARGET_WIDTH, quality: 0.72 },
    { width: HERO_TARGET_WIDTH, quality: 0.6 },
    { width: HERO_TARGET_WIDTH, quality: 0.45 },
    { width: 1200, quality: 0.45 },
  ]

  for (const attempt of attempts) {
    const dataUrl = drawToBannerDataUrl(image, attempt.width, attempt.quality)
    const normalized = normalizeHeroImageDataUrl(dataUrl)
    if (normalized && normalized.length <= MAX_HERO_DATA_URL_LENGTH) {
      return normalized
    }
  }

  throw new Error('This image is too detailed to store as a cover. Please try a smaller or simpler image.')
}
