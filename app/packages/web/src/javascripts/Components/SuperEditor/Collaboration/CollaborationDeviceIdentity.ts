let cachedDeviceId: string | undefined
const STORAGE_KEY = 'standardnotes.collaboration-device-id.v1'
const VALID_ID = /^[a-zA-Z0-9._:-]{1,128}$/

/** A browser profile identity for presence counts only; never an authorization credential. */
export function collaborationDeviceId(): string | undefined {
  if (cachedDeviceId) {
    return cachedDeviceId
  }
  try {
    const stored = globalThis.localStorage.getItem(STORAGE_KEY)
    if (stored && VALID_ID.test(stored)) {
      return (cachedDeviceId = stored)
    }
  } catch {
    // Without shared storage, tabs cannot be identified as the same device.
    return undefined
  }
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    return undefined
  }
  cachedDeviceId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, cachedDeviceId)
  } catch {
    cachedDeviceId = undefined
    return undefined
  }
  return cachedDeviceId
}
