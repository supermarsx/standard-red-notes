/**
 * Standard Red Notes: web-local persistence for the "Strip image metadata on
 * upload" privacy toggle.
 *
 * This is intentionally NOT a synced preference. The app's synced/local PrefKeys
 * live in @standardnotes/snjs (models/services), which are off limits for the
 * web-only workstream (changing them needs build:snjs). So we persist the toggle
 * directly in localStorage, mirroring the autoMove/conflict-AI local-pref
 * precedent already in the web client.
 *
 * Default is ON: with no stored value we strip EXIF/GPS/metadata from images
 * before upload, because leaking location/camera data is a privacy footgun and
 * we want safe-by-default behavior. The user can opt out to upload originals.
 */
const STORAGE_KEY = 'sn_strip_image_metadata_on_upload'
const CHANGE_EVENT = 'sn-strip-image-metadata-changed'

export const getStripImageMetadataEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    // Default ON: only an explicit 'false' disables it.
    return raw !== 'false'
  } catch {
    // localStorage unavailable (e.g. private mode) -> fail to the default (on).
    return true
  }
}

export const setStripImageMetadataEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // No-op; the toggle simply won't persist across reloads.
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    // Ignore (non-DOM environments).
  }
}

/**
 * Subscribe to changes to the toggle (same-tab via CustomEvent, cross-tab via
 * the storage event). Returns an unsubscribe function.
 */
export const subscribeStripImageMetadata = (callback: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      callback()
    }
  }
  window.addEventListener(CHANGE_EVENT, callback)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback)
    window.removeEventListener('storage', onStorage)
  }
}
